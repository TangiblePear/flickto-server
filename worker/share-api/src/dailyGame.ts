/**
 * One Take — the daily film puzzle: submission, friends, leaderboard, distribution.
 *
 * ## The server derives the score. It never takes one.
 *
 * A client posts the GUESS LIST, not a result. This worker reads the day's archived
 * answer out of R2 — a key no client can fetch, because the Pages function routes
 * `content/*` and nothing else — checks the final guess really is the answer, and derives
 * the guess count and the score itself. That is the difference between rows worth ranking
 * and rows that would have to be thrown away the first time anyone checked.
 *
 * One array shape serves both today's submission and the sign-in backfill, so there is no
 * second endpoint and no second trust model: a player who spent a fortnight signed out
 * gets each of those days verified against its own archived answer on the way in.
 *
 * ## What this deliberately does NOT defend against
 *
 * Someone who digs the obfuscation key out of a client can read today's answer and post
 * it as guess #1. That is unfixable while the client grades offline, and it is why
 * ranking is FRIENDS ONLY — forging there moves you up a list of people who know you, so
 * the incentive never really appears. A global leaderboard would supply that incentive
 * and would need server-validated guessing first. See Documents and Resources/Tests/game/grading-fixtures.json.
 */
import { resolveSession } from "./auth";
import { visiblePictureUrl } from "./premiere";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

export interface DailyGameEnv {
  DB: D1Database;
  /** flickto-content. Read-only here, and only for `game-state/answers/*`. */
  CONTENT_BUCKET?: R2Bucket;
  /**
   * Optional, and the only defence on the one unauthenticated WRITE in this worker.
   *
   * Anonymous submissions are fully verified, so nobody can inflate a "solved in 1"
   * without naming the right title. What remains is someone posting many VALID results
   * to skew a display statistic, for no gain — proportionate to answer with a rate limit
   * rather than with per-anonymous-player dedupe rows, which would mean a write per
   * anonymous player per day plus IP retention, to make a fun figure marginally sharper.
   *
   * Declared optional so the worker deploys with or without the binding; see
   * wrangler.toml for how to enable it. Absent, this degrades to no limit rather than
   * to a broken endpoint.
   */
  ANON_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/**
 * MUST match Documents and Resources/Tests/game/grading-fixtures.json and both clients. The clients compute this
 * for display; the value stored is always the one derived here.
 */
const SCORE_LADDER = [100, 80, 60, 45, 30];
const MAX_GUESSES = 5;
const UNSOLVED_SCORE = 0;

/**
 * The six-guess game, kept alive for clients that have not updated.
 *
 * ⚠️ Do NOT collapse these into MAX_GUESSES. Every install still on the old build plays
 * six and submits six, and the validator below rejects the WHOLE request when any row
 * fails its bounds — so tightening the cap on the day of the change would throw away those
 * players' results entirely, not just the sixth guess. A legacy solve is scored on the
 * ladder it was actually played on, which is what that player saw on their screen.
 *
 * Safe to delete once the old builds are gone (same lever as MIN_SOCIAL_VERSION).
 */
const LEGACY_MAX_GUESSES = 6;
const LEGACY_SCORE_LADDER = [100, 80, 60, 45, 30, 15];

/** How far back a sign-in backfill may reach. Answer files are kept 40 days, so this fits. */
const BACKFILL_DAYS = 30;

/** Bounds one request. A month of catch-up is the most an honest client ever sends. */
const MAX_RESULTS_PER_REQUEST = 31;

const ANSWER_PREFIX = "game-state/answers/";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

import { fitsCell, type GridSpec } from "./flickGridRules";
import { titleIndex, titleKey } from "./titleIndex";

/**
 * The games in the suite.
 *
 * ⚠️ MUST match `GameId` in flickto-web/lib/games/dailyState.ts and the `game` column
 * values written by migration 0052. The string IS the wire value and the stored value, so
 * renaming one here orphans every row already written under the old name.
 */
/*
 * ⚠️ DEPLOY ORDER: migration 0052 MUST be applied before this worker ships.
 *
 *   npx wrangler d1 migrations apply flickto-accounts --remote
 *
 * Every query below now names the `game` column. Against the pre-0052 schema each one
 * fails with "no such column", which is every daily-game endpoint returning 500 at once --
 * submission, the reveal, the leaderboard and the open bundle -- for as long as the gap
 * lasts. The reverse order is safe: 0052 defaults the column to 'flickdl', so the CURRENT
 * worker keeps running unchanged against the migrated schema for as long as you like.
 */
const GAMES = ["flickdl", "flickreel", "flickology", "flickgrid", "link"] as const;

/**
 * The highest histogram bucket any game produces.
 *
 * Flickology's is PLACES OUT across five cards, which reaches 12 on the reverse — the
 * widest of the five. FlickGrid reaches 9, the guessing games 6.
 *
 * ⚠️ Was 10 while Flickology scored on wrong pairs. A value too small does not error, it
 * silently drops the tail of one game's chart on the way out.
 */
const MAX_BUCKET = 12;
export type GameId = (typeof GAMES)[number];

/**
 * What a request that names no game is.
 *
 * ⚠️ Load-bearing for the SHIPPED Android app, which predates the suite and sends no
 * `game` field at all. Defaulting rather than rejecting is what keeps those installs
 * submitting; it is the same reasoning as the optional `types` array in parseBody.
 */
const DEFAULT_GAME: GameId = "flickdl";

/**
 * How many picks one finished round may contain, per game.
 *
 * Not one shared cap: a Grid is nine cells and a Flickology is five slots, so a single
 * bound would have to be the loosest of them and would stop bounding anything. Flickdl
 * uses the LEGACY six for the reason LEGACY_MAX_GUESSES gives -- a request is rejected
 * whole, so a tighter cap here throws away the other days in the same backfill.
 */
const MAX_PICKS: Record<GameId, number> = {
  flickdl: LEGACY_MAX_GUESSES,
  // ⚠️ Keyed by the GameId, which is `flickreel` and not `reel`. Three of these were
  // spelled short, so `MAX_PICKS[game]` was `undefined` for them and `length > undefined`
  // is false -- the bound existed and bounded nothing. `Record<GameId, number>` should
  // have caught it and did not, because tsc does not run clean on this worker.
  flickreel: 6,
  flickology: 5,
  flickgrid: 9,
  // The whole CHAIN, endpoints included: Flicklink's move limit is 8 and both the start
  // and the finish travel in the same list. A cap of 8 would reject a full-length route
  // for being exactly as long as it was allowed to be -- and parseBody rejects the whole
  // request, so it would take the rest of a backfill with it.
  link: 10,
};

/**
 * `?game=` on a GET, defaulting to Flickdl.
 *
 * An UNRECOGNISED game falls back rather than 400s. These are read endpoints whose worst
 * case is showing the wrong game's numbers, and a client one version ahead of the worker
 * asking for a game it has not heard of should see Flickdl, not an error page.
 */
function gameParam(req: Request): GameId {
  return asGame(new URL(req.url).searchParams.get("game") ?? undefined) ?? DEFAULT_GAME;
}

function asGame(value: unknown): GameId | null {
  if (value === undefined || value === null) return DEFAULT_GAME;
  return (GAMES as readonly string[]).includes(value as string) ? (value as GameId) : null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86_400_000,
  );
}

