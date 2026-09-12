// ── Choose Together invites, server-side ─────────────────────────────────────
// "Come and pick something with us." A directed, friends-only invite carrying a
// live session code, so a friend can be pulled into a room without anyone having
// to read six characters down a phone.
//
// ## Why this is not a match request
//
// `match.ts` carries a sealed taste profile and a retention term, and accepting it
// means "compare what we have watched". This carries a room code, and accepting it
// means "open that room now". They look alike from a distance — both are directed,
// both are friends-only, both end in an accept — and sharing a table would have
// made every reader branch on which kind of thing a row was. They are separate.
//
// ## What the server can see
//
// Who invited whom, to which room, and when. There is nothing else in it: the
// deck, the votes and the taste blends all live in the Durable Object, and none of
// them travel through here.
//
// ## ⚠️ The block rule from friends.ts applies verbatim
//
// Inviting someone who has blocked you returns the SAME body as a delivered invite
// and creates nothing. Any other behaviour turns this endpoint into a block
// detector, which is the single easiest thing here to get wrong.
//
// ## ⚠️ An invite can outlive its room
//
// A session is a Durable Object that deletes itself after two idle hours, and
// nothing tells this table when that happens. A pending invite may therefore point
// at a room that no longer exists — the client finds out when it tries to join,
// exactly as it would from a link someone sent yesterday. Do not add a liveness
// check here: it would mean a D1 row reaching into a DO on every inbox read.

import { areFriends, isBlockedEitherWay } from "./authz";
import { resolveSession } from "./auth";

export interface WatchInvitesEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
}

/** See `lists.ts` — injected for the same reason, and load-bearing for the same one. */
export type Notifier = (userId: string) => void;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const noContent = () => new Response(null, { status: 204, headers: CORS });

const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INVITE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{8,40}$/;

/** The session alphabet, spelled out: Crockford base32 minus I, L, O and U. */
const CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

/** Enough to show an inbox; a room nobody joined in that many invites is not the problem. */
const INVITE_LIMIT = 30;

/** Older than this and the room is certainly gone — `IDLE_MS` in groupWatch.ts. */
const INVITE_TTL_MS = 2 * 60 * 60 * 1000;

interface InviteRow {
  id: string;
  sender_id: string;
  code: string;
  created_at: number;
  state: string;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * `POST /api/watch/invite` `{ id, recipientId, code }`
 *
 * ⚠️ [id] is minted by the SENDER, as a shared list's is, so a retry after a
 * dropped response is the same invite rather than a second one in the inbox.
 */
export async function handleWatchInvite(
  req: Request,
  env: WatchInvitesEnv,
  ctx?: ExecutionContext,
  notify?: Notifier,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const payload = await readBody(req);
  const id = str(payload?.id);
  const recipient = str(payload?.recipientId);
  const code = str(payload?.code).toUpperCase();

  if (!INVITE_ID_RE.test(id) || !USER_ID_RE.test(recipient) || !CODE_RE.test(code)) {
    return json({ error: "invalid_payload" }, 400);
  }
  if (recipient === session.userId) return json({ error: "invalid_payload" }, 400);

  // Silent no-op, deliberately indistinguishable from a delivered invite.
  if (await isBlockedEitherWay(env as any, session.userId, recipient)) return json({ id });
  // A directed message: a non-friend must not be able to address you at all.
  if (!(await areFriends(env as any, session.userId, recipient))) return json({ error: "forbidden" }, 403);

  // ⚠️ DO NOTHING on conflict rather than resetting the state: an invite to this
  // room that the recipient already declined must stay declined. A new room from
  // the same person is a different code, so it is a new row and does arrive.
  await env.DB.prepare(
    `INSERT INTO watch_invites (id, sender_id, recipient_id, code, created_at, state)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(sender_id, recipient_id, code) DO NOTHING`,
  )
    .bind(id, session.userId, recipient, code, Date.now())
    .run();

  // Not reached by the block branch above: waking someone's devices for an invite
  // that was never created would be both pointless and a way to sense a block.
  notify?.(recipient);
  return json({ id });
}

/**
 * `GET /api/watch/invites` — what is waiting for me.
 *
 * ⚠️ Pending only, and only from the last two hours. An invite older than the
 * session's own idle timeout cannot still point at a live room, and an inbox full
 * of dead rooms is worse than an empty one.
 */
export async function handleGetWatchInvites(
  req: Request,
  env: WatchInvitesEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const { results } = await env.DB.prepare(
    `SELECT id, sender_id, code, created_at, state
       FROM watch_invites
      WHERE recipient_id = ? AND state = 'pending' AND created_at > ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(session.userId, Date.now() - INVITE_TTL_MS, INVITE_LIMIT)
    .all<InviteRow>();

  return json({
    invites: (results ?? []).map((row) => ({
      id: row.id,
      senderId: row.sender_id,
      code: row.code,
      createdAt: row.created_at,
    })),
  });
}

/**
 * `POST /api/watch/invites/{id}/accept` — I am on my way.
 *
 * Returns the code, so the client has the room without a second round trip, and
 * so an accept that raced a decline cannot open a room the recipient just refused.
 *
 * Scoped to the recipient in the WHERE clause rather than by reading the row
 * first: a caller who is not the recipient changes nothing and gets the same 404
 * an unknown id gets. Answering 403 would confirm the id exists.
 */
export async function handleAcceptWatchInvite(
  id: string,
  req: Request,
  env: WatchInvitesEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const row = await env.DB.prepare(
    "SELECT code, state FROM watch_invites WHERE id = ? AND recipient_id = ?",
  )
    .bind(id, session.userId)
    .first<{ code: string; state: string }>();
  if (!row) return json({ error: "not_found" }, 404);
  if (row.state === "declined") return json({ error: "declined" }, 409);

  // Idempotent: accepting twice is the same answer, and the code is what matters.
  await env.DB.prepare("UPDATE watch_invites SET state = 'accepted' WHERE id = ? AND recipient_id = ?")
    .bind(id, session.userId)
    .run();
  return json({ code: row.code });
}

/**
 * `DELETE /api/watch/invites/{id}` — decline as the recipient, or withdraw as the
 * sender. 204 even for an unknown id, so it cannot be used to probe which exist.
 *
 * ⚠️ The recipient's decline is a STATE, not a delete: the row is what stops the
 * same room being offered again on the sender's next tap. The sender withdrawing
 * removes it outright, because there is then nothing left to re-offer.
 */
export async function handleDeclineWatchInvite(
  id: string,
  req: Request,
  env: WatchInvitesEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  await env.DB.prepare(
    "UPDATE watch_invites SET state = 'declined' WHERE id = ? AND recipient_id = ? AND state = 'pending'",
  )
    .bind(id, session.userId)
    .run();
  await env.DB.prepare("DELETE FROM watch_invites WHERE id = ? AND sender_id = ?")
    .bind(id, session.userId)
    .run();
  return noContent();
}
