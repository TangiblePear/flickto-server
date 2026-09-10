// ── Group Watch: one deck, up to five people, live ───────────────────────────
//
// A session is a room with a short code. Someone starts one, shares the link or a QR, and
// everyone swipes the SAME ranked deck while their agreement surfaces the instant it
// happens. Participants can be app users or a browser with no account at all.
//
// ## Why this is a Durable Object and nothing else in this worker is
//
// Everything else here is request/response over R2 or D1. This is the one feature where
// several people act on one shared thing at the same time and each needs to see the others
// immediately. Polling that costs one Worker invocation per client per tick — five people
// on a 2s timer for ten minutes is ~1,500 requests for ONE session, against a 100k/day
// allowance shared with /api/sync, comments and friends. A socket sends only on change: the
// same session is a few hundred messages. Realtime here is cheaper than polling, not dearer.
//
// ## ⚠️ Hibernation means in-memory state does not exist
//
// Sockets are accepted with `ctx.acceptWebSocket`, so the runtime may evict this object
// between messages and rebuild it on the next one. Anything worth keeping lives in
// `ctx.storage`; anything held in a field is a bug that will only show up under load, which
// is the worst way to find it. The one exception is the socket list itself, which the
// runtime hands back via `ctx.getWebSockets()`.
//
// ## ⚠️ This is NOT end-to-end encrypted, unlike Friend Match
//
// `match.ts` explains why that one can be: "a match is exactly two people, fixed at accept
// time — no audience to rotate". A join link is a mutable audience by definition, which is
// the same reason comments dropped E2EE. Taste payloads here are readable by the server.
// That is a product decision (owner, 2026-09-10) and it must be disclosed on the join
// screen — do not quietly widen what is sent on the strength of it.
//
// ## ⚠️ A participant cannot be blocked, by construction
//
// The same trap `matchAdhoc.ts` documents, with a bigger audience. A guest has no stable
// identity, so there is nothing to block. The mitigations are structural and are the reason
// for the caps below: a host-held code, a hard participant limit, no free text anywhere in
// the protocol, and a session that deletes itself.

/** Live state lives here, keyed inside one Durable Object per session. */
export interface GroupWatchEnv {
  GROUP_SESSION: DurableObjectNamespace;
  BUCKET: R2Bucket;
  /** Sessions created per IP per hour. Unset ⇒ [DEFAULT_SESSIONS_PER_HOUR]. */
  GROUP_WATCH_PER_HOUR?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

/**
 * Crockford base32: digits plus letters, MINUS I, L, O and U.
 *
 * ⚠️ It is not "no vowels" — A and E are in the set. What it drops is the characters a
 * person confuses when reading a code aloud or typing it from a screen: I and L for 1,
 * O for 0. U is dropped separately, to make an accidental obscenity less likely. That
 * matters more here than for an adhoc token, which is never read by a human.
 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;
export const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/**
 * ⚠️ Five is a product cap, not a technical one, and the scoring is why. Agreement is a
 * geometric mean across everyone (`ScoringEngine.scoreCatalog`), so every extra person
 * makes a shared answer strictly harder to reach. Past about five the top score collapses
 * toward zero and the deck stops looking like recommendations.
 */
export const MAX_PARTICIPANTS = 5;

/** Long enough to lose an evening to, short enough that a forgotten tab is not immortal. */
export const IDLE_MS = 2 * 60 * 60 * 1000;

const MAX_NAME_LENGTH = 24;

/**
 * Cap on one participant's taste payload.
 *
 * ⚠️ A real `PartnerProfile` is ~15 KB (`WATCHED_SHARE_LIMIT` is 5000 tmdbIds), so this is
 * an abuse ceiling, not a working size — the same reasoning as `matchAdhoc.ts`'s
 * `MAX_HALF_BYTES`. It is deliberately well under Durable Object storage's 128 KiB
 * per-value limit: a payload that squeezed past this check would then fail the `put`, and a
 * write that throws mid-session is far harder to diagnose than a refusal at the door.
 */
const MAX_PROFILE_BYTES = 96 * 1024;
const MAX_DECK = 500;
const DEFAULT_SESSIONS_PER_HOUR = 20;

type SessionState = "lobby" | "swiping" | "ended";

interface SessionMeta {
  code: string;
  hostId: string;
  createdAt: number;
  lastActivityAt: number;
  state: SessionState;
  /** Set once, when the host starts. Everyone swipes this exact order. */
  deck: number[];
}

interface Participant {
  id: string;
  name: string;
  joinedAt: number;
  isHost: boolean;
}

/** What a socket carries across hibernation. `ctx.storage` holds everything else. */
interface SocketAttachment {
  participantId: string;
}

function mintId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function mintCode(): string {
  return mintId(CODE_LENGTH);
}

/**
 * ⚠️ Names are the ONLY free-form text in this protocol, and that is deliberate — a chat box
 * would be an unmoderated surface reachable by a link. Stripped of control characters and
 * hard-capped so a name cannot be used as a message channel.
 */
function cleanName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const stripped = s.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return (stripped || "Guest").slice(0, MAX_NAME_LENGTH);
}