function scoreFor(guessCount: number, solved: boolean): number {
  if (!solved) return UNSOLVED_SCORE;
  const i = guessCount - 1;
  if (i < 0) return UNSOLVED_SCORE;
  if (i < SCORE_LADDER.length) return SCORE_LADDER[i];
  // A sixth guess can only come from a client still playing the six-guess game. Score it
  // on that ladder rather than zeroing a solve the player earned. See LEGACY_MAX_GUESSES.
  return i < LEGACY_SCORE_LADDER.length ? LEGACY_SCORE_LADDER[i] : UNSOLVED_SCORE;
}

/**
 * Which histogram bucket a result falls in.
 *
 * ⚠️ Game-aware, because "how everyone did" is a different number per game and one rule
 * made two of them say nothing at all.
 *
 * For the guessing games the shape is Wordle's: 1..N is "solved on N", 0 is "did not
 * solve". That is exactly right for Flickdl, FlickReel and Flicklink, where a round ends
 * either in the answer or in running out.
 *
 * It was meaningless for the other two, which have no losing state. Every Flickology
 * round places five cards, so `solved ? guessCount : 0` put every result in bucket 5 or
 * bucket 0 and the chart said only "perfect / not perfect". FlickGrid was the same with
 * nine. Both now bucket on their own headline number — pairs out of place, squares placed
 * right — which is the spread the score is already computed from.
 *
 * Note the directions differ, and deliberately: FlickGrid's bucket 9 is a perfect board
 * and Flickology's bucket 0 is. Each is the number that game says out loud, and the
 * client labels its own chart.
 */
function bucketFor(game: GameId, guessCount: number, solved: boolean): number {
  if (game === "flickgrid" || game === "flickology") return guessCount;
  return solved ? guessCount : 0;
}

type ArchivedAnswer = {
  date: string;
  puzzleNumber: number;
  tmdbId: number;
  title: string;
  /** FlickGrid only: the day's six constraints. There is no single "answer" title. */
  grid?: GridSpec;
  /** Flicklink only: the endpoints the chain must run between, and the target length. */
  link?: {
    start: { tmdbId: number; type: number };
    end: { tmdbId: number; type: number };
    par: number;
    moveLimit: number;
  };
  /**
   * Flickology only: the correct order, as TMDB ids.
   *
   * Optional because every other game's answer IS its `tmdbId`. A game whose answer is a
   * sequence rather than a single title cannot be checked by "did the last guess match",
   * so it carries the sequence and gets its own branch in verify().
   */
  order?: number[];
};

/**
 * The day's answer file for one game.
 *
 * ⚠️ Flickdl reads the FLAT `game-state/answers/{date}.json` it has always used, and every
 * other game is namespaced under its own id. Forty days of archived Flickdl answers exist
 * at the flat path and a sign-in backfill verifies each day against its own file -- so
 * moving Flickdl under a prefix would make every one of those days unverifiable, and a
 * backfill spanning the change would silently drop them rather than fail loudly.
 */
async function readAnswer(
  env: DailyGameEnv,
  game: GameId,
  date: string,
): Promise<ArchivedAnswer | null> {
  if (!env.CONTENT_BUCKET) return null;
  const key = game === "flickdl" ? `${ANSWER_PREFIX}${date}.json` : `${ANSWER_PREFIX}${game}/${date}.json`;
  const obj = await env.CONTENT_BUCKET.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as ArchivedAnswer;
  } catch {
    return null;
  }
}

type SubmittedResult = { date: string; puzzleNumber?: number; guesses: number[]; types: number[] };
type VerifiedResult = {
  date: string;
  puzzleNumber: number;
  guessCount: number;
  solved: boolean;
  score: number;
  /** The ids as guessed, in order. Stored so another device can redraw the board. */
  guesses: number[];
  /** 0 = film, 1 = show, parallel to [guesses]. Empty when the client did not send it. */
  types: number[];
};

/**
 * One request carries ONE game.
 *
 * Not a game per result. Each game is its own page with its own local store, so a client
 * never has two games' results to flush at once -- and making it per-row would mean a
 * backfill could span games, which every downstream read (the stats recompute, the round
 * state, the returned distribution) would then have to fan out over for no gain.
 */
type ParsedBody = { game: GameId; results: SubmittedResult[] };

function parseBody(body: unknown): ParsedBody | null {
  if (!body || typeof body !== "object") return null;
  const game = asGame((body as { game?: unknown }).game);
  if (!game) return null;
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  if (results.length > MAX_RESULTS_PER_REQUEST) return null;

  const out: SubmittedResult[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as {
      date?: unknown; puzzleNumber?: unknown; guesses?: unknown; types?: unknown;
    };
    if (typeof r.date !== "string" || !DATE_RE.test(r.date)) return null;
    if (!Array.isArray(r.guesses)) return null;
    // ⚠️ Bounded PER GAME, and for Flickdl that bound is the LEGACY six. A failure here
    // rejects the ENTIRE request, so tightening Flickdl to MAX_GUESSES would discard every
    // result from every install still on the six-guess build — including the other days in
    // the same backfill. See MAX_PICKS.
    if (r.guesses.length < 1 || r.guesses.length > MAX_PICKS[game]) return null;
    if (!r.guesses.every((g) => Number.isInteger(g))) return null;
    // Optional and additive: clients that predate it simply store no types, and their
    // rows restore without a grid rather than with a wrong one. A malformed or
    // wrong-length array is dropped for the same reason.
    const types =
      Array.isArray(r.types) &&
      r.types.length === r.guesses.length &&
      r.types.every((x) => x === 0 || x === 1)
        ? (r.types as number[])
        : [];

    out.push({
      date: r.date,
      puzzleNumber: typeof r.puzzleNumber === "number" ? r.puzzleNumber : undefined,
      guesses: r.guesses as number[],
      types,
    });
  }
  return { game, results: out };
}

/**
 * Checks one submitted result against the day's real answer.
 *
 * Returns null for anything that cannot be trusted, and the caller drops it silently
 * rather than failing the whole request: a backfill spanning a day whose answer has aged
 * out should still land the other twenty-nine.
 */
