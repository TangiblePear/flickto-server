// ── Friendships, blocks and reports (Phase 3/4) ──────────────────────────────
// Friendships move server-side, which is what finally makes blocking real. Until
// now a block only took effect when the blocker's device next rotated its keys —
// never, if that device stayed offline — so a blocked user kept the read access
// they already held. Here a block is enforced on the next request, by canView().
//
// Two rules shape almost every handler below:
//
//   1. NEVER reveal a block. A blocked user must not be able to tell the
//      difference between "you are blocked" and "nothing happened". Requests to a
//      blocking user therefore report success and quietly do nothing, and reads
//      return the same 404 a missing account would.
//   2. Friendship rows are canonical (`user_a < user_b`), so a relationship is one
//      row and "are these two friends" is a primary-key hit rather than a scan.

import { areFriends, friendshipKey, isBlockedEitherWay } from "./authz";
import { resolveSession } from "./auth";
import { isPremiere, visibleBorderId, visiblePictureUrl } from "./premiere";
import { recomputeEngagement } from "./publicLists";

export interface FriendsEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
  FRIEND_REQUESTS_PER_HOUR?: string;
  /**
   * Distinct reporters that auto-hide a profile picture. Optional so the report
   * handler still works in tests and on a Worker without the binding — a missing
   * bucket disables the takedown, it never fails the report.
   */
  BUCKET?: R2Bucket;
  REPORT_AUTOHIDE?: string;
  /**
   * Derived watch-history totals. Only account deletion touches it from this module,
   * and only to drop the erased user's entry — a five-minute cache is still a copy of
   * how much they watched, and leaving it to expire on its own would mean the erasure
   * completed while the data was still being served.
   */
  HISTORY_STATS_KV?: KVNamespace;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const noContent = () => new Response(null, { status: 204, headers: CORS });

const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FRIEND_ID_RE = /^[A-Z0-9]{12,40}$/;
const MAX_REPORT_CONTEXT = 1000;
const MAX_LEGACY_FRIEND_IDS = 200;
/**
 * Bounds [eraseAccount]'s post-delete engagement-recompute snapshot. `list_follows`
 * is capped at MAX_FOLLOWS (100) per follower by publicLists.ts's toggleEngagement,
 * but `public_list_likes` has no such cap, so the UNION that snapshot reads from
 * could otherwise return an unbounded number of (owner, list) pairs and turn one
 * erasure into a batch of thousands of UPDATEs. Exported for the test that proves
 * the LIMIT is really applied. A user past this leaves a handful of lists they
 * engaged with reading slightly high on `engagement` after erasure — a stale
 * ranking cache, not a compliance gap, since the follow/like rows themselves are
 * deleted regardless of this limit.
 */
export const MAX_ERASURE_RECOMPUTE = 200;
/** Keeps each recompute batch call to a manageable size regardless of the total. */
const ERASURE_RECOMPUTE_CHUNK = 50;
// `feed_comment` is a friend's comment as it appears on the Friend Feed, and is
// distinct from `comment` (a D1 title/episode comment) — they are moderated through
// different admin queues, so folding them together would hide one behind the other.
const REPORT_KINDS = new Set(["user", "profile", "comment", "comment_spoiler", "feed_comment", "picture"]);
const DEFAULT_REQUESTS_PER_HOUR = 20;

/** 128-bit opaque id, Crockford base32 — same shape as `users.id`. */
function newId(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Authenticate, or null. Every handler here starts with this. */
async function requireSession(req: Request, env: FriendsEnv, ctx?: ExecutionContext) {
  return resolveSession(req, env as any, ctx);
}

// ── Friend list ──────────────────────────────────────────────────────────────

interface FriendshipRow {
  user_a: string;
  user_b: string;
  state: string;
  requested_by: string;
  updated_at: number;
}

/**
 * Every friendship touching [userId], split into accepted / incoming / outgoing.
 * Two indexed reads (one per side of the canonical key), never a scan.
 */
export async function loadFriendships(env: FriendsEnv, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT user_a, user_b, state, requested_by, updated_at FROM friendships
      WHERE user_a = ? OR user_b = ?`,
  )
    .bind(userId, userId)
    .all<FriendshipRow>();

  const accepted: string[] = [];
  const incoming: string[] = [];
  const outgoing: string[] = [];
  for (const row of results ?? []) {
    const other = row.user_a === userId ? row.user_b : row.user_a;
    if (row.state === "accepted") accepted.push(other);
    else if (row.requested_by === userId) outgoing.push(other);
    else incoming.push(other);
  }
  return { accepted, incoming, outgoing };
}

/**
 * Current `push_friend_topic` for each of [ids], omitting anyone who has none.
 *
 * ⚠️ **A friend's push topic is MUTABLE and was previously cached forever.** It rotates
 * whenever its owner removes or blocks someone (`rotateKeys`), so the copy a friend took
 * from a card at pairing time goes stale the moment that happens. The client's only
 * refresh trigger was "my cached topic is BLANK", which catches a friend who had not
 * published yet and never catches one who has published a *different* topic since.
 *
 * Measured on two devices 2026-07-30: after a remove/re-add, one held `''` and the other
 * held a topic three rotations old, while D1 held the correct value for both. Directed
 * pushes between them were silently dead in one direction.
 *
 * Riding the graph restores what the relay's freshness call used to do for free — it was
 * re-delivered on every sync, so rotation self-healed, and nothing replaced that when the
 * relay was retired. Deliberately NOT folded into `loadFriendships`: seven callers use
 * that for authorization only and must not pay for a second query.
 */
export async function loadFriendTopics(
  env: FriendsEnv,
  ids: string[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(ids)].slice(0, MAX_TOPIC_LOOKUPS);
  if (wanted.length === 0) return {};
  const placeholders = wanted.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, push_friend_topic FROM users
      WHERE id IN (${placeholders}) AND status = 'active'`,
  )
    .bind(...wanted)
    .all<{ id: string; push_friend_topic: string | null }>();
  const out: Record<string, string> = {};
  for (const row of results ?? []) {
    if (row.push_friend_topic) out[row.id] = row.push_friend_topic;
  }
  return out;
}