export class GroupSession implements DurableObject {
  constructor(
    private ctx: DurableObjectState,
    private env: GroupWatchEnv,
  ) {}

  // ── Storage helpers. Everything survives hibernation or it does not exist. ──

  private async meta(): Promise<SessionMeta | null> {
    return (await this.ctx.storage.get<SessionMeta>("meta")) ?? null;
  }

  private async putMeta(m: SessionMeta): Promise<void> {
    await this.ctx.storage.put("meta", m);
  }

  private async participants(): Promise<Participant[]> {
    const map = await this.ctx.storage.list<Participant>({ prefix: "p:" });
    return [...map.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  private async votesOf(participantId: string): Promise<Record<string, boolean>> {
    return (await this.ctx.storage.get<Record<string, boolean>>(`v:${participantId}`)) ?? {};
  }

  /**
   * Push the idle deadline out and re-arm the alarm.
   *
   * ⚠️ An alarm, never a cron. The account is at its five-cron ceiling (share-api every 5
   * minutes, scoring 12h, proxy twice daily, daily-ai), and a per-session lifetime is
   * exactly what an alarm is for — it costs nothing while the session is quiet.
   */
  private async touch(m: SessionMeta): Promise<void> {
    m.lastActivityAt = Date.now();
    await this.putMeta(m);
    await this.ctx.storage.setAlarm(m.lastActivityAt + IDLE_MS);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = url.pathname.split("/").pop();

    if (action === "create") return this.create(req);
    if (action === "meta") return this.metaResponse();
    if (action === "ws") return this.socket(req, url);
    return json({ error: "not_found" }, 404);
  }

  /** Idempotent-by-failure: a code already in use is reported so the caller can re-mint. */
  private async create(req: Request): Promise<Response> {
    if (await this.meta()) return json({ error: "code_taken" }, 409);

    const body = (await req.json().catch(() => ({}))) as { code?: string; hostName?: string };
    const code = typeof body.code === "string" ? body.code : "";
    if (!CODE_RE.test(code)) return json({ error: "bad_code" }, 400);

    const hostId = mintId(10);
    const now = Date.now();
    const host: Participant = {
      id: hostId,
      name: cleanName(body.hostName),
      joinedAt: now,
      isHost: true,
    };
    await this.ctx.storage.put(`p:${hostId}`, host);

    const m: SessionMeta = {
      code,
      hostId,
      createdAt: now,
      lastActivityAt: now,
      state: "lobby",
      deck: [],
    };
    await this.touch(m);
    return json({ code, hostId, expiresAt: now + IDLE_MS });
  }

  /** Enough for a join screen and a link preview. Never the deck, never the votes. */
  private async metaResponse(): Promise<Response> {
    const m = await this.meta();
    if (!m || m.state === "ended") return json({ error: "not_found" }, 404);
    const people = await this.participants();
    return json({
      code: m.code,
      state: m.state,
      hostName: people.find((p) => p.isHost)?.name ?? "Someone",
      participantCount: people.length,
      full: people.length >= MAX_PARTICIPANTS,
      expiresAt: m.lastActivityAt + IDLE_MS,
    });
  }

  private async socket(req: Request, url: URL): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return json({ error: "expected_websocket" }, 426);
    }
    const m = await this.meta();
    if (!m || m.state === "ended") return json({ error: "not_found" }, 404);

    const people = await this.participants();
    // A rejoining participant reclaims its seat rather than taking a second one.
    const claimed = url.searchParams.get("id") ?? "";
    const existing = people.find((p) => p.id === claimed);
    if (!existing && people.length >= MAX_PARTICIPANTS) {
      return json({ error: "session_full" }, 409);
    }

    const participant: Participant = existing ?? {
      id: mintId(10),
      name: cleanName(url.searchParams.get("name")),
      joinedAt: Date.now(),
      isHost: false,
    };
    if (!existing) await this.ctx.storage.put(`p:${participant.id}`, participant);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // ⚠️ `acceptWebSocket`, not `server.accept()`. The latter pins this object in memory for
    // the life of the connection and bills a forgotten tab by wall-clock.
    this.ctx.acceptWebSocket(server);
    const attachment: SocketAttachment = { participantId: participant.id };
    server.serializeAttachment(attachment);

    await this.touch(m);

    const roster = await this.participants();
    const collected = await this.collectedProfiles();
    this.send(server, {
      t: "welcome",
      you: participant,
      state: m.state,
      participants: roster,
      deck: m.state === "swiping" ? m.deck : undefined,
      maxParticipants: MAX_PARTICIPANTS,
      // Who has submitted a taste profile, so a lobby can show readiness.
      ready: Object.keys(collected),
      // ⚠️ The payloads themselves go to the HOST only, and are REPLAYED here rather than
      // only pushed on arrival — a host that reconnects mid-lobby would otherwise have lost
      // every profile sent while it was away, and would blend a deck from its own taste
      // alone without anything looking wrong.
      profiles: participant.isHost ? collected : undefined,
    });
    if (!existing) this.broadcast({ t: "joined", participant }, participant.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Socket lifecycle (hibernation API) ──

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) return;

    let msg: { t?: string; tmdbId?: unknown; liked?: unknown; deck?: unknown; profile?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { t: "error", message: "bad_json" });
    }

