/**
 * Builds the two static inputs One Take needs.
 *
 *   src/game/pool.ts                      the candidate answers, bundled INTO the worker
 *   content/content/game/titles.v2.json   the OFFLINE guess universe, published to R2
 *
 * Run by hand, not in CI — the source is an 84 MB local file. Re-run when the catalogue
 * has grown enough to matter, look at the printed diff, commit both outputs.
 *
 *   node --max-old-space-size=6144 scripts/build-game-data.mjs
 *
 * ## Why the pool is bundled and the index is published
 *
 * The pool is the list of titles that can be an answer. It ships inside the worker, which
 * has no fetch handler, so it is never served. Publishing it would hand anyone a 2,500-name
 * shortlist for every future puzzle. The guess index is the opposite: public and
 * immutable-cacheable.
 *
 * ## The index is the OFFLINE path only
 *
 * Online, clients search Trakt directly -- which finds titles this catalogue does not have
 * (Back to the Future 1985 and Jaws are both missing) and returns posters. The index is
 * what autocomplete falls back to with no connection, so it deliberately carries NO poster
 * data: that would triple its raw size for a path that does not render posters anyway.
 *
 * ## The genre vocabulary is duplicated here, once, deliberately
 *
 * GENRE_SLUGS below MUST match cloudflare-backend/src/catalogMeta.ts and Android's
 * domain/scoring/GenreBitmask.kt — same slugs, same order, append-only. It cannot be
 * imported: that file belongs to a different worker in a different git repository. So the
 * copy lives here, in the generator, and NOT in the worker — everything downstream reads
 * baked values and needs no vocabulary of its own. One copy, in one place, checked below.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAILY_AI = resolve(HERE, "..");
const FLICKTO_SERVER = resolve(HERE, "../../..");
const REPO_ROOT = resolve(HERE, "../../../..");

const CATALOG_PATH = process.argv[2] ?? join(REPO_ROOT, "master_catalog.json");
const FIXTURE_PATH = join(REPO_ROOT, "docs/game/grading-fixtures.json");
const POOL_OUT = join(DAILY_AI, "src/game/pool.ts");
const TITLES_OUT = join(FLICKTO_SERVER, "content/content/game/titles.v2.json");

// MUST match cloudflare-backend/src/catalogMeta.ts and GenreBitmask.kt. Append only.
const GENRE_SLUGS = [
  "action", "adventure", "animation", "comedy", "crime", "documentary", "drama",
  "family", "fantasy", "history", "horror", "music", "mystery", "romance",
  "science-fiction", "tv-movie", "thriller", "war", "western", "children",
  "news", "reality", "soap", "talk-show", "anime",
  "donghua", "game-show", "holiday", "musical", "short", "special-interest", "superhero", "suspense",
];

/**
 * How many of each type may be an answer, taken most-voted first.
 *
 * ## Why these numbers came down from 1800/700
 *
 * An answer nobody has heard of is not a hard puzzle, it is a guessing game. Measured
 * against the catalogue, the old cuts landed in very different places: the 1,800th movie
 * had 4,549 votes (Death of a Unicorn) while the 700th SHOW had 1,988 (Goliath), because
 * only 310 shows clear the movie floor at all. Difficulty is normalised per type, so
 * those thin shows sat in the same weekday bands as movies with two to three times their
 * votes -- and every genuinely unfamiliar title in the hardest band was one of them:
 * Goliath 1,988, Pantheon 2,049, Kaiju No. 8 2,202, Hell on Wheels 2,639, beside
 * Chinatown 5,298 and Dumbo 5,326.
 *
 * At 1200/400 the tails are 6,683 (Anaconda) and 3,592 (Black Doves), and the hardest
 * band's median rises from 4,787 votes to 6,989 -- Planet Earth, Cosmos, Platoon.
 *
 * ⚠️ The cost is content lifetime, and it is the reason not to go lower without meaning
 * to. Each band is drawn from ONCE A WEEK, so a band of 229 is 4.4 years of that weekday;
 * the old 357 was 6.9. Halving these again would put it under two.
 */
const POOL_MOVIES = 1200;
const POOL_SHOWS = 400;

/**
 * Movies shorter than this are shorts, and a short is an unfair answer — nobody has seen
 * it and its runtime clue reads as broken. Shows are exempt: their runtime is per episode,
 * so 11 minutes is an ordinary animated comedy rather than a curio.
 */
const MIN_MOVIE_RUNTIME = 40;

/** Monday is band 0 (most famous), Sunday band 6. */
const BANDS = 7;