async function verify(
  env: DailyGameEnv,
  game: GameId,
  submitted: SubmittedResult,
  today: string,
  maxAgeDays: number,
): Promise<VerifiedResult | null> {
  const age = daysBetween(submitted.date, today);
  if (age < 0) return null;              // dated in the future
  if (age > maxAgeDays) return null;     // outside the window we can still verify

  const answer = await readAnswer(env, game, submitted.date);
  if (!answer) return null;

  // A client claiming a different puzzle for this date is either confused or probing.
  if (submitted.puzzleNumber !== undefined && submitted.puzzleNumber !== answer.puzzleNumber) {
    return null;
  }

  const guesses = submitted.guesses;

  // A game whose answer is a SEQUENCE is checked differently, and checking it the normal
  // way would silently score it on whether its final card happened to be the right one.
  if (game === "flickology") return verifyOrder(submitted, answer, guesses);
  if (game === "flickgrid") return verifyGrid(env, submitted, answer, guesses);
  if (game === "link") return verifyLink(submitted, answer, guesses);

  const last = guesses[guesses.length - 1];
  const solved = last === answer.tmdbId;

  // The answer cannot appear before the final slot: play stops the moment it is guessed.
  // A list containing it earlier did not come from the game.
  if (guesses.slice(0, -1).includes(answer.tmdbId)) return null;

  const guessCount = guesses.length;
  return {
    date: submitted.date,
    puzzleNumber: answer.puzzleNumber,
    guessCount,
    solved,
    score: scoreFor(guessCount, solved),
    guesses,
    types: submitted.types,
  };
}

/**
 * Flicklink: a chain from the day's start to the day's end.
 *
 * ## What this checks, and what it deliberately does not
 *
 * It checks the ENDPOINTS and the LENGTH: the chain must begin at the title the player was
 * given, end at the one they were sent to, and be no longer than the move limit. Those are
 * the things the score is derived from, and all three come from the archived answer.
 *
 * It does NOT re-check that each consecutive pair genuinely shares a person. Doing so means
 * credits for every title in the chain, and the only source this worker can reach --
 * data.flickto.app -- has payloads for roughly a third of the guess universe, so a real
 * chain through a title without one would be REJECTED for being correct. Rejecting valid
 * play to catch invalid play is the wrong trade for a daily game.
 *
 * ⚠️ So a crafted client can post a two-link chain it did not solve. That is the same
 * exposure Flickdl already carries and documents in obfuscate.ts -- the client grades
 * offline, and server-validated guessing is the only real fix. It is bounded here: you
 * must still name the right endpoints, the score is capped by the move limit, and the
 * leaderboard is friends-only. If Flicklink ever ranks globally, this is the thing to fix
 * first, and the fix is a credits index in R2 rather than a change of shape here.
 */
function verifyLink(
  submitted: SubmittedResult,
  answer: ArchivedAnswer,
  guesses: number[],
): VerifiedResult | null {
  const spec = answer.link;
  if (!spec) return null;

  const types = submitted.types.length === guesses.length ? submitted.types : [];
  if (types.length !== guesses.length) return null;

  // Start, at least one step, and the end. A two-entry chain is the endpoints touching,
  // which the generator's par of two or more says cannot happen.
  if (guesses.length < 3) return null;
  if (guesses.length > spec.moveLimit + 2) return null;

  const first = { tmdbId: guesses[0], type: types[0] };
  const last = { tmdbId: guesses[guesses.length - 1], type: types[types.length - 1] };
  if (first.tmdbId !== spec.start.tmdbId || first.type !== spec.start.type) return null;
  if (last.tmdbId !== spec.end.tmdbId || last.type !== spec.end.type) return null;

  // A chain that visits the same title twice is a loop, and a loop is never a shorter
  // route -- it is a client that lost track of its own state.
  const seen = new Set(guesses.map((id, i) => `${types[i]}:${id}`));
  if (seen.size !== guesses.length) return null;

  const links = guesses.length - 1;
  return {
    date: submitted.date,
    puzzleNumber: answer.puzzleNumber,
    // Links used, so the histogram buckets by route length -- which for this game is
    // exactly the interesting number, and needs no special case in bucketFor: every
    // finished chain is `solved`, so its bucket is simply its length.
    guessCount: links,
    solved: true,
    score: linkScore(links, spec.par),
    guesses,
    types: submitted.types,
  };
}

/**
 * Par pays full marks, over par costs, under par earns a bonus.
 *
 * ⚠️ MUST match linkScore in flickto-web/lib/games/link.ts. The generator's par is a
 * target found in a sample of the credits graph, not the shortest route through all of
 * cinema, so beating it is a real achievement rather than an anomaly to clamp.
 */
export function linkScore(links: number, par: number): number {
  if (links <= 0) return 0;
  const over = links - par;
  if (over <= 0) return 100 + Math.min(2, -over) * 15;
  return Math.max(10, 100 - over * 20);
}

/**
 * FlickGrid: nine picks, each checked against its own square.
 *
 * ## This is the first verifier that has to know what a title IS
 *
 * Every game before it could be checked from the answer's id alone. A grid pick is valid
 * because of the title's decade, genres or rating, so the worker reads the published title
 * index out of R2 and checks the claim itself rather than taking the client's word for it.
 * See titleIndex.ts for why that read is affordable.
 *
 * ⚠️ Without the index this returns NULL rather than accepting the board. An unverifiable
 * submission is dropped, never trusted: rarity is aggregated from these rows and a
 * client-scored grid would let one person write whatever they liked into everyone else's
 * "only 4% picked this".
 *
 * A cell may be left EMPTY, sent as id 0. Nine slots always, some possibly blank -- which
 * is why a short array is rejected rather than padded: a client that sent six ids would
 * otherwise have them silently read as the first six squares.
 */
async function verifyGrid(
  env: DailyGameEnv,
  submitted: SubmittedResult,
  answer: ArchivedAnswer,
  guesses: number[],
): Promise<VerifiedResult | null> {
  const spec = answer.grid;
  if (!spec || spec.rows.length !== 3 || spec.cols.length !== 3) return null;
  if (guesses.length !== 9) return null;

  const types = submitted.types.length === guesses.length ? submitted.types : [];
  let correct = 0;

  if (spec.solution && spec.solution.length === 9) {
    /*
     * The board is a matching puzzle: the published tray holds exactly one poster that
     * fits each cell, so a placement is either THE answer or it is not. Comparing ids is
     * the whole check, and it needs no title index.
     */
    for (let cell = 0; cell < 9; cell++) {
      if (guesses[cell] !== 0 && guesses[cell] === spec.solution[cell]) correct++;
    }
  } else {
    /*
     * A board archived before the tray existed. Any title satisfying both constraints was
     * a valid answer then, so it is graded the way it was played.
     */
    const index = await titleIndex(env.CONTENT_BUCKET);
    if (!index) return null;
    for (let cell = 0; cell < 9; cell++) {
      const id = guesses[cell];
      if (id === 0) continue;                       // deliberately left blank
      const type = types[cell];
      if (type !== 0 && type !== 1) return null;    // an id without its namespace is not a title
      const title = index.get(titleKey(type, id));
      if (!title) continue;                         // not a title we publish; scores nothing
      if (fitsCell(title, spec, cell)) correct++;
    }
  }

  return {
    date: submitted.date,
    puzzleNumber: answer.puzzleNumber,
    // Squares filled correctly, so the histogram buckets by how well the board went.
    // bucketFor reads this straight through for FlickGrid rather than through the
    // guessing games' `solved ? guessCount : 0`, which would have given a bucket only to
    // a perfect nine and collapsed every other board into zero.
    guessCount: correct,
    solved: correct === 9,
    score: Math.round((correct / 9) * 100),
    guesses,
    types: submitted.types,
  };
}