    const m = await this.meta();
    if (!m || m.state === "ended") return this.send(ws, { t: "ended", reason: "expired" });

    switch (msg.t) {
      case "start":
        return this.onStart(ws, att, m, msg.deck);
      case "profile":
        return this.onProfile(ws, att, m, msg.profile);
      case "vote":
        return this.onVote(ws, att, m, msg.tmdbId, msg.liked);
      case "end":
        return this.onEnd(att, m);
      default:
        return this.send(ws, { t: "error", message: "unknown_message" });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (att) this.broadcast({ t: "left", id: att.participantId });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /**
   * ⚠️ The host sets the deck ONCE, and it is immutable after that.
   *
   * Everyone must swipe the same titles in the same order or the overlap is meaningless —
   * a "match" would mean two people liked the same index, not the same film. Re-sending is
   * rejected rather than ignored so a buggy client is loud instead of subtly wrong.
   */
  private async onStart(
    ws: WebSocket,
    att: SocketAttachment,
    m: SessionMeta,
    deck: unknown,
  ): Promise<void> {
    if (att.participantId !== m.hostId) return this.send(ws, { t: "error", message: "not_host" });
    if (m.state !== "lobby") return this.send(ws, { t: "error", message: "already_started" });

    const ids = Array.isArray(deck)
      ? deck.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, MAX_DECK)
      : [];
    if (ids.length === 0) return this.send(ws, { t: "error", message: "empty_deck" });

    m.deck = ids;
    m.state = "swiping";
    await this.touch(m);
    this.broadcast({ t: "deck", items: ids, state: "swiping" });
  }

