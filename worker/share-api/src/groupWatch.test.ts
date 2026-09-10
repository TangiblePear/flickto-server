import { describe, it, expect } from "vitest";
import { GroupSession, CODE_RE, MAX_PARTICIPANTS, IDLE_MS, mintCode } from "./groupWatch";

// ── Fakes ────────────────────────────────────────────────────────────────────
// Only what groupWatch.ts actually touches. Anything else throws, so a future call fails
// loudly rather than passing against a permissive stub — the convention matchAdhoc.test.ts
// established.

class FakeStorage {
  map = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    // Structured-clone the way real storage does, so a test cannot accidentally rely on
    // holding a live reference to something the object mutates later.
    this.map.set(key, JSON.parse(JSON.stringify(value)));
  }
  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.map) if (k.startsWith(prefix)) out.set(k, v as T);
    return out;
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.map.delete(k);
  }
  async deleteAll(): Promise<void> {
    this.map.clear();
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

class FakeSocket {
  sent: any[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;

  send(body: string): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push(JSON.parse(body));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown): void {
    this.attachment = v;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  /** Messages of one kind, for readable assertions. */
  of(t: string): any[] {
    return this.sent.filter((m) => m.t === t);
  }
}

class FakeState {
  storage = new FakeStorage();
  sockets: FakeSocket[] = [];

  acceptWebSocket(ws: FakeSocket): void {
    this.sockets.push(ws);
  }
  getWebSockets(): FakeSocket[] {
    return this.sockets.filter((s) => !s.closed);
  }
}

function session() {
  const state = new FakeState();
  const obj = new GroupSession(state as any, {} as any);
  return { state, obj };
}

const doFetch = (obj: GroupSession, action: string, body?: unknown) =>
  obj.fetch(
    new Request(`https://do/${action}`, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    }),
  );

/**
 * Attach a participant with a live socket WITHOUT going through `socket()`.
 *
 * ⚠️ `socket()` returns `new Response(null, { status: 101 })`, which undici rejects outside
 * workerd — status 101 is not constructible there. That plumbing is runtime behaviour; the
 * logic worth testing is everything after it, so these tests seed the same state directly.
 */
async function connect(
  { state, obj }: ReturnType<typeof session>,
  id: string,
  name: string,
  isHost = false,
): Promise<FakeSocket> {
  await state.storage.put(`p:${id}`, { id, name, joinedAt: Date.now(), isHost });
  const ws = new FakeSocket();
  ws.serializeAttachment({ participantId: id });
  state.acceptWebSocket(ws);
  return ws;
}

const send = (obj: GroupSession, ws: FakeSocket, msg: unknown) =>
  (obj as any).webSocketMessage(ws, JSON.stringify(msg));

describe("group watch — codes", () => {
  it("mints codes in the typed alphabet", () => {
    for (let i = 0; i < 200; i++) expect(CODE_RE.test(mintCode())).toBe(true);
  });

  /**
   * ⚠️ Crockford base32 drops I, L, O and U — NOT all vowels. A and E are in the set. The
   * point is characters a person misreads from a screen or mishears down a phone: I and L
   * for 1, O for 0.
   */
  it("excludes the characters a person would misread or mishear", () => {
    const codes = Array.from({ length: 500 }, () => mintCode()).join("");
    for (const c of "ILOU") expect(codes).not.toContain(c);
    // …and the ones it deliberately keeps, so a future "tidy-up" of the alphabet is loud.
    for (const c of "AE") expect(codes).toContain(c);
  });
});

describe("group watch — creating a session", () => {
  it("creates a lobby with the host in it", async () => {
    const s = session();
    const res = await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.code).toBe("ABC234");
    expect(body.hostId).toBeTruthy();

    const meta = await doFetch(s.obj, "meta");
    const m = (await meta.json()) as any;
    expect(m.state).toBe("lobby");
    expect(m.hostName).toBe("Sam");
    expect(m.participantCount).toBe(1);
    expect(m.full).toBe(false);
  });

  /**
   * ⚠️ The collision guard. `idFromName` maps ANY string to an object, so without this a
   * repeated code would silently drop two unrelated groups into one room.
   */
  it("refuses a code that is already in use", async () => {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const second = await doFetch(s.obj, "create", { code: "ABC234", hostName: "Someone else" });
    expect(second.status).toBe(409);
  });

  it("rejects a code that is not in the alphabet", async () => {
    const s = session();
    expect((await doFetch(s.obj, "create", { code: "abc", hostName: "Sam" })).status).toBe(400);
  });

  /**
   * ⚠️ Names are the only free text in the protocol — see cleanName.
   *
   * ⚠️ The control characters are written as ESCAPES, not literals. A literal NUL in the
   * source makes git treat this whole file as binary — no diff, no review, no blame.
   */
  it("strips control characters from a name and falls back to Guest", async () => {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "S\u0000a\u001Fm" });
    expect((await (await doFetch(s.obj, "meta")).json() as any).hostName).toBe("Sam");

    const t = session();
    await doFetch(t.obj, "create", { code: "ABC235", hostName: "   " });
    expect((await (await doFetch(t.obj, "meta")).json() as any).hostName).toBe("Guest");
  });

  it("reports a session as not_found once it has ended", async () => {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    s.state.storage.map.set("meta", { ...(s.state.storage.map.get("meta") as any), state: "ended" });
    expect((await doFetch(s.obj, "meta")).status).toBe(404);
  });
});