/**
 * How far the board is from the true order: for each card, how many places it sits from
 * where it belongs, summed.
 *
 * Five cards can be at most 12 places out in total (the exact reverse), and that is the
 * whole scale -- see MAX_PLACES_OUT.
 *
 * ⚠️ NOT a count of misplaced CARDS. That measure is genuinely broken and the version of
 * this file that scored on wrong pairs warned about it: moving one card in a run of five
 * shifts every card after it, so a near-perfect board and a reversed one both report
 * "four wrong", and a player who improves their answer can watch their score fall.
 * Summing DISTANCES has neither problem. Verified exhaustively across all 120 orderings
 * and all 240 improving single swaps -- there is no case where making the board better lowers the
 * score.
 *
 * ## Why this replaced wrong pairs
 *
 * Pairs graded correctly and were just as monotone, but could not be EXPLAINED. Five
 * posters produce ten pairs, so a good round read "7 of 10 pairs right" and players took
 * the mismatched denominator for a scoring bug. Places out is a sum anyone can check:
 * each card carries its own number and they add up to the total shown.
 */
export function placesOut(submitted: number[], correct: number[]): number {
  const rank = new Map(correct.map((id, i) => [id, i]));
  let total = 0;
  for (let i = 0; i < submitted.length; i++) {
    const belongs = rank.get(submitted[i]);
    if (belongs === undefined) continue;
    total += Math.abs(belongs - i);
  }
  return total;
}

/**
 * The worst a board of `n` cards can be, which is the reverse: floor(n squared / 2).
 *
 * Derived rather than typed as 12, because it is the denominator of the whole score and a
 * game that ever changes its card count must not silently keep dividing by five cards'
 * worth.
 */
export function maxPlacesOut(cards: number): number {
  return Math.floor((cards * cards) / 2);
}

/**
 * How many STARS the board earned, out of six.
 *
 * ⚠️ Places out is always EVEN for any ordering -- the distances a permutation moves
 * cards must cancel out -- so a five-card board has exactly SEVEN reachable results, and
 * this maps them one-to-one onto 6..0 stars: 0 out is six, 2 out is five, and so on down
 * to the exact reverse at nothing.
 *
 * It used to answer a PERCENTAGE off the same line, which produced 100/83/67/50/33/17/0.
 * Those were correct and read as arbitrary -- a player who saw 67 had no way to tell it
 * was the third of seven rungs rather than a fraction of something. Six stars says the
 * same thing in the unit the board is actually drawn in.
 *
 * ⚠️ This is the STORED score, so it is also what the friends list and the per-game
 * leaderboard rank on. That is safe because every board comparison is per-game -- see
 * boardQuery, which filters on `game` in both shapes -- but rows written before this
 * carry the old 0..100 values and would tower over new ones on the all-time board.
 * Migration 0055 rescales them.
 */
export const ORDER_STARS = 6;

export function orderScore(places: number, cards: number): number {
  const worst = maxPlacesOut(cards);
  if (worst <= 0) return ORDER_STARS;
  return Math.max(0, Math.round(ORDER_STARS * (1 - places / worst)));
}

/**
 * Flickology's verifier.
 *
 * ⚠️ Rejects a submission that is not a PERMUTATION of the day's five titles. Without
 * that check a client could send the same easy title five times, or four of the five and
 * one ringer, and score whatever the inversion count of a malformed list happened to be.
 * The set is fixed and published, so there is exactly one valid multiset to send.
 */
function verifyOrder(
  submitted: SubmittedResult,
  answer: ArchivedAnswer,
  guesses: number[],
): VerifiedResult | null {
  const correct = answer.order;
  if (!correct || correct.length === 0) return null;
  if (guesses.length !== correct.length) return null;
  const wanted = [...correct].sort().join(",");
  const got = [...guesses].sort().join(",");
  if (wanted !== got) return null;

  const places = placesOut(guesses, correct);
  return {
    date: submitted.date,
    puzzleNumber: answer.puzzleNumber,
    /*
     * PLACES OUT, not the number of cards placed.
     *
     * The whole board is one move, so "guesses spent" was always five and carried no
     * information — which made the distribution degenerate, every result landing in
     * bucket 5 or bucket 0. The column holds the number this game is actually about, the
     * same way FlickGrid's holds squares placed right, and bucketFor reads it directly.
     * Lower is better: zero places out is a perfect order, twelve is the reverse.
     */
    guessCount: places,
    // Solved means perfectly ordered. Anything else still scores; see orderScore.
    solved: places === 0,
    score: orderScore(places, correct.length),
    guesses,
    types: submitted.types,
  };
}

type StatsRow = {
  played: number;
  wins: number;
  currentStreak: number;
  bestStreak: number;
  totalScore: number;
  histogram: Record<string, number>;
  lastPlayedDate: string | null;
};

/**
 * Rebuilds the rollup from the daily rows.
 *
 * Recomputed rather than incremented, because a backfill can insert days in the MIDDLE of
 * an existing history — signing in after a fortnight of anonymous play can join two runs
 * into one longer streak, which no incremental update could have seen.
 */