  /**
   * A participant's taste snapshot, so the host can blend a deck everyone is scored against.
   *
   * ⚠️ **Sent to the HOST only, never broadcast.** Only the host computes the deck, and a
   * taste vector plus up to 5000 watched ids is the most revealing thing the app holds —
   * handing every guest a copy of everyone else's would be a far bigger disclosure than the
   * feature needs. Everyone else is told only THAT a profile arrived, so a lobby can show
   * who is ready.
   *
   * ⚠️ Stored as the raw JSON string, not parsed. This object has no opinion about the
   * shape — `PartnerProfile` is versioned and owned by the app — and parsing it here would
   * make the Worker a second place that must be updated when a field is added.
   *
   * ⚠️ Accepted in the LOBBY only. After `start` the deck is fixed, so a late profile could
   * not affect it, and silently keeping one would imply otherwise.
   */
  private async onProfile(
    ws: WebSocket,
    att: SocketAttachment,
    m: SessionMeta,
    profile: unknown,
  ): Promise<void> {
    if (m.state !== "lobby") return this.send(ws, { t: "error", message: "already_started" });
    if (typeof profile !== "string" || profile.length === 0) {
      return this.send(ws, { t: "error", message: "bad_profile" });
    }
    if (profile.length > MAX_PROFILE_BYTES) {
      return this.send(ws, { t: "error", message: "profile_too_large" });
    }

    await this.ctx.storage.put(`pf:${att.participantId}`, profile);
    await this.touch(m);

    this.sendToHost(m, { t: "profile", id: att.participantId, profile });
    this.broadcast({ t: "ready", id: att.participantId });
  }

  /**
   * Deliver to whichever socket holds the host's seat.
   *
   * ⚠️ Silently does nothing when the host is not connected. That is correct rather than an
   * error: profiles are also replayed to the host on `welcome`, so one that arrives while
   * they are reconnecting is not lost.
   */
  private sendToHost(m: SessionMeta, payload: unknown): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.participantId === m.hostId) {
        this.send(ws, payload);
        return;
      }
    }
  }

  /** Every profile collected so far, as `{ participantId: rawJson }`. */
  private async collectedProfiles(): Promise<Record<string, string>> {
    const map = await this.ctx.storage.list<string>({ prefix: "pf:" });
    const out: Record<string, string> = {};
    for (const [k, v] of map) out[k.slice(3)] = v;
    return out;
  }

  private async onVote(
    ws: WebSocket,
    att: SocketAttachment,
    m: SessionMeta,
    tmdbIdRaw: unknown,
    likedRaw: unknown,
  ): Promise<void> {
    if (m.state !== "swiping") return this.send(ws, { t: "error", message: "not_started" });
    const tmdbId = Number(tmdbIdRaw);
    if (!Number.isInteger(tmdbId) || !m.deck.includes(tmdbId)) {
      // Refusing a title outside the deck is what stops a client inventing a match.
      return this.send(ws, { t: "error", message: "not_in_deck" });
    }
    const liked = likedRaw === true;

    const mine = await this.votesOf(att.participantId);
    mine[String(tmdbId)] = liked;
    await this.ctx.storage.put(`v:${att.participantId}`, mine);
    await this.touch(m);

    this.broadcast({ t: "vote", id: att.participantId, tmdbId, liked });

    if (liked) await this.checkMatch(tmdbId);
  }

  /**
   * A match is unanimity among everyone CURRENTLY CONNECTED.
   *
   * ⚠️ Connected, not "everyone who ever joined". A session must not be held hostage by
   * someone who closed their tab — and it must not silently declare a match on behalf of a
   * person who never saw the title. Someone joining later has not voted yet, so they hold
   * the match open until they do, which is the behaviour people expect.
   *
   * ⚠️ Announced at most once per title. `checkMatch` runs on every like, so without the
   * seen-set the last two participants would each trigger the same announcement.
   */
  private async checkMatch(tmdbId: number): Promise<void> {
    const connected = this.connectedParticipantIds();
    if (connected.length < 2) return;

    for (const id of connected) {
      const votes = await this.votesOf(id);
      if (votes[String(tmdbId)] !== true) return;
    }

    const announced = (await this.ctx.storage.get<number[]>("matched")) ?? [];
    if (announced.includes(tmdbId)) return;
    announced.push(tmdbId);
    await this.ctx.storage.put("matched", announced);

    this.broadcast({ t: "match", tmdbId, participants: connected.length });
  }

  private async onEnd(att: SocketAttachment, m: SessionMeta): Promise<void> {
    if (att.participantId !== m.hostId) return;
    await this.shutdown("host_ended");
  }

  async alarm(): Promise<void> {
    const m = await this.meta();
    if (!m) return;
    if (Date.now() - m.lastActivityAt < IDLE_MS) {
      // Activity landed after the alarm was set; re-arm rather than ending early.
      await this.ctx.storage.setAlarm(m.lastActivityAt + IDLE_MS);
      return;
    }
    await this.shutdown("expired");
  }

  /** ⚠️ `deleteAll` is the privacy promise. Taste payloads and votes leave no residue. */
  private async shutdown(reason: string): Promise<void> {
    this.broadcast({ t: "ended", reason });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, reason);
      } catch {
        // A socket the runtime has already torn down is not an error worth failing on.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ── Fan-out ──

  private connectedParticipantIds(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att) ids.add(att.participantId);
    }
    return [...ids];
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Closed mid-broadcast. `webSocketClose` will do the roster bookkeeping.
    }
  }

  private broadcast(payload: unknown, exceptParticipantId?: string): void {
    const body = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (exceptParticipantId) {
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (att?.participantId === exceptParticipantId) continue;
      }
      try {
        ws.send(body);
      } catch {
        // See `send`.
      }
    }
  }
}