const TYPE_MOVIE = 0;
const TYPE_SHOW = 1;

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/**
 * Minimum vote counts for the popularity tiers.
 *
 * These are NOT graded any more -- Buzz was removed as an axis because nobody has
 * intuition for a popularity tier. They survive here for one job: BANDING the answer pool
 * by difficulty, so Monday draws from the most-watched titles and Sunday from the least.
 * That is a generator-only concern, which is why the thresholds moved out of the shared
 * fixture and into this file when the axis went.
 *
 * Measured, not chosen: the most-voted title has 61,344 votes, so a 100,000 ceiling would
 * leave the top tier permanently empty.
 */
const BUZZ_TIER_MIN_VOTES = [0, 250, 1000, 3000, 8000, 20000];

const SLUG_BIT = new Map(GENRE_SLUGS.map((slug, i) => [slug, i]));

/**
 * Unknown slugs are skipped, matching GenreBitmask.kt's `?: continue` and catalogMeta's
 * `continue`, so a genre added upstream degrades instead of shifting every later bit.
 */
function encodeGenreMask(genres) {
  let mask = 0n;
  for (const g of genres ?? []) {
    const bit = SLUG_BIT.get(String(g).trim().toLowerCase());
    if (bit === undefined) continue;
    mask |= 1n << BigInt(bit);
  }
  return mask;
}

function buzzTier(votes) {
  for (let i = BUZZ_TIER_MIN_VOTES.length - 1; i >= 0; i--) {
    if (votes >= BUZZ_TIER_MIN_VOTES[i]) return i;
  }
  return 0;
}

// ── self-check before producing anything ────────────────────────────────────

{
  // The mask is written into JSON as a Number. 33 slugs is 33 bits, far inside the
  // 53-bit safe range — but if the vocabulary ever grows past 53 the index would start
  // shipping silently rounded masks, so fail here rather than there.
  if (GENRE_SLUGS.length > 53) {
    console.error(`genre vocabulary is ${GENRE_SLUGS.length} slugs; a JSON number can no longer hold the mask exactly`);
    process.exit(1);
  }
  // The rating thresholds ARE shared, so make sure this file is reading the fixture the
  // clients read -- a generator writing tenths against different bands than the clients
  // grade with would be invisible until someone compared two devices.
  if (typeof fixture.thresholds?.ratingHitTenths !== "number") {
    console.error("grading-fixtures.json has no ratingHitTenths; is this the right file?");
    process.exit(1);
  }
  console.log(`self-check ok (${GENRE_SLUGS.length} genre slugs, rating bands ` +
    `${fixture.thresholds.ratingHitTenths}/${fixture.thresholds.ratingNearTenths} tenths)`);
}

// ── read ────────────────────────────────────────────────────────────────────

console.log(`reading ${CATALOG_PATH}`);
const rows = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
console.log(`  ${rows.length} rows`);

/** Everything usable as a GUESS. Needs only enough to be graded and displayed. */
const guessable = rows.filter((r) => r.title && r.year > 0 && Number.isFinite(r.tmdbId));
console.log(`  ${guessable.length} guessable (title, year, tmdbId)`);

/**
 * Trakt's 0-10 rating as integer TENTHS: 7.8 becomes 78.
 *
 * Never ship the float. `7.8 - 7.5` is `0.30000000000000027` in both Kotlin and
 * JavaScript, so a threshold expressed in decimals would depend on which side of the
 * subtraction the implementation sat. Rounding once, here, means the clients only ever
 * compare integers and cannot disagree on a boundary.
 */
const ratingTenths = (rating) =>
  !rating || rating <= 0 ? 0 : Math.round(rating * 10);

const titleRows = guessable.map((r) => [
  r.title,
  r.year,
  r.type === "SHOW" ? TYPE_SHOW : TYPE_MOVIE,
  Number(encodeGenreMask(r.genres)),
  ratingTenths(r.rating),
  r.tmdbId,
]);

// ── the answer pool ─────────────────────────────────────────────────────────

/**
 * Answerable is stricter than guessable. An answer drives the artwork reveal and the
 * runtime clue, so a missing backdrop or runtime does not make a hard puzzle, it makes a
 * broken one.
 */
const answerable = guessable.filter((r) => {
  if (!r.backdropUrl || !r.posterUrl) return false;
  if (!(r.runtime > 0)) return false;
  if (r.type !== "SHOW" && r.runtime < MIN_MOVIE_RUNTIME) return false;
  return true;
});