async function recomputeStats(env: DailyGameEnv, userId: string, game: GameId): Promise<StatsRow> {
  const { results } = await env.DB.prepare(
    "SELECT date, solved, score, guess_count FROM daily_game_results WHERE user_id = ? AND game = ? ORDER BY date DESC",
  )
    .bind(userId, game)
    .all<{ date: string; solved: number; score: number; guess_count: number }>();

  const rows = results ?? [];
  const histogram: Record<string, number> = {};
  let played = 0;
  let wins = 0;
  let totalScore = 0;

  for (const r of rows) {
    played++;
    if (r.solved) wins++;
    totalScore += r.score;
    const bucket = String(bucketFor(game, r.guess_count, r.solved === 1));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }

  // Streaks count PLAYED days, won or lost. Losing does not break one; only not turning
  // up does. rows are newest-first, so the run that is still unbroken at index i — that
  // is, run === i + 1 — is the CURRENT streak.
  let currentStreak = 0;
  let bestStreak = 0;
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    const consecutive = i > 0 && daysBetween(rows[i].date, rows[i - 1].date) === 1;
    run = consecutive ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    if (run === i + 1) currentStreak = run;
  }

  const lastPlayedDate = rows[0]?.date ?? null;

  await env.DB.prepare(
    `INSERT INTO daily_game_stats
       (user_id, game, played, wins, current_streak, best_streak, total_score, guess_histogram, last_played_date, updated_at)
     VALUES (?1, ?10, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(user_id, game) DO UPDATE SET
       played = excluded.played, wins = excluded.wins,
       current_streak = excluded.current_streak, best_streak = excluded.best_streak,
       total_score = excluded.total_score, guess_histogram = excluded.guess_histogram,
       last_played_date = excluded.last_played_date, updated_at = excluded.updated_at`,
  )
    .bind(
      userId, played, wins, currentStreak, bestStreak, totalScore,
      JSON.stringify(histogram), lastPlayedDate, Date.now(),
      // ?10, appended rather than slotted in at position 2 so the eight binds either side
      // of it keep the numbers they already had.
      game,
    )
    .run();

  return { played, wins, currentStreak, bestStreak, totalScore, histogram, lastPlayedDate };
}

/**
 * The rollup as stored, without recomputing it.
 *
 * ⚠️ Deliberately NOT [recomputeStats]: that one WRITES, and a GET that rewrites the
 * rollup on every open would turn a read the client makes on every launch into a D1 write
 * per launch. The row is maintained on submit, which is the only thing that can change it.
 *
 * `currentStreak` is only current relative to `lastPlayedDate` — the column does not
 * expire itself, so it is returned alongside and the caller decides whether the run is
 * still alive.
 */
async function readStats(env: DailyGameEnv, userId: string, game: GameId): Promise<StatsRow> {
  const row = await env.DB.prepare(
    `SELECT played, wins, current_streak, best_streak, total_score, guess_histogram, last_played_date
       FROM daily_game_stats WHERE user_id = ?1 AND game = ?2`,
  )
    .bind(userId, game)
    .first<{
      played: number;
      wins: number;
      current_streak: number;
      best_streak: number;
      total_score: number;
      guess_histogram: string;
      last_played_date: string | null;
    }>();

  if (!row) {
    return {
      played: 0, wins: 0, currentStreak: 0, bestStreak: 0,
      totalScore: 0, histogram: {}, lastPlayedDate: null,
    };
  }

  let histogram: Record<string, number> = {};
  try {
    const parsed = JSON.parse(row.guess_histogram ?? "{}");
    if (parsed && typeof parsed === "object") histogram = parsed as Record<string, number>;
  } catch {
    histogram = {};
  }

  return {
    played: row.played,
    wins: row.wins,
    currentStreak: row.current_streak,
    bestStreak: row.best_streak,
    totalScore: row.total_score,
    histogram,
    lastPlayedDate: row.last_played_date,
  };
}

/**
 * POST /api/daily-game/result — **session OPTIONAL**, deliberately.
 *
 * ⚠️ This is one of two handlers in this file that does not gate on a session, and in a
 * worker where `resolveSession` -> 401 is the house style that reads as the bug the
 * others were written to avoid. It is not. The game is fully playable signed out, most
 * web players never sign in, and verification has never needed a session — the answer
 * comes from R2 either way. Rejecting anonymous submissions would exclude the majority of
 * players from the distribution figure they are being shown.
 *
 * What a session DOES decide is how much is written: with one, a personal row and the
 * rollup; without one, only the anonymous counter. And an anonymous caller may submit
 * TODAY ONLY, one result — backfill is what a session buys, so a single unauthenticated
 * request can never add a month of counts.
 */
export async function handlePostResult(
  req: Request,
  env: DailyGameEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);

  const body = await req.json().catch(() => null);
  const parsed = parseBody(body);
  if (!parsed) return json({ error: "invalid_payload" }, 400);
  const { game, results: submitted } = parsed;

  const today = todayIso();

  if (!session) {
    if (submitted.length !== 1) return json({ error: "anonymous_single_result_only" }, 400);
    if (submitted[0].date !== today) return json({ error: "anonymous_today_only" }, 400);

    // Keyed on the connecting IP, which is the only stable handle an anonymous caller
    // has. Not stored — passed to the limiter and discarded.
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    // Keyed per GAME as well as per IP: one limiter across the suite would mean finishing
    // Flickdl could rate-limit the same person out of submitting FlickGrid a minute later.
    const limit = await env.ANON_RATE_LIMITER?.limit({ key: `dg:${game}:${ip}` });
    if (limit && !limit.success) return json({ error: "rate_limited" }, 429);

    const verified = await verify(env, game, submitted[0], today, 0);
    if (!verified) return json({ error: "unverified" }, 400);

    await bumpAnonDistribution(env, game, verified);
    if (game === "flickgrid") {
      await bumpGridPicks(env, verified.date, verified.guesses, verified.types);
      return json({
        accepted: 1, anonymous: true,
        rarity: await readGridRarity(env, verified.date, verified.guesses, verified.types),
      });
    }
    return json({ accepted: 1, anonymous: true });
  }

  const verified: VerifiedResult[] = [];
  for (const s of submitted) {
    const v = await verify(env, game, s, today, BACKFILL_DAYS);
    if (v) verified.push(v);
  }
  if (verified.length === 0) return json({ error: "unverified" }, 400);

  const now = Date.now();
  await env.DB.batch(
    verified.map((v) =>
      env.DB
        .prepare(
          `INSERT INTO daily_game_results
             (user_id, game, date, puzzle_number, guess_count, solved, score, created_at, guesses, guess_types)
           VALUES (?1, ?10, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(user_id, game, date) DO NOTHING`,
        )
        .bind(
          session.userId, v.date, v.puzzleNumber, v.guessCount, v.solved ? 1 : 0, v.score, now,
          JSON.stringify(v.guesses), JSON.stringify(v.types), game,
        ),
    ),
  );

  if (game === "flickgrid") {
    for (const v of verified) await bumpGridPicks(env, v.date, v.guesses, v.types);
  }

  const stats = await recomputeStats(env, session.userId, game);

  /*
   * The round's fresh numbers ride back with the submission.
   *
   * The client used to POST here and then immediately GET /distribution, /friends and
   * /leaderboard to redraw the reveal — four round trips for one event. Computing them
   * here is also strictly MORE correct: they are read after this row has landed, so the
   * player's own result is already counted. The follow-up GETs were racing their own
   * write and could answer from before it.
   *
   * Keyed to the LATEST day submitted rather than today: a backfill flush posts a
   * fortnight at once, and the day the player just finished is the one they are looking
   * at. `?date=` overrides it for an archive replay.
   */
  const asked = new URL(req.url).searchParams.get("date");
  const forDate =
    asked && DATE_RE.test(asked)
      ? asked
      : verified.reduce((latest, v) => (v.date > latest ? v.date : latest), verified[0].date);

  const latest = verified.find((v) => v.date === forDate) ?? verified[0];
  return json({
    accepted: verified.length,
    game,
    stats,
    date: forDate,
    ...(game === "flickgrid"
      ? { rarity: await readGridRarity(env, forDate, latest.guesses, latest.types) }
      : {}),
    ...(await readRoundState(env, session.userId, game, forDate)),
  });
}