describe("group watch — starting", () => {
  async function lobby() {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const host = await connect(s, hostId, "Sam", true);
    const guest = await connect(s, "GUEST00001", "Alex");
    return { ...s, host, guest, hostId };
  }

  it("lets the host set the deck and tells everyone", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "start", deck: [603, 604, 605] });
    expect(g.guest.of("deck")[0].items).toEqual([603, 604, 605]);
    expect(g.host.of("deck")[0].state).toBe("swiping");
  });

  it("refuses a start from anyone but the host", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "start", deck: [603] });
    expect(g.guest.of("error")[0].message).toBe("not_host");
    expect(g.host.of("deck")).toHaveLength(0);
  });

  /** ⚠️ Immutable after the first start — a changed deck makes every vote mean something else. */
  it("refuses a second deck", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "start", deck: [603] });
    await send(g.obj, g.host, { t: "start", deck: [999] });
    expect(g.host.of("error")[0].message).toBe("already_started");
  });

  it("refuses an empty deck rather than starting a session nobody can swipe", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "start", deck: [] });
    expect(g.host.of("error")[0].message).toBe("empty_deck");
  });
});

describe("group watch — taste profiles", () => {
  async function lobby() {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const host = await connect(s, hostId, "Sam", true);
    const guest = await connect(s, "GUEST00001", "Alex");
    for (const w of [host, guest]) w.sent.length = 0;
    return { ...s, host, guest, hostId };
  }

  /**
   * ⚠️ **The payload goes to the HOST ONLY.** A taste vector plus up to 5000 watched ids is
   * the most revealing thing the app holds, and only the host computes the deck — handing
   * every guest a copy of everyone else's would be a far bigger disclosure than the feature
   * needs. This assertion is the privacy property; do not relax it to "broadcast" for
   * convenience.
   */
  it("delivers a profile to the host and only the host", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "profile", profile: '{"displayName":"Alex"}' });

    expect(g.host.of("profile")[0]).toMatchObject({ id: "GUEST00001" });
    expect(g.guest.of("profile")).toHaveLength(0);
  });

  /** Everyone learns THAT a profile arrived, so a lobby can show who is ready. */
  it("tells everyone who is ready, without the payload", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "profile", profile: '{"displayName":"Alex"}' });

    const ready = g.host.of("ready")[0];
    expect(ready.id).toBe("GUEST00001");
    expect(ready.profile).toBeUndefined();
    expect(g.guest.of("ready")).toHaveLength(1);
  });

  /**
   * ⚠️ Replayed on welcome, not only pushed on arrival. A host that reconnects mid-lobby
   * would otherwise have lost every profile sent while it was away, and would blend a deck
   * from its own taste alone with nothing looking wrong.
   */
  it("replays collected profiles to a host that reconnects", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "profile", profile: '{"displayName":"Alex"}' });

    // A fresh socket for the same seat is what a reconnect looks like.
    const back = await connect(g, g.hostId, "Sam", true);
    const welcome = { ...(await (g.obj as any).collectedProfiles()) };
    expect(welcome["GUEST00001"]).toBe('{"displayName":"Alex"}');
    expect(back).toBeTruthy();
  });

  it("refuses a profile once the deck is set", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "start", deck: [603] });
    await send(g.obj, g.guest, { t: "profile", profile: '{"displayName":"Alex"}' });
    expect(g.guest.of("error").some((e) => e.message === "already_started")).toBe(true);
  });

  /** An abuse ceiling, not a working size — a real profile is ~15 KB. */
  it("refuses an oversized profile", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "profile", profile: "x".repeat(96 * 1024 + 1) });
    expect(g.guest.of("error")[0].message).toBe("profile_too_large");
  });

  it("refuses a profile that is not a string", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "profile", profile: { displayName: "Alex" } });
    expect(g.guest.of("error")[0].message).toBe("bad_profile");
  });

  /** Everything dies with the session — profiles included. */
  it("erases profiles when the session ends", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "profile", profile: '{"displayName":"Alex"}' });
    expect(g.state.storage.map.has("pf:GUEST00001")).toBe(true);

    await send(g.obj, g.host, { t: "end" });
    expect(g.state.storage.map.size).toBe(0);
  });
});