/** GET /api/friends — accepted friends plus pending in both directions. */
export async function handleGetFriends(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const graph = await loadFriendships(env, session.userId);
  return json({ ...graph, topics: await loadFriendTopics(env, graph.accepted) });
}

// ── Requesting and accepting ─────────────────────────────────────────────────

/** Per-sender hourly cap. Rate limiting a *friend request* is an anti-harassment control. */
async function requestRateLimited(env: FriendsEnv, userId: string): Promise<boolean> {
  const limit = Number(env.FRIEND_REQUESTS_PER_HOUR ?? DEFAULT_REQUESTS_PER_HOUR);
  if (limit <= 0) return false;
  const since = Date.now() - 3600_000;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM friendships WHERE requested_by = ? AND created_at > ?",
  )
    .bind(userId, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= limit;
}

/**
 * POST /api/friends/request `{ userId }`.
 *
 * Accepting an existing incoming request is folded in here: if they already asked
 * you, asking back is an accept. Returns `{ state }` so the client knows which
 * happened.
 *
 * **A request to someone who has blocked you reports success and does nothing** —
 * anything else turns this endpoint into a block detector.
 */
export async function handleFriendRequest(
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
  notify?: (userId: string) => void,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const target = typeof payload?.userId === "string" ? payload.userId : "";
  if (!USER_ID_RE.test(target)) return json({ error: "invalid_payload" }, 400);
  if (target === session.userId) return json({ error: "invalid_payload" }, 400);

  // Silent no-op, deliberately indistinguishable from a delivered request.
  if (await isBlockedEitherWay(env, session.userId, target)) return json({ state: "pending" });

  const exists = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'")
    .bind(target)
    .first<{ id: string }>();
  if (!exists) return json({ error: "not_found" }, 404);

  const [a, b] = friendshipKey(session.userId, target);
  const current = await env.DB.prepare(
    "SELECT state, requested_by FROM friendships WHERE user_a = ? AND user_b = ?",
  )
    .bind(a, b)
    .first<{ state: string; requested_by: string }>();

  const now = Date.now();
  if (current?.state === "accepted") return json({ state: "accepted" });
  if (current?.state === "pending") {
    // They asked first — this is an accept. Asking again ourselves is a no-op.
    if (current.requested_by === session.userId) return json({ state: "pending" });
    await env.DB.prepare(
      "UPDATE friendships SET state = 'accepted', updated_at = ? WHERE user_a = ? AND user_b = ?",
    )
      .bind(now, a, b)
      .run();
    // They have been waiting on an answer since they asked.
    notify?.(target);
    return json({ state: "accepted" });
  }

  if (await requestRateLimited(env, session.userId)) return json({ error: "rate_limited" }, 429);
  await env.DB.prepare(
    `INSERT INTO friendships (user_a, user_b, state, requested_by, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(a, b, session.userId, now, now)
    .run();
  // **Wake the target, or nothing tells them a request exists.** Until pairing left the
  // E2EE inbox (2026-07-28) the sealed FRIEND_REQUEST did this as a side effect of
  // `handlePostInbox`. Deleting that send took the wake-up with it, and the request sat
  // in D1, correct and invisible, until the recipient's next scheduled sync — measured
  // on device the same day. The identical mistake was made with shared lists on
  // 2026-07-27; see the FCM note in `Documents and Resources/docs/agent-map/android/16-feature-social.md`.
  notify?.(target);
  return json({ state: "pending" });
}

/**
 * POST /api/friends/accept `{ userId }` — accept an incoming request.
 * 404 unless a pending request from that user actually exists, so this cannot be
 * used to force a friendship or to probe for one.
 */
export async function handleFriendAccept(
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
  notify?: (userId: string) => void,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const target = typeof payload?.userId === "string" ? payload.userId : "";
  if (!USER_ID_RE.test(target)) return json({ error: "invalid_payload" }, 400);
  if (await isBlockedEitherWay(env, session.userId, target)) return json({ error: "not_found" }, 404);

  const [a, b] = friendshipKey(session.userId, target);
  const result = await env.DB.prepare(
    `UPDATE friendships SET state = 'accepted', updated_at = ?
      WHERE user_a = ? AND user_b = ? AND state = 'pending' AND requested_by = ?`,
  )
    .bind(Date.now(), a, b, target)
    .run();
  if (!result.meta?.changes) return json({ error: "not_found" }, 404);
  // Only on a real transition — `changes` is 0 for a repeat accept, and notifying then
  // would re-wake the requester on every retry.
  notify?.(target);
  return json({ state: "accepted" });
}

/** DELETE /api/friends/{userId} — unfriend, or withdraw/decline a pending request. Idempotent. */
export async function handleFriendRemove(
  target: string,
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
  notify?: (userId: string) => void,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!USER_ID_RE.test(target)) return noContent();
  const [a, b] = friendshipKey(session.userId, target);
  const res = await env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b).run();
  if (res.meta?.changes) notify?.(target);
  return noContent();
}

// ── Blocking ─────────────────────────────────────────────────────────────────

/**
 * POST /api/blocks/{userId} — block, and drop any friendship in the same batch.
 *
 * This is the fix for the live safety gap: blocking used to be client-side and
 * eventually-consistent, so it only bit once the blocker's device rotated keys.
 * Now `canView` denies on the very next request, in both directions.
 */
export async function handleBlock(
  target: string,
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!USER_ID_RE.test(target) || target === session.userId) return json({ error: "invalid_payload" }, 400);

  // Snapshot who they were, BEFORE the friendship goes. A block record that cannot name
  // its target is unrenderable later: the local row is gone after a device wipe, and
  // `GET /api/profile/{userId}` is gated by `canView`, which fails on a blocked pair. So
  // the one thing that could name them is the one thing a block guarantees you cannot read.
  //
  // Read outside the batch and tolerated as null — a block must never fail because a name
  // lookup did. A snapshot, not a live join, so a later rename does not rewrite history.
  const who = await env.DB.prepare("SELECT display_name, avatar_id FROM profiles WHERE user_id = ?")
    .bind(target)
    .first<{ display_name: string | null; avatar_id: string | null }>()
    .catch(() => null);

  const [a, b] = friendshipKey(session.userId, target);
  await env.DB.batch([
    // OR REPLACE, not OR IGNORE: re-blocking someone should refresh the snapshot rather
    // than keep a name from the first time.
    env.DB
      .prepare(
        `INSERT INTO blocks (blocker_id, blocked_id, created_at, display_name, avatar_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(blocker_id, blocked_id) DO UPDATE SET
           display_name = excluded.display_name, avatar_id = excluded.avatar_id`,
      )
      .bind(session.userId, target, Date.now(), who?.display_name ?? null, who?.avatar_id ?? null),
    env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b),
  ]);
  return noContent();
}

/** DELETE /api/blocks/{userId} — unblock. Does NOT restore the friendship; that must be re-made. */
export async function handleUnblock(
  target: string,
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  await env.DB.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
    .bind(session.userId, target)
    .run();
  return noContent();
}

/** GET /api/blocks — who I have blocked. Never reveals who has blocked *me*. */
export async function handleGetBlocks(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  // `displayName` / `avatarId` are the snapshot taken at block time — the only way a
  // client that has been wiped can render this list at all. Empty for a row written before
  // migration 0011, which the client renders as an unnamed entry rather than hiding: a
  // block you cannot see is a block you cannot lift.
  const { results } = await env.DB.prepare(
    "SELECT blocked_id, created_at, display_name, avatar_id FROM blocks WHERE blocker_id = ? ORDER BY created_at DESC",
  )
    .bind(session.userId)
    .all<{ blocked_id: string; created_at: number; display_name: string | null; avatar_id: string | null }>();
  return json({
    blocked: (results ?? []).map((r) => ({
      userId: r.blocked_id,
      at: r.created_at,
      displayName: r.display_name ?? "",
      avatarId: r.avatar_id ?? "",
    })),
  });
}

// ── Reporting ────────────────────────────────────────────────────────────────

/**
 * POST /api/report `{ userId, kind, context? }` — file a moderation report.
 *
 * One open report per reporter/target/**kind**; repeats are folded in rather than
 * stacking, so a single user cannot inflate a target's report count. The kind is
 * part of that key deliberately: reporting someone's picture must not silently
 * swallow a later report about their behaviour, which is what happened while the
 * dedupe was on the pair alone.
 *
 * Replaces the relay's `POST /api/user/{friendId}/report`, which authenticated on a
 * bound read token rather than a session and keyed on the device `friendId`.
 */
export async function handleReport(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const target = typeof payload?.userId === "string" ? payload.userId : "";
  const kind = typeof payload?.kind === "string" ? payload.kind : "user";
  if (!USER_ID_RE.test(target) || target === session.userId) return json({ error: "invalid_payload" }, 400);
  if (!REPORT_KINDS.has(kind)) return json({ error: "invalid_payload" }, 400);
  const context =
    typeof payload?.context === "string" ? payload.context.trim().slice(0, MAX_REPORT_CONTEXT) : null;

  const existing = await env.DB.prepare(
    "SELECT id FROM reports WHERE reporter_id = ? AND target_id = ? AND kind = ? AND state = 'open'",
  )
    .bind(session.userId, target, kind)
    .first<{ id: string }>();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO reports (id, reporter_id, target_id, kind, context, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
      .bind(newId(), session.userId, target, kind, context, Date.now())
      .run();
  }

  if (kind === "picture") await maybeAutoHidePicture(env, target);
  return noContent();
}

/**
 * Hide a profile picture once enough **distinct** reporters have flagged it.
 *
 * Ported from the relay handler this replaced. It is the only automatic takedown in
 * the system, so losing it in the migration would have quietly removed an abuse
 * control rather than dead code.
 *
 * ⚠️ **Writes BOTH tombstones.** A picture is now reachable by two routes — the
 * account-keyed `/api/profile/{userId}/picture` and the legacy
 * `/api/user/{friendId}/picture` — and each checks its own key. Writing one and not
 * the other leaves the image up on the other route, which is this abuse control
 * silently not working rather than a cosmetic inconsistency. The legacy write goes
 * when the legacy route goes, not before.
 *
 * Best-effort by design: a Worker with no bucket means no takedown — but the report
 * itself is already recorded, and failing the request would lose the report to keep a
 * picture up. The account-keyed tombstone needs no device id, so every account is
 * coverable.
 */
async function maybeAutoHidePicture(env: FriendsEnv, targetUserId: string): Promise<void> {
  const bucket = env.BUCKET;
  if (!bucket) return;
  const threshold = Number(env.REPORT_AUTOHIDE ?? "3");
  if (!Number.isFinite(threshold) || threshold <= 0) return;

  // COUNT(DISTINCT ...) in SQL rather than listing rows: D1 bills rows SCANNED, and
  // idx_reports_pair covers this.
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_id = ? AND kind = 'picture' AND state = 'open'",
  )
    .bind(targetUserId)
    .first<{ n: number }>();
  if (!row || row.n < threshold) return;

  const body = JSON.stringify({ reason: "auto_report_threshold", at: Date.now() });
  const opts = { httpMetadata: { contentType: "application/json" } };
  await bucket.put(`_moderation/u/${targetUserId}.json`, body, opts);

  // The legacy `_moderation/{friend_id}.json` twin is gone with `users.friend_id`
  // (8c-3). It made the relay picture route return 410 for a taken-down photo; that
  // route is read-only and on its way out, and the account-keyed tombstone above is
  // what the account route checks.
}

// ── Bridging the existing device-identity pairings ───────────────────────────

// ── Friend cards (pairing off the E2EE inbox) ────────────────────────────────

/**
 * Fetch the published friend card for a device friendId, or null.
 *
 * Injected rather than imported so this module stays D1-only and therefore
 * testable without a bucket — the same reason `sync.ts` takes a `RelayLoader`.
 * Cards live in R2 and are written by the device that owns them.
 */
/**
 * [friendCode] is the account-keyed lookup and is preferred; [friendId] is the legacy
 * pointer, used only for an account that has not republished its card since the code
 * moved into D1. The second argument goes at step 8.
 */
export type CardLoader = (friendCode: string | null) => Promise<PublicCard | null>;

/**
 * Exactly the fields a local friend row needs, and nothing else.
 *
 * This is the same data `GET /api/friendcode/{code}` already hands to anyone
 * holding the code, `feedReadToken` included — that token is the owner's
 * rotatable feed-read capability and living in the published card is what makes
 * pairing work at all. An explicit allow-list rather than a pass-through,
 * because the stored card is client-written.
 */
export interface PublicCard {
  friendId: string;
  displayName: string;
  avatarId: string;
  borderId: string;
  pictureUrl: string;
  publicKeyset: string;
  feedReadToken: string;
}

/**
 * A card plus the fields that come from D1 rather than the R2 blob.
 *
 * [friendTopic] is how a friend learns which FCM topic to subscribe to for this
 * person's ambient updates. It used to travel **sealed inside `access.json`**, wrapped
 * to each friend's public keyset — which is why step 2 could move the push *write* onto
 * the account without noticing the *distribution* was somewhere else entirely.
 *
 * The two topics are asymmetric, and that is what hid the gap: `selfTopic` is subscribed
 * only by the owner's own devices, which derive it from `socialSelfKey` and need no
 * handout at all. `friendTopic` has to reach other people.
 *
 * No new exposure to the server: `users.push_friend_topic` has been a plaintext column
 * since step 2. This only hands it to accepted friends, who are the intended audience,
 * and it rides the `users` query this handler already runs.
 */
/**
 * [isPremiere] is the one field here the SERVER vouches for. Everything else on the
 * card is client-published and inherits that trust level; this is read from
 * `users.premiere_until`, which no client can write. See premiere.ts.
 */
export type FriendCardWithTopic = PublicCard & {
  userId: string;
  friendTopic: string;
  isPremiere: boolean;
};

const MAX_CARD_LOOKUPS = 25;

/** Cap on `loadFriendTopics`. Higher than the card cap: it is one cheap indexed
 *  read of a single column, and it must cover a whole accepted list, not a page. */
const MAX_TOPIC_LOOKUPS = 200;

/**
 * POST /api/friends/cards `{ userIds: [...] }` — the public cards for people you
 * already have a friendship edge with.
 *
 * This is what lets pairing leave the E2EE inbox. `GET /api/friends` answers with
 * bare `users.id` values, and a local friend row needs a display name, an avatar and
 * above all a **public keyset** — everything E2EE is sealed to it. Without this the
 * client can see that it has an incoming request but can neither render nor answer it.
 *
 * **Edge-gated, and that is the whole security argument.** A card is already public
 * to anyone holding its friend *code*, which is a capability the owner chose to hand
 * out. A `users.id` is not — it appears in feeds and graphs. Serving cards by id
 * without requiring an edge would turn every signed-in session into a card-enumeration
 * oracle over the whole user base. Blocked pairs are excluded for the same reason
 * everything else here excludes them.
 *
 * Unknown ids, ids with no edge, and users who have never published a card are all
 * **omitted silently** rather than erroring: distinguishing them would answer
 * "does this account exist" for an arbitrary id, which is rule 1 of this file.
 */
export async function handleGetFriendCards(
  req: Request,
  env: FriendsEnv,
  loadCard: CardLoader,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const raw = Array.isArray(payload?.userIds) ? payload!.userIds : null;
  if (!raw) return json({ error: "invalid_payload" }, 400);

  const wanted = [...new Set(raw.filter((v): v is string => typeof v === "string" && USER_ID_RE.test(v)))]
    .filter((id) => id !== session.userId)
    .slice(0, MAX_CARD_LOOKUPS);
  if (wanted.length === 0) return json({ cards: [] });

  // One query for the edges, one for the friendIds — never one round trip per id.
  const { accepted, incoming, outgoing } = await loadFriendships(env, session.userId);
  const related = new Set([...accepted, ...incoming, ...outgoing]);
  const allowed = wanted.filter((id) => related.has(id));
  if (allowed.length === 0) return json({ cards: [] });

  const placeholders = allowed.map(() => "?").join(",");
  // ⚠️ `AND friend_id IS NOT NULL` was here and is gone (9a). It made an account that
  // never claimed a device friendId INVISIBLE to its own friends: no card came back, so
  // `applyServerGraph` dropped the edge at `cards[userId] ?? continue` and an accepted
  // friendship on both sides rendered as nothing, with no error anywhere. Measured
  // 2026-07-30: 1 of 5 active accounts was in exactly that state. The column is on its
  // way out (8c-3) and was never what authorised the card — the friendship edge is.
  const { results } = await env.DB.prepare(
    `SELECT id, friend_code, push_friend_topic, premiere_until, premiere_comp_until, picture_animated
       FROM users
      WHERE id IN (${placeholders}) AND status = 'active'`,
  )
    .bind(...allowed)
    .all<{
      id: string;
      friend_code: string | null;
      push_friend_topic: string | null;
      premiere_until: number | null;
      premiere_comp_until: number | null;
      picture_animated: number | null;
    }>();

  const cards: FriendCardWithTopic[] = [];
  for (const row of results ?? []) {
    if (await isBlockedEitherWay(env, session.userId, row.id)) continue;
    // The code rides the query above, so the common path costs no extra read.
    const card = await loadCard(row.friend_code ?? null);
    // ✅ CLOSED 2026-07-30. The claim-check that stood here went with `users.friend_id`
    // (8c-3), and for a while nothing verified a card's self-declared `friendId` — a
    // hostile client could publish one asserting somebody else's.
    //
    // The fix named here was "the client stops trusting the card's friendId at all",
    // and that is now true. The Android client reads `userId` for every decision the
    // friendId used to serve: which row a card merges into, which row a push topic is
    // written to, the block check on a scanned code, and the pairing self-check. The
    // column it could collide with is gone too (Room v26).
    //
    // ⚠️ `friendId` is still PRESENT on the card this returns, because it is spread
    // from the published card and clients still publish their own. It is inert — no
    // reader on either side — and it leaves the wire when the publish side does, with
    // the device identity handle. Do not re-introduce a reader for it.
    if (!card) continue;
    // ⚠️ `isPremiere` goes AFTER the spread, deliberately. `card` is the client-written
    // R2 blob; a key placed before the spread could be overridden by whatever the card
    // author published. This is the one field here the server vouches for, and it rides
    // the `users` query above, so it costs no extra read.
    cards.push({
      userId: row.id,
      ...card,
      friendTopic: row.push_friend_topic ?? "",
      isPremiere: isPremiere(row),
      // Also after the spread: an animated avatar stops being served when the
      // subscription that paid for it ends, and the card's own copy of the URL is
      // client-written so it cannot be trusted to reflect that.
      pictureUrl: visiblePictureUrl(card.pictureUrl, row),
      borderId: visibleBorderId(card.borderId, row),
    });
  }
  return json({ cards });
}

// ── Account deletion (§9b — legal requirement) ───────────────────────────────

/**
 * Erase account [id] from R2, D1 and KV. **The only implementation of erasure.**
 *
 * Children before parents, so a failure part-way leaves the account recoverable
 * rather than orphaned. GDPR erasure has to actually erase: a stale `users` row
 * with a live `friendships` edge is a failure, not a partial success.
 *
 * **Every table holding this user's data must appear below.** A new table that does
 * not is a silent compliance gap — nothing fails, nothing logs, and the data simply
 * survives an erasure the user was told had happened. `shared_lists`, `match_requests`
 * and `match_payloads` were exactly that until they were added here.
 *
 * The caller is still responsible for the Firebase Auth user and the relay purge —
 * both live outside D1, and both must happen after this returns.
 *
 * ⚠️ Called by BOTH the self-service route below and the admin Users panel
 * (`usersAdmin.ts`). It is a separate function precisely so there is one erasure batch
 * rather than two: a second implementation would drift from this one, and the way it
 * would drift is by omitting a table — which fails silently and looks like success.
 * Add tables here, never at a call site.
 *
 * Takes no session: authorization belongs to the caller, which is what lets an admin
 * erase an account whose session it does not hold.
 */
export async function eraseAccount(env: FriendsEnv, id: string): Promise<void> {
  // The account-keyed objects that live in R2, not D1, so the batch below cannot reach
  // them. Done BEFORE the batch: once the `users` row is gone, nothing can name them —
  // the friend code in particular is only findable through that row — and they become
  // unreachable data no erasure can ever collect.
  if (env.BUCKET) {
    await env.BUCKET.delete(`accounts/${id}/picture.jpg`);
    await env.BUCKET.delete(`accounts/${id}/picture-meta.json`);
    await env.BUCKET.delete(`_moderation/u/${id}.json`);
    // ⚠️ The watch history itself. Since migration 0020 these objects ARE the data —
    // every title the person ever watched and every rating they gave. D1 holds only a
    // pointer row, so an erasure that cleared D1 and left these behind would delete the
    // index to the data and keep the data, which is worse than doing nothing: it would
    // look complete and be a total failure. The public slice goes too — it is a copy.
    await env.BUCKET.delete(`history/${id}.json`);
    await env.BUCKET.delete(`profile/${id}/recent.json`);
    // ⚠️ Sticker cut-outs are deliberately NOT erased here, and that is not an omission.
    //
    // A sticker is cut from a public promotional image and published for everyone to
    // use, so it is community content rather than personal data — the same standing as a
    // contribution that outlives the contributor. They are stored under a flat
    // `stickers/{id}` namespace with no user id in the key or the URL precisely so that
    // surviving an erasure does not leave a deleted account's identifier resolvable.
    // See src/stickers.ts.
    // The public friend card. Leaving it behind keeps a deleted person's name, avatar
    // and picture URL resolvable by anyone still holding their code.
    const own = await env.DB.prepare("SELECT friend_code FROM users WHERE id = ?")
      .bind(id)
      .first<{ friend_code: string | null }>();
    if (own?.friend_code) await env.BUCKET.delete(`fc/${own.friend_code}.json`);
  }

  // The lists this account followed or liked, collected BEFORE the batch below
  // deletes those rows. The batch clears `list_follows`/`public_list_likes` in the
  // `user_id` direction too — this account's own follows/likes of OTHER people's
  // lists, not just its own list's followers — and those lists' `engagement` is a
  // cache nothing else in this worker recomputes on a schedule. Left alone, an
  // owner's ranking would stay permanently inflated by a follower who no longer
  // exists. Bounded by MAX_ERASURE_RECOMPUTE — see its comment for why.
  const engaged = await env.DB.prepare(
    `SELECT owner_id, list_id FROM list_follows WHERE user_id = ?
     UNION
     SELECT owner_id, list_id FROM public_list_likes WHERE user_id = ?
     LIMIT ?`,
  )
    .bind(id, id, MAX_ERASURE_RECOMPUTE)
    .all<{ owner_id: string; list_id: string }>();

  // ⚠️ **Retract what this account published upstream, BEFORE the batch drops the refs.**
  //
  // `archive_comment_refs` is the only record of which commsuni.tv rows are ours; once
  // it is gone the published text is live in every partner app with nothing left that
  // can name it. So the teardown is queued first, keyed by the archive id it carries in
  // its own payload rather than by a lookup that will no longer resolve.
  //
  // Throttled by the outbox's own bounded drain — this enqueues rows, it does not make
  // calls, so a prolific account does not turn one deletion into hundreds of subrequests
  // on this request.
  //
  // ⚠️ Pending PUBLISH work is deleted while pending DELETE work is kept. They look like
  // the same table but mean opposite things: an unsent `comment` row still holds this
  // person's text and must never go out after they asked to be erased, whereas the
  // `delete` rows ARE the erasure. Dropping the lot would leave their published comments
  // live for ever.
  const published = await env.DB
    .prepare("SELECT archive_id FROM archive_comment_refs WHERE author_id = ?")
    .bind(id)
    .all<{ archive_id: string }>()
    .catch(() => ({ results: [] as { archive_id: string }[] }));

  if ((published.results ?? []).length > 0) {
    await env.DB
      .batch(
        (published.results ?? []).map((r) =>
          env.DB
            .prepare(
              `INSERT INTO archive_outbox (id, kind, idempotency_key, actor_user_id, payload, attempts, next_at, created_at)
               VALUES (?, 'delete', ?, ?, ?, 0, ?, ?)`,
            )
            .bind(
              crypto.randomUUID(),
              `erase:${r.archive_id}`,
              id,
              JSON.stringify({ archiveId: r.archive_id }),
              Date.now(),
              Date.now(),
            ),
        ),
      )
      .catch(() => {});
  }

  await env.DB
    .prepare("DELETE FROM archive_outbox WHERE actor_user_id = ? AND kind IN ('comment','reply')")
    .bind(id)
    .run()
    .catch(() => {});

  await env.DB.batch([
    // Sealed match payloads first: they are children of match_requests, and a blob
    // outliving the handshake that addressed it is unreachable data nobody can delete.
    env.DB
      .prepare(
        `DELETE FROM match_payloads WHERE request_id IN
           (SELECT id FROM match_requests WHERE requester_id = ? OR target_id = ?)`,
      )
      .bind(id, id),
    env.DB.prepare("DELETE FROM match_requests WHERE requester_id = ? OR target_id = ?").bind(id, id),
    // Both directions. A list you sent is as much your data as one you received, and
    // leaving the sender's copy behind would keep your content readable after erasure.
    env.DB.prepare("DELETE FROM shared_lists WHERE sender_id = ? OR recipient_id = ?").bind(id, id),
    // Your activity feed. Erasing the account while leaving these would keep every
    // title you watched readable by anyone still friends with the deleted row.
    env.DB.prepare("DELETE FROM feed_events WHERE author_id = ?").bind(id),
    // Comments, and the tables hanging off them. Order matters: the children go
    // first, because once `comments` is gone nothing can name the rows that
    // pointed at it and they become unreachable data no erasure can ever reach.
    //
    // Reactions are deleted in BOTH directions — the reactions you made on other
    // people's comments are your data too. Reaction and comment counts are derived
    // from these rows on read, so removing the rows removes them from every total
    // automatically; there is no counter left to adjust.
    env.DB.prepare("DELETE FROM comment_reactions WHERE user_id = ?").bind(id),
    env.DB
      .prepare("DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM comments WHERE author_id = ?)")
      .bind(id),
    env.DB
      .prepare("DELETE FROM comment_translations WHERE comment_id IN (SELECT id FROM comments WHERE author_id = ?)")
      .bind(id),
    env.DB.prepare("DELETE FROM comments WHERE author_id = ?").bind(id),
    // Episode poll votes. This row is the ONLY thing linking a person to what they
    // voted, so removing it is what makes the vote anonymous rather than merely
    // unattributed. Poll totals are now derived from these rows on read, so deleting
    // them also drops this account's contribution from every total automatically —
    // no separate counter to unpick.
    env.DB.prepare("DELETE FROM episode_votes WHERE user_id = ?").bind(id),
    // Watch history and the two private rating tables (migration 0018).
    //
    // ⚠️ A HARD delete, even though `watch_history` has a `deleted_at` tombstone
    // column. The tombstone exists so a per-event deletion can PROPAGATE to the
    // user's other devices; using it here would leave every title they ever watched
    // sitting in the table under an erasure they were told had completed. Account
    // deletion has no other device to inform — the account is gone.
    //
    // `episode_ratings` is the user's PRIVATE per-episode record and goes with them.
    // It is not the same table as `episode_votes` above, which is the public poll;
    // both are deleted, for different reasons.
    // Watch history is ONE row here now — the pointer. The events themselves live in an
    // R2 document, deleted above with the other account-keyed objects. `watch_history`,
    // `user_ratings` and `episode_ratings` are gone as tables (migration 0020), and
    // `sync_cursors` before them (0019, written every pass and read by nothing).
    env.DB.prepare("DELETE FROM history_meta WHERE user_id = ?").bind(id),
    // Phase 3 integration state. `pending_integration_push` can hold event ids describing
    // what this person watched, so it is user data, not just bookkeeping.
    env.DB.prepare("DELETE FROM pending_integration_push WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM user_integrations WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?").bind(id, id),
    env.DB.prepare("DELETE FROM friendships WHERE user_a = ? OR user_b = ?").bind(id, id),
    // The commsuni.tv layer, in BOTH id directions.
    //
    // ⚠️ `archive_blocks` is deleted as blocker AND as the blocked author. Our own
    // users can be mirrored upstream, so this account's id can appear in `author_id`
    // as somebody else's block — leaving that behind keeps a record of a deleted
    // account in another user's row.
    //
    // ⚠️ The upstream teardown is enqueued BEFORE the refs are dropped, in the block
    // just above this batch: once `archive_comment_refs` is gone nothing can name the
    // published rows and they are unretractable for ever. Order is the whole game
    // here — the same reason comment children are deleted before `comments`.
    env.DB.prepare("DELETE FROM archive_comment_refs WHERE author_id = ?").bind(id),
    env.DB.prepare("DELETE FROM archive_blocks WHERE blocker_id = ? OR author_id = ?").bind(id, id),
    env.DB.prepare("DELETE FROM archive_identity WHERE user_id = ?").bind(id),
    // ⚠️ `reports` is NOT deleted here, in EITHER direction, and both halves are
    // deliberate.
    //
    // Reports this account FILED stay because the privacy policy commits to it —
    // "Reports you filed about other people or content are kept as part of our safety
    // record" — and because deleting them opens the obvious hole: report someone for
    // abuse, delete your own account, and the evidence goes with it. This used to run
    // `DELETE FROM reports WHERE reporter_id = ?`, which did exactly that; the code and
    // the policy disagreed and the code was the wrong one. Found by auditing the erasure
    // batch against the live schema, 2026-07-31.
    //
    // Reports FILED ABOUT this account stay for the same safety reason, and that is now
    // disclosed in the policy too — it holds `body_snapshot`, a copy of the reported
    // content, so silence about it was the one real omission in an otherwise precise
    // deletion promise.
    //
    // Both leave a dangling id pointing at a row in `users` that no longer exists. That
    // is already true of every retained `target_id` and is what a safety record is for.
    // Per-device telemetry. `telemetry_daily` is deliberately NOT touched: it holds
    // aggregate counts and no user ids, so there is nothing in it to erase — and
    // subtracting this account from a historical total would corrupt the series
    // rather than protect anyone.
    env.DB.prepare("DELETE FROM user_telemetry WHERE user_id = ?").bind(id),
    // Portable preferences and achievements (migration 0024). `user_settings` holds the
    // person's gender alongside their theme and viewing preferences, and
    // `user_achievements` is a record of their behaviour over years — both are as much
    // "their data" as the profile row two lines below, and neither is reachable by any
    // other cleanup path once `users` is gone.
    // In-app feedback this account sent (migration 0025). Deleted, unlike `reports`
    // above: a report is a safety record the privacy policy commits to keeping, and
    // feedback is just this person's own words about the app. Anonymous submissions
    // carry no `user_id` and are unreachable from here by construction.
    env.DB.prepare("DELETE FROM feedback WHERE user_id = ?").bind(id),
    // One Take, the daily puzzle (migration 0032). The per-day rows are a record of when
    // this person played and how well, and the rollup is years of that summarised.
    //
    // `daily_game_anon_distribution` is deliberately NOT here, for the same reason as
    // `telemetry_daily` above: it holds aggregate counts and no user ids, so there is
    // nothing in it to erase. It also cannot double-count this account — signed-in
    // results are counted by GROUPING `daily_game_results` on read rather than from a
    // counter, precisely so deleting the rows below removes this person from every
    // historical distribution automatically, with nothing left to unpick.
    env.DB.prepare("DELETE FROM daily_game_results WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM daily_game_stats WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM user_achievements WHERE user_id = ?").bind(id),
    // Public lists (0039). Six statements, not four: `list_follows` and
    // `public_list_likes` are keyed on TWO people — `user_id`, whoever followed or
    // liked, and `owner_id`, whose list it points at — so this account's own rows AND
    // other people's rows pointing at its (now-deleted) lists both have to go. Leaving
    // the `owner_id` half behind would keep a surviving user subscribed to a list whose
    // owner no longer exists.
    env.DB.prepare("DELETE FROM public_lists WHERE owner_id = ?").bind(id),
    env.DB.prepare("DELETE FROM public_list_tags WHERE owner_id = ?").bind(id),
    env.DB.prepare("DELETE FROM list_follows WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM list_follows WHERE owner_id = ?").bind(id),
    env.DB.prepare("DELETE FROM public_list_likes WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM public_list_likes WHERE owner_id = ?").bind(id),
    env.DB.prepare("DELETE FROM profile_stats WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM profiles WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM identities WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);

  // Recompute the lists this now-erased account had followed or liked, from the
  // `engaged` snapshot taken before the batch above deleted the rows that fed those
  // caches. A list this account owned itself needs no recompute — its `public_lists`
  // row was just deleted above — and an UPDATE against a missing row is a no-op.
  //
  // Chunked, and best-effort like the HISTORY_STATS_KV delete below: by this point
  // the delete batch has already committed, so erasure has already succeeded. A
  // failure here must not turn that success into a thrown error the caller turns
  // into a 500 the client retries — a retry's SELECT above would find the
  // list_follows/public_list_likes rows already gone and snapshot nothing, leaving
  // these caches inflated permanently instead of eventually catching up. Erasure
  // completing matters more than a ranking cache being exact.
  const pairs = engaged.results ?? [];
  for (let i = 0; i < pairs.length; i += ERASURE_RECOMPUTE_CHUNK) {
    const chunk = pairs.slice(i, i + ERASURE_RECOMPUTE_CHUNK);
    await env.DB.batch(chunk.map((p) => recomputeEngagement(env, p.owner_id, p.list_id))).catch(() => {});
  }

  // The derived-stats cache. Reproducible from `watch_history` and therefore not a
  // source of truth — but it is a copy of this account's totals, and it must not
  // outlive the rows it was derived from. Best-effort: a KV failure here must not
  // turn a completed D1 erasure into an error the client will retry.
  await env.HISTORY_STATS_KV?.delete(`history:stats:${id}`).catch(() => {});
}

/**
 * DELETE /api/me/account — erase the CALLER's own account.
 *
 * Nothing but session resolution: the erasure itself is [eraseAccount], shared with the
 * admin panel so both paths delete exactly the same set.
 */
export async function handleDeleteAccount(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  await eraseAccount(env, session.userId);
  return noContent();
}

export { areFriends };