/**
 * Record what was played in each square, for rarity.
 *
 * Counts EVERYONE, signed in or not. A "only 4% picked this" figure computed from the
 * minority of players who happen to have accounts would be worse than not showing one --
 * see the same argument for daily_game_anon_distribution in migration 0032.
 *
 * Empty squares are not recorded. A blank is not a pick, and counting it would make the
 * per-cell total the number of PLAYERS rather than the number of answers, which is the
 * denominator rarity is supposed to be a fraction of.
 */
async function bumpGridPicks(
  env: DailyGameEnv,
  date: string,
  guesses: number[],
  types: number[],
): Promise<void> {
  const writes = [];
  for (let cell = 0; cell < guesses.length && cell < 9; cell++) {
    const id = guesses[cell];
    const type = types[cell];
    if (!id || (type !== 0 && type !== 1)) continue;
    writes.push(
      env.DB.prepare(
        `INSERT INTO daily_game_flickgrid_picks (date, cell, tmdb_id, type, count)
         VALUES (?1, ?2, ?3, ?4, 1)
         ON CONFLICT(date, cell, tmdb_id, type) DO UPDATE SET count = count + 1`,
      ).bind(date, cell, id, type),
    );
  }
  if (writes.length === 0) return;
  // One batch: nine separate round trips per submission is nine times the latency for a
  // figure nobody sees until the board is already finished.
  await env.DB.batch(writes);
}

/**
 * How rare each of this board's picks was, per square.
 *
 * ⚠️ Read AFTER the bump, so the player's own answer is included in its own denominator.
 * Reading first would report 0% for the first person to play a square, which is both wrong
 * and the most memorable number the game can show.
 */
export async function readGridRarity(
  env: DailyGameEnv,
  date: string,
  guesses: number[],
  types: number[],
): Promise<Array<{ cell: number; count: number; total: number } | null>> {
  const { results } = await env.DB.prepare(
    `SELECT cell, tmdb_id, type, count FROM daily_game_flickgrid_picks WHERE date = ?1`,
  ).bind(date).all<{ cell: number; tmdb_id: number; type: number; count: number }>();

  const rows = results ?? [];
  const totals = new Map<number, number>();
  const mine = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.cell, (totals.get(r.cell) ?? 0) + r.count);
    mine.set(`${r.cell}:${r.type}:${r.tmdb_id}`, r.count);
  }

  const out: Array<{ cell: number; count: number; total: number } | null> = [];
  for (let cell = 0; cell < 9; cell++) {
    const id = guesses[cell];
    const type = types[cell];
    if (!id || (type !== 0 && type !== 1)) { out.push(null); continue; }
    out.push({
      cell,
      count: mine.get(`${cell}:${type}:${id}`) ?? 0,
      total: totals.get(cell) ?? 0,
    });
  }
  return out;
}

async function bumpAnonDistribution(
  env: DailyGameEnv,
  game: GameId,
  v: VerifiedResult,
): Promise<void> {
  const bucket = bucketFor(game, v.guessCount, v.solved);
  await env.DB
    .prepare(
      `INSERT INTO daily_game_anon_distribution (game, date, guess_count, count)
       VALUES (?3, ?1, ?2, 1)
       ON CONFLICT(game, date, guess_count) DO UPDATE SET count = count + 1`,
    )
    .bind(v.date, bucket, game)
    .run();
}

/**
 * GET /api/daily-game/mine?since=YYYY-MM-DD — the caller's own played days.
 *
 * The read half of the account-linked game. Everything else here was already writing:
 * results land server-side and the score is derived here, but no client ever ASKED what it
 * had already played — so a reinstall, a second phone or the website all showed a fresh
 * board for a day that was finished and ranked, and let it be played again. The row is the
 * authority; a client that has one for a date must not offer that date again.
 *
 * Returns the guess list too, so the board redraws exactly rather than appearing as a bare
 * score. Rows written before migration 0033 carry `[]` and restore without a grid.
 *
 * `since` is clamped to the same window a backfill may reach, because that is how far back
 * a client can still be told anything useful.
 */
export async function handleGetMine(
  req: Request,
  env: DailyGameEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const asked = new URL(req.url).searchParams.get("since");
  const earliest = backfillFloor();
  const since = asked && DATE_RE.test(asked) && asked > earliest ? asked : earliest;

  return json(await readMine(env, session.userId, gameParam(req), since));
}

/** Stored as JSON text; a malformed row degrades to "no grid", never to a failed read. */
function parseGuesses(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((g) => Number.isInteger(g)) ? parsed : [];
  } catch {
    return [];
  }
}

/** GET /api/daily-game/friends?date=YYYY-MM-DD — how your friends did on one day. */
export async function handleGetFriendsDay(
  req: Request,
  env: DailyGameEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const date = new URL(req.url).searchParams.get("date") ?? todayIso();
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400);

  return json({ date, friends: await readFriendsDay(env, session.userId, gameParam(req), date) });
}

/**
 * GET /api/daily-game/leaderboard?window=week|all — ranked among friends, and you.
 *
 * `week` is a rolling 7 days rather than a calendar week, and it is the tab that serves
 * the point of the feature: it rewards turning up and forgives one missed day, where a
 * single-day ranking is mostly ties and an all-time one is unwinnable for anyone who
 * starts late.
 */
export async function handleGetLeaderboard(
  req: Request,
  env: DailyGameEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  // today | week | month | all. Anything unrecognised falls back to week, which is what
  // every existing client sends and what the finish panel still asks for.
  const asked = new URL(req.url).searchParams.get("window");
  const window: BoardWindow =
    asked === "all" || asked === "today" || asked === "month" ? asked : "week";

  return json(await readBoardWindow(env, session.userId, gameParam(req), window));
}

/**
 * GET /api/daily-game/distribution?date= — how everyone did, for the percentile.
 *
 * ⚠️ UNAUTHENTICATED on purpose, and the second of the two handlers here that is. A
 * signed-out player is shown this figure and must be able to fetch it. It exposes nothing
 * but seven aggregate counts.
 *
 * Signed-in results are counted by GROUPING the rows, not from a counter, so an erased
 * account drops out of every historical total automatically — the same reason poll totals
 * are derived. Anonymous submissions have no row to group and come from the counter table.
 * Both halves are needed; either alone under-reports.
 */