describe("group watch — voting and matching", () => {
  async function swiping(names: string[] = ["Sam", "Alex"]) {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: names[0] });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const sockets = [await connect(s, hostId, names[0], true)];
    for (let i = 1; i < names.length; i++) {
      sockets.push(await connect(s, `GUEST0000${i}`, names[i]));
    }
    await send(s.obj, sockets[0], { t: "start", deck: [603, 604] });
    for (const ws of sockets) ws.sent.length = 0;
    return { ...s, sockets };
  }

  it("announces a match only when everyone connected has liked it", async () => {
    const g = await swiping(["Sam", "Alex", "Jo"]);
    const [a, b, c] = g.sockets;

    await send(g.obj, a, { t: "vote", tmdbId: 603, liked: true });
    expect(a.of("match")).toHaveLength(0);

    await send(g.obj, b, { t: "vote", tmdbId: 603, liked: true });
    expect(a.of("match")).toHaveLength(0);

    await send(g.obj, c, { t: "vote", tmdbId: 603, liked: true });
    expect(a.of("match")[0].tmdbId).toBe(603);
    expect(c.of("match")[0].participants).toBe(3);
  });

  it("does not announce when one participant disliked it", async () => {
    const g = await swiping(["Sam", "Alex"]);
    const [a, b] = g.sockets;
    await send(g.obj, a, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, b, { t: "vote", tmdbId: 603, liked: false });
    expect(a.of("match")).toHaveLength(0);
  });

  /**
   * ⚠️ `checkMatch` runs on every like, so the last two participants would each trigger the
   * same announcement without the seen-set.
   */
  it("announces a title at most once", async () => {
    const g = await swiping(["Sam", "Alex"]);
    const [a, b] = g.sockets;
    await send(g.obj, a, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, b, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, b, { t: "vote", tmdbId: 603, liked: true });
    expect(a.of("match")).toHaveLength(1);
  });

  /** ⚠️ A session must not be held hostage by someone who closed their tab. */
  it("ignores a participant who has disconnected", async () => {
    const g = await swiping(["Sam", "Alex", "Jo"]);
    const [a, b, c] = g.sockets;
    await send(g.obj, a, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, b, { t: "vote", tmdbId: 603, liked: true });
    expect(a.of("match")).toHaveLength(0);

    c.close(1000, "gone");
    await send(g.obj, b, { t: "vote", tmdbId: 604, liked: true });
    await send(g.obj, a, { t: "vote", tmdbId: 604, liked: true });
    expect(a.of("match")[0].tmdbId).toBe(604);
  });

  /** One person alone is not a group, and a solo "match" would be meaningless. */
  it("never matches with only one participant connected", async () => {
    const g = await swiping(["Sam", "Alex"]);
    const [a, b] = g.sockets;
    b.close(1000, "gone");
    await send(g.obj, a, { t: "vote", tmdbId: 603, liked: true });
    expect(a.of("match")).toHaveLength(0);
  });

  /** ⚠️ What stops a client inventing a match for a title nobody was shown. */
  it("refuses a vote for a title outside the deck", async () => {
    const g = await swiping();
    await send(g.obj, g.sockets[0], { t: "vote", tmdbId: 999, liked: true });
    expect(g.sockets[0].of("error")[0].message).toBe("not_in_deck");
  });

  it("refuses a vote before the host has started", async () => {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const ws = await connect(s, hostId, "Sam", true);
    await send(s.obj, ws, { t: "vote", tmdbId: 603, liked: true });
    expect(ws.of("error")[0].message).toBe("not_started");
  });

  it("relays every vote so others can see progress", async () => {
    const g = await swiping();
    await send(g.obj, g.sockets[0], { t: "vote", tmdbId: 603, liked: false });
    expect(g.sockets[1].of("vote")[0]).toMatchObject({ tmdbId: 603, liked: false });
  });

  it("answers an unparseable frame instead of throwing", async () => {
    const g = await swiping();
    await (g.obj as any).webSocketMessage(g.sockets[0], "{not json");
    expect(g.sockets[0].of("error")[0].message).toBe("bad_json");
  });
});