function topOfType(type, limit) {
  return answerable
    .filter((r) => (type === TYPE_SHOW ? r.type === "SHOW" : r.type !== "SHOW"))
    .sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0))
    .slice(0, limit);
}

const movies = topOfType(TYPE_MOVIE, POOL_MOVIES);
const shows = topOfType(TYPE_SHOW, POOL_SHOWS);

/**
 * Difficulty is rank WITHIN a type, normalised to 0..1 — not raw votes.
 *
 * Shows carry systematically fewer votes than movies on Trakt: the 700th show has about
 * as many as the 2,400th movie. Ranking one merged list by votes would drop nearly every
 * show into the hard bands, so Sunday would be television week and Monday never would be.
 * Normalising per type makes the most famous shows sit in band 0 beside the most famous
 * films, which is what "easy Monday" is supposed to mean.
 */
const ranked = [
  ...movies.map((r, i) => ({ r, difficulty: i / movies.length })),
  ...shows.map((r, i) => ({ r, difficulty: i / shows.length })),
].sort((a, b) => a.difficulty - b.difficulty);

const pool = ranked.map(({ r }, i) => ({
  tmdbId: r.tmdbId,
  type: r.type === "SHOW" ? TYPE_SHOW : TYPE_MOVIE,
  title: r.title,
  year: r.year,
  genres: (r.genres ?? []).filter((g) => SLUG_BIT.has(String(g).trim().toLowerCase())),
  genreMask: Number(encodeGenreMask(r.genres)),
  runtime: Math.max(0, Math.trunc(r.runtime)),
  ratingTenths: ratingTenths(r.rating),
  buzzTier: buzzTier(r.voteCount ?? 0),
  posterUrl: r.posterUrl,
  backdropUrl: r.backdropUrl,
  band: Math.min(BANDS - 1, Math.floor((i / ranked.length) * BANDS)),
}));

// ── report ──────────────────────────────────────────────────────────────────

console.log(`\npool: ${pool.length} answers (${movies.length} movies, ${shows.length} shows)`);
for (let b = 0; b < BANDS; b++) {
  const inBand = pool.filter((p) => p.band === b);
  const shows_ = inBand.filter((p) => p.type === TYPE_SHOW).length;
  const votesAt = inBand.length ? `tiers ${Math.min(...inBand.map((p) => p.buzzTier))}-${Math.max(...inBand.map((p) => p.buzzTier))}` : "";
  console.log(
    `  band ${b} (${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][b]}): ${String(inBand.length).padStart(4)} ` +
      `(${shows_} shows) ${votesAt}  e.g. ${inBand[0]?.title}`,
  );
}
const years = pool.map((p) => p.year).sort((a, b) => a - b);
console.log(`  years ${years[0]}-${years[years.length - 1]}, median ${years[Math.floor(years.length / 2)]}`);

// ── write ───────────────────────────────────────────────────────────────────

mkdirSync(dirname(POOL_OUT), { recursive: true });
mkdirSync(dirname(TITLES_OUT), { recursive: true });

const banner = `// GENERATED by scripts/build-game-data.mjs — do not edit by hand.
// The One Take answer pool. Bundled into the worker and never served: this worker has no
// fetch handler, so these ${pool.length} titles stay private. Publishing them would hand
// anyone a shortlist covering every future puzzle.
// Regenerate with: node --max-old-space-size=6144 scripts/build-game-data.mjs
`;

const poolTs =
  banner +
  `
export type PoolEntry = {
  tmdbId: number;
  /** 0 = movie, 1 = show */
  type: number;
  title: string;
  year: number;
  /** Trakt genre slugs, already filtered to the known vocabulary. */
  genres: string[];
  genreMask: number;
  runtime: number;
  /** Audience score times ten. Buzz tier is kept only to BAND difficulty, never graded. */
  ratingTenths: number;
  buzzTier: number;
  posterUrl: string;
  backdropUrl: string;
  /** 0 = Monday (most famous) .. 6 = Sunday. */
  band: number;
};

export const POOL: PoolEntry[] = ${JSON.stringify(pool)};
`;

writeFileSync(POOL_OUT, poolTs, "utf8");
writeFileSync(TITLES_OUT, JSON.stringify(titleRows), "utf8");

const kb = (p) => (readFileSync(p).length / 1024).toFixed(0);
console.log(`\nwrote ${POOL_OUT} (${kb(POOL_OUT)} KB)`);
console.log(`wrote ${TITLES_OUT} (${kb(TITLES_OUT)} KB, ${titleRows.length} rows)`);
console.log(`\nnext: commit both, then publish the index with deploy-r2.ps1`);