export async function handleGetDistribution(req: Request, env: DailyGameEnv): Promise<Response> {
  const date = new URL(req.url).searchParams.get("date") ?? todayIso();
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400);
  return json(
    await readDistribution(env, gameParam(req), date),
    200,
    // Short: it moves all day as people play, and a stale percentile is worse than a
    // slightly expensive one.
    { "Cache-Control": "public, max-age=60" },
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   The bundle
   ══════════════════════════════════════════════════════════════════════════

   Opening the game used to cost up to nine round trips: /mine, /distribution,
   /friends, /leaderboard once per window, /me/profile, and /friends/cards for
   the faces. Every one of them re-resolved the session and re-ran the same
   friendship membership query.

   `/api/me/bootstrap` already makes this argument for the rest of the site —
   "the Worker deliberately bundles them because Worker requests bind far
   tighter than rows". This is that, for the game.

   ⚠️ The individual endpoints STAY. Shipped Android builds call them and always
   will. These readers are the single implementation and the old handlers are
   thin wrappers, so the two can never drift.
   ══════════════════════════════════════════════════════════════════════════ */

/** Friends PLUS the caller: a leaderboard you are absent from is not a leaderboard. */
const MEMBERSHIP_SQL = `(
      SELECT CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
        FROM friendships f
       WHERE (f.user_a = ?1 OR f.user_b = ?1) AND f.state = 'accepted'
      UNION SELECT ?1
    )`;

/** Accepted friends only — the caller is deliberately NOT in this one. */
const FRIENDS_ONLY_SQL = `(
          SELECT CASE WHEN f.user_a = ?2 THEN f.user_b ELSE f.user_a END
            FROM friendships f
           WHERE (f.user_a = ?2 OR f.user_b = ?2) AND f.state = 'accepted'
        )`;

type FaceRow = {
  display_name: string | null;
  avatar_id: string | null;
  picture_url: string | null;
  picture_animated: number | null;
  premiere_until: number | null;
  premiere_comp_until: number | null;
};

/**
 * ⚠️ A picture goes through `visiblePictureUrl`, never straight out of the column.
 *
 * An animated picture is a Premiere cosmetic and is withheld once the subscription
 * lapses. Selecting `p.picture_url` and returning it would publish it anyway — the
 * gating lives in the read, not in the storage.
 */
const faceOf = (r: FaceRow) => ({
  displayName: r.display_name,
  avatarId: r.avatar_id,
  pictureUrl: visiblePictureUrl(r.picture_url, r) || null,
});

/** The joins every row with a face needs. `u` carries the Premiere state. */
const faceJoin = (idCol: string) =>
  `LEFT JOIN profiles p ON p.user_id = ${idCol}
   LEFT JOIN users u ON u.id = ${idCol}`;

const FACE_COLS = `p.display_name, p.avatar_id, p.picture_url,
                   u.picture_animated, u.premiere_until, u.premiere_comp_until`;

export type BoardWindow = "today" | "week" | "month" | "all";
const SPAN_DAYS: Record<string, number> = { today: 1, week: 7, month: 30 };

/**
 * `since` for a window, or null for `all`.
 *
 * ⚠️ -1 because the span INCLUDES today: a 7-day week is today plus the six before it.
 * And `all` has no span — `new Date(NaN).toISOString()` THROWS rather than returning
 * anything, so reading SPAN_DAYS unguarded turns the all-time board into a 500 while
 * every other window keeps working.
 */
function sinceFor(window: BoardWindow): string | null {
  if (window === "all") return null;
  return new Date(Date.now() - (SPAN_DAYS[window] - 1) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The board for ONE game.
 *
 * game is bound LAST in both shapes -- ?2 all-time, ?3 for a window -- rather than beside
 * user_id. MEMBERSHIP_SQL hard-codes ?1 three times, so renumbering to put the game second
 * would mean rewriting that shared string too, for a tidier argument order and nothing else.
 */
function boardQuery(window: BoardWindow): string {
  return window === "all"
    ? `SELECT s.user_id, s.total_score AS score, s.played, s.wins, s.current_streak, ${FACE_COLS}
         FROM daily_game_stats s ${faceJoin("s.user_id")}
        WHERE s.game = ?2 AND s.user_id IN ${MEMBERSHIP_SQL}
        ORDER BY score DESC, s.wins DESC`
    : `SELECT r.user_id, SUM(r.score) AS score, COUNT(*) AS played,
              SUM(r.solved) AS wins, 0 AS current_streak, ${FACE_COLS}
         FROM daily_game_results r ${faceJoin("r.user_id")}
        WHERE r.game = ?3 AND r.date >= ?2 AND r.user_id IN ${MEMBERSHIP_SQL}
        GROUP BY r.user_id
        ORDER BY score DESC, wins DESC`;
}

type BoardRow = FaceRow & {
  user_id: string; score: number; played: number; wins: number; current_streak: number;
};

const boardEntries = (rows: BoardRow[], selfId: string) =>
  rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    ...faceOf(r),
    score: r.score ?? 0,
    played: r.played ?? 0,
    wins: r.wins ?? 0,
    currentStreak: r.current_streak ?? 0,
    isSelf: r.user_id === selfId,
  }));

/** One window. What the pre-existing `/leaderboard` endpoint serves. */
export async function readBoardWindow(
  env: DailyGameEnv,
  userId: string,
  game: GameId,
  window: BoardWindow,
) {
  const since = sinceFor(window);
  const stmt =
    since === null
      ? env.DB.prepare(boardQuery(window)).bind(userId, game)
      : env.DB.prepare(boardQuery(window)).bind(userId, since, game);
  const { results } = await stmt.all<BoardRow>();
  return { window, since, entries: boardEntries(results ?? [], userId) };
}

/**
 * All four windows in ONE round trip.
 *
 * `D1.batch` runs the statements together, so this costs one hop rather than four. The
 * membership subquery is identical in all of them and the planner sees it four times
 * either way — what is saved is the network, the session resolve and three Worker
 * invocations, which is the expensive part.
 */
export async function readBoard(env: DailyGameEnv, userId: string, game: GameId) {
  const windows: BoardWindow[] = ["today", "week", "month", "all"];
  const stmts = windows.map((w) => {
    const since = sinceFor(w);
    return since === null
      ? env.DB.prepare(boardQuery(w)).bind(userId, game)
      : env.DB.prepare(boardQuery(w)).bind(userId, since, game);
  });
  const batched = await env.DB.batch<BoardRow>(stmts);
  const out = {} as Record<BoardWindow, ReturnType<typeof boardEntries>>;
  windows.forEach((w, i) => {
    out[w] = boardEntries(batched[i]?.results ?? [], userId);
  });
  return out;
}