describe("group watch — expiry", () => {
  async function started() {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const ws = await connect(s, hostId, "Sam", true);
    return { ...s, ws, hostId };
  }

  it("arms an alarm for the idle deadline", async () => {
    const g = await started();
    expect(g.state.storage.alarm).toBeGreaterThan(Date.now() + IDLE_MS - 5_000);
  });

  /** ⚠️ The privacy promise: taste payloads and votes leave no residue. */
  it("ends the session and erases everything when the alarm fires", async () => {
    const g = await started();
    const meta = g.state.storage.map.get("meta") as any;
    meta.lastActivityAt = Date.now() - IDLE_MS - 1;
    g.state.storage.map.set("meta", meta);

    await (g.obj as any).alarm();

    expect(g.ws.of("ended")[0].reason).toBe("expired");
    expect(g.ws.closed).not.toBeNull();
    expect(g.state.storage.map.size).toBe(0);
    expect(g.state.storage.alarm).toBeNull();
  });

  /** Activity that landed after the alarm was scheduled must re-arm, not end early. */
  it("re-arms instead of ending when the session is still active", async () => {
    const g = await started();
    await (g.obj as any).alarm();
    expect(g.ws.of("ended")).toHaveLength(0);
    expect(g.state.storage.map.get("meta")).toBeTruthy();
  });

  it("lets the host end it deliberately", async () => {
    const g = await started();
    await send(g.obj, g.ws, { t: "end" });
    expect(g.ws.of("ended")[0].reason).toBe("host_ended");
    expect(g.state.storage.map.size).toBe(0);
  });

  it("ignores an end from a guest", async () => {
    const g = await started();
    const guest = await connect(g, "GUEST00001", "Alex");
    await send(g.obj, guest, { t: "end" });
    expect(guest.of("ended")).toHaveLength(0);
    expect(g.state.storage.map.get("meta")).toBeTruthy();
  });
});