// ── Worker-side handlers ─────────────────────────────────────────────────────

const stub = (env: GroupWatchEnv, code: string) =>
  env.GROUP_SESSION.get(env.GROUP_SESSION.idFromName(code));

/**
 * Create a session.
 *
 * ⚠️ The code is minted here and CONFIRMED by the object, not assumed unique. `idFromName`
 * maps any string to an object, so a collision would silently drop two groups into one room
 * — the object refuses a code it has already initialised and this re-mints.
 */
export async function handleWatchCreate(
  req: Request,
  env: GroupWatchEnv,
  rateLimited: (scope: string, limit: number) => Promise<boolean>,
): Promise<Response> {
  const limit = Number(env.GROUP_WATCH_PER_HOUR ?? DEFAULT_SESSIONS_PER_HOUR);
  if (await rateLimited("watch-create", limit)) return json({ error: "rate_limited" }, 429);

  const body = (await req.json().catch(() => ({}))) as { hostName?: string };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = mintCode();
    const res = await stub(env, code).fetch("https://do/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, hostName: body.hostName }),
    });
    if (res.status !== 409) {
      const out = await res.json();
      return json(out, res.status);
    }
  }
  return json({ error: "no_code_available" }, 503);
}

export async function handleWatchMeta(code: string, env: GroupWatchEnv): Promise<Response> {
  if (!CODE_RE.test(code)) return json({ error: "not_found" }, 404);
  const res = await stub(env, code).fetch("https://do/meta");
  return json(await res.json(), res.status);
}

/**
 * ⚠️ Passed through to the object UNCHANGED, headers and all. A WebSocket upgrade is a
 * protocol handshake, not a payload — reconstructing the Request here drops the
 * `Sec-WebSocket-Key` and the upgrade fails with a 400 that reads like a routing bug.
 */
export async function handleWatchSocket(
  code: string,
  req: Request,
  env: GroupWatchEnv,
): Promise<Response> {
  if (!CODE_RE.test(code)) return json({ error: "not_found" }, 404);
  const url = new URL(req.url);
  const target = new URL("https://do/ws");
  target.search = url.search;
  return stub(env, code).fetch(new Request(target, req));
}