/** How your friends did on ONE day. Excludes you — the client knows its own result. */
export async function readFriendsDay(
  env: DailyGameEnv,
  userId: string,
  game: GameId,
  date: string,
) {
  const { results } = await env.DB.prepare(
    `SELECT r.user_id, r.guess_count, r.solved, r.score, ${FACE_COLS}
       FROM daily_game_results r ${faceJoin("r.user_id")}
      WHERE r.game = ?3 AND r.date = ?1 AND r.user_id IN ${FRIENDS_ONLY_SQL}
      ORDER BY r.solved DESC, r.guess_count ASC`,
  )
    .bind(date, userId, game)
    .all<FaceRow & { user_id: string; guess_count: number; solved: number; score: number }>();

  return (results ?? []).map((r) => ({
    userId: r.user_id,
    ...faceOf(r),
    guessCount: r.guess_count,
    solved: r.solved === 1,
    score: r.score,
  }));
}

/** How everyone did, signed-in and anonymous halves summed. */
export async function readDistribution(env: DailyGameEnv, game: GameId, date: string) {
  /*
   * ⚠️ The signed-in half groups by the RAW columns and buckets in JS, through bucketFor.
   *
   * It used to bucket in SQL, as `CASE WHEN solved = 1 THEN guess_count ELSE 0 END` --
   * which is the guessing games' rule written out by hand, applied to all five. FlickGrid
   * and Flickology do not use that rule: they bucket on their headline number regardless
   * of `solved`, so every one of their signed-in rows collapsed into bucket 0. The chart
   * highlighted the right bar and drew it EMPTY, because the player's own result had been
   * counted somewhere else. The anonymous half never had the bug -- it calls bucketFor.
   *
   * Grouping on (guess_count, solved) is at most a couple of dozen rows for a day, so
   * bucketing them here costs nothing and cannot drift from bucketFor again.
   */
  const [signedIn, anonymous] = await Promise.all([
    env.DB.prepare(
      `SELECT guess_count, solved, COUNT(*) AS n
         FROM daily_game_results WHERE game = ?2 AND date = ?1
        GROUP BY guess_count, solved`,
    ).bind(date, game).all<{ guess_count: number; solved: number; n: number }>(),
    env.DB.prepare(
      "SELECT guess_count AS bucket, count AS n FROM daily_game_anon_distribution WHERE game = ?2 AND date = ?1",
    ).bind(date, game).all<{ bucket: number; n: number }>(),
  ]);

  // Width follows the LEGACY cap while six-guess clients are still submitting: narrowing
  // it now would silently drop their solves from "how everyone did".
  /*
   * Wide enough for the widest game, not for Flickdl's ladder.
   *
   * Flickology buckets on pairs out of place, which for five cards runs 0..10, so an
   * array sized to the guess ladder silently dropped most of its chart. The guessing
   * games simply leave the tail as zeros, and OneTakeDistribution already caps its render
   * at MAX_GUESSES rather than drawing whatever it is handed.
   */
  const buckets: number[] = new Array(MAX_BUCKET + 1).fill(0);
  const counted: Array<{ bucket: number; n: number }> = [
    ...(signedIn.results ?? []).map((r) => ({
      bucket: bucketFor(game, r.guess_count, r.solved === 1),
      n: r.n,
    })),
    ...(anonymous.results ?? []),
  ];
  for (const row of counted) {
    if (row.bucket >= 0 && row.bucket <= MAX_BUCKET) buckets[row.bucket] += row.n;
  }
  return { date, buckets, total: buckets.reduce((a, b) => a + b, 0) };
}

/** The caller's own days, plus the rollup. */
export async function readMine(env: DailyGameEnv, userId: string, game: GameId, since: string) {
  const { results } = await env.DB.prepare(
    `SELECT date, puzzle_number, guess_count, solved, score, guesses, guess_types
       FROM daily_game_results
      WHERE user_id = ?1 AND game = ?3 AND date >= ?2
      ORDER BY date DESC`,
  )
    .bind(userId, since, game)
    .all<{
      date: string; puzzle_number: number; guess_count: number; solved: number;
      score: number; guesses: string; guess_types: string;
    }>();

  return {
    since,
    results: (results ?? []).map((r) => ({
      date: r.date,
      puzzleNumber: r.puzzle_number,
      guessCount: r.guess_count,
      solved: r.solved === 1,
      score: r.score,
      guesses: parseGuesses(r.guesses),
      types: parseGuesses(r.guess_types),
    })),
    stats: await readStats(env, userId, game),
  };
}

/**
 * The caller's own name and face.
 *
 * The web client was fetching `/api/me/profile` purely for these two fields — a whole
 * profile, layout blobs and favourites and featured achievements, to render a 26px circle
 * and a row label.
 */
export async function readSelfProfile(env: DailyGameEnv, userId: string) {
  // ⚠️ NOT `faceJoin` here. That joins `profiles p`, and this already selects FROM it —
  // aliasing the same table twice, which SQLite rejects with "ambiguous column name" at
  // run time and no compiler anywhere will tell you. Only `users` needs joining.
  const row = await env.DB.prepare(
    `SELECT ${FACE_COLS}
       FROM profiles p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ?1`,
  )
    .bind(userId)
    .first<FaceRow>();
  return row ? faceOf(row) : null;
}

/** The earliest day a client may still be holding an unsent result for. */
function backfillFloor(): string {
  return new Date(Date.parse(todayIso() + "T00:00:00Z") - BACKFILL_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Everything the page needs once a round is over. Shared by `/open` and `/result`. */
export async function readRoundState(
  env: DailyGameEnv,
  userId: string,
  game: GameId,
  date: string,
) {
  const [distribution, friends, board] = await Promise.all([
    readDistribution(env, game, date),
    readFriendsDay(env, userId, game, date),
    readBoard(env, userId, game),
  ]);
  return { distribution, friends, board };
}

/**
 * GET /api/daily-game/open?date= — everything the game needs to open, in one request.
 *
 * ⚠️ Works SIGNED OUT, and must. The distribution is public — a signed-out player counts
 * towards it and is shown it — so gating the whole bundle on a session would push the
 * anonymous client back onto a second endpoint for the one thing it is allowed.
 */
export async function handleGetOpen(
  req: Request,
  env: DailyGameEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const date = new URL(req.url).searchParams.get("date") ?? todayIso();
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400);
  const game = gameParam(req);

  const session = await resolveSession(req, env as never, ctx);
  if (!session) {
    return json({
      date, game, signedIn: false,
      distribution: await readDistribution(env, game, date),
      mine: null, friends: [], board: null, profile: null,
    });
  }

  const [state, mine, profile] = await Promise.all([
    readRoundState(env, session.userId, game, date),
    readMine(env, session.userId, game, backfillFloor()),
    readSelfProfile(env, session.userId),
  ]);

  // ⚠️ No shared cache header: four of these five are per-account.
  return json(
    { date, game, signedIn: true, ...state, mine, profile },
    200,
    { "Cache-Control": "private, no-store" },
  );
}