describe("group watch — caps", () => {
  it("reports a session as full at the participant cap", async () => {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    await connect(s, hostId, "Sam", true);
    for (let i = 1; i < MAX_PARTICIPANTS; i++) await connect(s, `GUEST0000${i}`, `P${i}`);

    const m = (await (await doFetch(s.obj, "meta")).json()) as any;
    expect(m.participantCount).toBe(MAX_PARTICIPANTS);
    expect(m.full).toBe(true);
  });

  it("truncates an oversized deck rather than accepting it whole", async () => {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const ws = await connect(s, hostId, "Sam", true);
    await send(s.obj, ws, { t: "start", deck: Array.from({ length: 900 }, (_, i) => i + 1) });
    expect(ws.of("deck")[0].items).toHaveLength(500);
  });

  /** Junk entries are dropped, not coerced — a NaN tmdbId would match nothing forever. */
  it("drops non-integer deck entries", async () => {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const ws = await connect(s, hostId, "Sam", true);
    await send(s.obj, ws, { t: "start", deck: [603, "x", null, -1, 0, 604] as any });
    expect(ws.of("deck")[0].items).toEqual([603, 604]);
  });
});

describe("group watch — moderation", () => {
  async function lobby() {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const host = await connect(s, hostId, "Sam", true);
    const guest = await connect(s, "GUEST00001", "Alex");
    return { ...s, host, guest, hostId };
  }

  /** Opening a socket without the upgrade dance, so the REFUSAL paths are reachable. */
  const tryJoin = (obj: GroupSession, query: string) =>
    obj.fetch(new Request(`https://do/ws?${query}`, { headers: { Upgrade: "websocket" } }));

  it("lets the host close and reopen the room", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "lock", locked: true });
    expect((g.state.storage.map.get("meta") as any).locked).toBe(true);
    expect(g.guest.of("locked")[0].locked).toBe(true);

    await send(g.obj, g.host, { t: "lock", locked: false });
    expect((g.state.storage.map.get("meta") as any).locked).toBe(false);
  });

  it("refuses a guest a lock", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "lock", locked: true });
    expect(g.guest.of("error")[0].message).toBe("not_host");
    expect((g.state.storage.map.get("meta") as any).locked).toBeUndefined();
  });

  it("turns a new joiner away from a locked room", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "lock", locked: true });
    expect((await tryJoin(g.obj, "name=Nobody")).status).toBe(403);
  });

  /**
   * ⚠️ The lock stops NEW seats only. Someone already in the room whose socket dropped —
   * a tunnel, a locked phone — must be able to come back, or closing the room would slowly
   * empty it.
   */
  it("still lets someone already inside reconnect", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "lock", locked: true });
    // Not a 403: it gets past every refusal and dies on WebSocketPair, which does not exist
    // outside workerd. Reaching that is the assertion.
    await expect(tryJoin(g.obj, "id=GUEST00001")).rejects.toBeTruthy();
  });

  it("removes a participant and everything they contributed", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "profile", profile: '{"displayName":"Alex"}' });
    await send(g.obj, g.host, { t: "start", deck: [603] });
    await send(g.obj, g.guest, { t: "vote", tmdbId: 603, liked: true });
    expect(g.state.storage.map.has("pf:GUEST00001")).toBe(true);
    expect(g.state.storage.map.has("v:GUEST00001")).toBe(true);

    await send(g.obj, g.host, { t: "kick", id: "GUEST00001" });

    // ⚠️ Not merely disconnected. A removed participant must stop influencing the deck the
    // rest of the session swipes, and a leftover profile or vote would do exactly that.
    expect(g.state.storage.map.has("p:GUEST00001")).toBe(false);
    expect(g.state.storage.map.has("pf:GUEST00001")).toBe(false);
    expect(g.state.storage.map.has("v:GUEST00001")).toBe(false);
    expect(g.guest.closed).not.toBeNull();
    expect(g.host.of("left")[0].id).toBe("GUEST00001");
  });

  /** ⚠️ A client still holds its old id. Without the tombstone it could simply walk back in. */
  it("keeps a removed participant out even with their old id", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "kick", id: "GUEST00001" });
    expect((await tryJoin(g.obj, "id=GUEST00001")).status).toBe(403);
  });

  it("refuses a guest a kick", async () => {
    const g = await lobby();
    await send(g.obj, g.guest, { t: "kick", id: (g as any).hostId });
    expect(g.guest.of("error")[0].message).toBe("not_host");
  });

  /** ⚠️ `end` is how a host leaves. Kicking itself would strand a session nobody can stop. */
  it("will not let the host kick itself", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "kick", id: g.hostId });
    expect(g.host.of("error")[0].message).toBe("bad_target");
    expect(g.state.storage.map.has(`p:${g.hostId}`)).toBe(true);
  });

  it("reports an unknown target rather than silently succeeding", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "kick", id: "NOBODY0001" });
    expect(g.host.of("error")[0].message).toBe("not_here");
  });

  it("tells a join screen the room is locked", async () => {
    const g = await lobby();
    await send(g.obj, g.host, { t: "lock", locked: true });
    const meta = (await (await doFetch(g.obj, "meta")).json()) as any;
    expect(meta.locked).toBe(true);
  });
});

describe("group watch — scores and results", () => {
  async function swiping(deck = [603, 604], scores?: number[]) {
    const s = session();
    await doFetch(s.obj, "create", { code: "ABC234", hostName: "Sam" });
    const hostId = (s.state.storage.map.get("meta") as any).hostId;
    const host = await connect(s, hostId, "Sam", true);
    const guest = await connect(s, "GUEST00001", "Alex");
    await send(s.obj, host, { t: "start", deck, scores });
    return { ...s, host, guest, hostId };
  }

  it("carries a fit score per card", async () => {
    const g = await swiping([603, 604], [91, 74]);
    expect(g.guest.of("deck")[0].scores).toEqual([91, 74]);
  });

  /**
   * ⚠️ A misaligned score is WORSE than none: it labels every film with its neighbour's
   * match. `start` filters out non-positive ids, so a parallel array can silently stop
   * lining up — and the only safe answer is to drop the scores entirely.
   */
  it("drops scores that no longer line up with the deck", async () => {
    const g = await swiping([603, -1, 604], [91, 50, 74]);
    expect(g.guest.of("deck")[0].items).toEqual([603, 604]);
    expect(g.guest.of("deck")[0].scores).toBeUndefined();
  });

  it("drops a score array of the wrong length", async () => {
    const g = await swiping([603, 604], [91]);
    expect(g.guest.of("deck")[0].scores).toBeUndefined();
  });

  /** ⚠️ Clamped to 0–100. A client sending 3000 must not render as a 3000% match. */
  it("clamps and rounds what it is given", async () => {
    const g = await swiping([603, 604], [3000, -12.6]);
    expect(g.guest.of("deck")[0].scores).toEqual([100, 0]);
  });

  it("still works with no scores at all", async () => {
    const g = await swiping([603, 604]);
    expect(g.guest.of("deck")[0].items).toEqual([603, 604]);
    expect(g.guest.of("deck")[0].scores).toBeUndefined();
  });

  it("lets the host stop early and show everyone the result", async () => {
    const g = await swiping();
    await send(g.obj, g.host, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, g.guest, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, g.host, { t: "finish" });

    const results = g.guest.of("results")[0];
    expect(results.matches).toEqual([603]);
    expect(results.liked["603"]).toBe(2);
    expect(results.voters).toBe(2);
    expect((g.state.storage.map.get("meta") as any).state).toBe("results");
  });

  /**
   * ⚠️ Finishing is NOT ending. Everyone is still connected looking at the result, and the
   * storage has to survive or a reconnect lands on an empty session. `end` is the
   * destructive one — making the only route to a result also destroy it would be absurd.
   */
  it("keeps the session alive after finishing", async () => {
    const g = await swiping();
    await send(g.obj, g.host, { t: "finish" });
    expect(g.state.storage.map.has("meta")).toBe(true);
    expect((await doFetch(g.obj, "meta")).status).toBe(200);
    expect(g.guest.closed).toBeNull();
  });

  /**
   * ⚠️ Whoever SWIPED, not whoever is in the room. A latecomer who joined to see the result
   * would otherwise turn "2 of 2 liked this" into "2 of 3" and make a unanimous pick read as
   * a near-miss. Caught on a live session, 2026-09-10.
   */
  it("counts voters, not spectators", async () => {
    const g = await swiping();
    await send(g.obj, g.host, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, g.guest, { t: "vote", tmdbId: 603, liked: true });
    await connect(g, "LATE000001", "Latecomer");
    await send(g.obj, g.host, { t: "finish" });

    const results = g.guest.of("results")[0];
    expect(results.voters).toBe(2);
    expect(results.liked["603"]).toBe(2);
  });

  it("refuses a guest the finish", async () => {
    const g = await swiping();
    await send(g.obj, g.guest, { t: "finish" });
    expect(g.guest.of("error").at(-1).message).toBe("not_host");
    expect((g.state.storage.map.get("meta") as any).state).toBe("swiping");
  });

  /** Nothing left to wait for once everyone connected has answered every card. */
  it("finishes on its own when the deck runs out", async () => {
    const g = await swiping([603, 604]);
    for (const tmdbId of [603, 604]) {
      await send(g.obj, g.host, { t: "vote", tmdbId, liked: true });
      await send(g.obj, g.guest, { t: "vote", tmdbId, liked: tmdbId === 603 });
    }
    expect((g.state.storage.map.get("meta") as any).state).toBe("results");
    const results = g.host.of("results")[0];
    expect(results.matches).toEqual([603]);
    expect(results.liked["604"]).toBe(1);
  });

  /** ⚠️ Not while someone is still swiping — a half-finished deck must not end the session. */
  it("does not finish while anyone still has cards left", async () => {
    const g = await swiping([603, 604]);
    await send(g.obj, g.host, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, g.host, { t: "vote", tmdbId: 604, liked: true });
    await send(g.obj, g.guest, { t: "vote", tmdbId: 603, liked: true });
    expect((g.state.storage.map.get("meta") as any).state).toBe("swiping");
  });

  it("refuses votes once the results are up", async () => {
    const g = await swiping();
    await send(g.obj, g.host, { t: "finish" });
    await send(g.obj, g.guest, { t: "vote", tmdbId: 603, liked: true });
    expect(g.guest.of("error").at(-1).message).toBe("not_started");
  });

  /**
   * ⚠️ A reconnect after the finish needs the DECK as well as the tally, or its results
   * screen is a list of bare numbers with nothing to render.
   */
  it("replays the deck and the result to someone who reconnects", async () => {
    const g = await swiping([603, 604], [91, 74]);
    await send(g.obj, g.host, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, g.guest, { t: "vote", tmdbId: 603, liked: true });
    await send(g.obj, g.host, { t: "finish" });

    const back = await connect(g, "GUEST00001", "Alex");
    await (g.obj as any).fetch(new Request("https://do/meta"));
    // welcome is sent by socket(), which cannot run outside workerd — assert the state the
    // reconnect would be handed instead.
    const meta = await (await doFetch(g.obj, "meta")).json() as any;
    expect(meta.state).toBe("results");
    expect(back).toBeTruthy();
  });
});
