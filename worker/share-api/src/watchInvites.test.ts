// Choose Together invites.
//
// The properties worth pinning are the ones a reader cannot see from the call
// sites: that inviting someone who blocked you is indistinguishable from success,
// that a declined invite stays declined when the same room is offered again, and
// that an accept hands back the code so the client needs no second round trip.

import { describe, it, expect, vi } from "vitest";
import {
  handleAcceptWatchInvite,
  handleDeclineWatchInvite,
  handleGetWatchInvites,
  handleWatchInvite,
} from "./watchInvites";

const ME = "AAAAH73X7P55T48R4CFHDED9CW";
const FRIEND = "BBBBH73X7P55T48R4CFHDED9CW";
const CODE = "ABC234";

vi.mock("./auth", () => ({
  resolveSession: async (req: Request) =>
    req.headers.get("Authorization") ? { userId: req.headers.get("Authorization") } : null,
}));

// The two gates every directed message in this worker goes through. Driven per test.
const state = { friends: true, blocked: false };
vi.mock("./authz", () => ({
  areFriends: async () => state.friends,
  isBlockedEitherWay: async () => state.blocked,
}));

interface Row {
  id: string;
  sender_id: string;
  recipient_id: string;
  code: string;
  created_at: number;
  state: string;
}

/**
 * Enough SQL to answer watchInvites.ts, and nothing more — a permissive stub would
 * let a future statement pass against a fake that never ran it.
 */
class FakeD1 {
  rows: Row[] = [];
  prepare(sql: string) {
    const self = this;
    let args: unknown[] = [];
    return {
      bind(...a: unknown[]) {
        args = a;
        return this;
      },
      async run() {
        if (sql.startsWith("INSERT INTO watch_invites")) {
          const [id, sender, recipient, code, createdAt] = args as [string, string, string, string, number];
          const clash = self.rows.some(
            (r) => r.sender_id === sender && r.recipient_id === recipient && r.code === code,
          );
          if (!clash) self.rows.push({ id, sender_id: sender, recipient_id: recipient, code, created_at: createdAt, state: "pending" });
          return { meta: { changes: clash ? 0 : 1 } };
        }
        if (sql.includes("SET state = 'accepted'")) {
          const [id, recipient] = args as [string, string];
          const row = self.rows.find((r) => r.id === id && r.recipient_id === recipient);
          if (row) row.state = "accepted";
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.includes("SET state = 'declined'")) {
          const [id, recipient] = args as [string, string];
          const row = self.rows.find((r) => r.id === id && r.recipient_id === recipient && r.state === "pending");
          if (row) row.state = "declined";
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.startsWith("DELETE FROM watch_invites")) {
          const [id, sender] = args as [string, string];
          const before = self.rows.length;
          self.rows = self.rows.filter((r) => !(r.id === id && r.sender_id === sender));
          return { meta: { changes: before - self.rows.length } };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      async first<T>(): Promise<T | null> {
        const [id, recipient] = args as [string, string];
        const row = self.rows.find((r) => r.id === id && r.recipient_id === recipient);
        return row ? ({ code: row.code, state: row.state } as T) : null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const [recipient, since] = args as [string, number];
        return {
          results: self.rows
            .filter((r) => r.recipient_id === recipient && r.state === "pending" && r.created_at > since)
            .sort((a, b) => b.created_at - a.created_at) as unknown as T[],
        };
      },
    };
  }
}

function setup() {
  state.friends = true;
  state.blocked = false;
  const d1 = new FakeD1();
  return { d1, env: { DB: d1 as unknown as D1Database } };
}

const post = (userId: string | null, path: string, body?: unknown) =>
  new Request(`https://x${path}`, {
    method: body === undefined ? "DELETE" : "POST",
    headers: userId ? { Authorization: userId } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const invite = (env: { DB: D1Database }, body: unknown, who = ME, notify?: (id: string) => void) =>
  handleWatchInvite(post(who, "/api/watch/invite", body), env, undefined, notify);

const ID = "ZZZZ00000001";

describe("choose together — sending an invite", () => {
  it("stores it, and wakes the friend's devices", async () => {
    const { d1, env } = setup();
    const woken: string[] = [];
    const res = await invite(env, { id: ID, recipientId: FRIEND, code: CODE }, ME, (u) => woken.push(u));
    expect(res.status).toBe(200);
    expect(d1.rows).toHaveLength(1);
    expect(d1.rows[0]).toMatchObject({ sender_id: ME, recipient_id: FRIEND, code: CODE, state: "pending" });
    expect(woken).toEqual([FRIEND]);
  });

  it("refuses a caller with no session", async () => {
    const { env } = setup();
    const res = await handleWatchInvite(post(null, "/api/watch/invite", { id: ID, recipientId: FRIEND, code: CODE }), env);
    expect(res.status).toBe(401);
  });

  it("refuses a code that is not a room code", async () => {
    const { d1, env } = setup();
    // ⚠️ `ABCI34` is in here on purpose: the session alphabet drops I, L, O and U, so a
    // code carrying one was never minted by the room and must not be forwarded to anyone.
    for (const code of ["", "ABC", "ABCI34", "ABC2345", "AB-234"]) {
      expect((await invite(env, { id: ID, recipientId: FRIEND, code })).status).toBe(400);
    }
    expect(d1.rows).toHaveLength(0);
  });

  /** Codes are read aloud and typed in, so case is normalised rather than refused. */
  it("normalises a lower-case code", async () => {
    const { d1, env } = setup();
    expect((await invite(env, { id: ID, recipientId: FRIEND, code: "abc234" })).status).toBe(200);
    expect(d1.rows[0].code).toBe("ABC234");
  });

  it("refuses inviting yourself", async () => {
    const { env } = setup();
    expect((await invite(env, { id: ID, recipientId: ME, code: CODE })).status).toBe(400);
  });

  /** A directed message: a stranger must not be able to address you at all. */
  it("refuses someone who is not a friend", async () => {
    const { d1, env } = setup();
    state.friends = false;
    expect((await invite(env, { id: ID, recipientId: FRIEND, code: CODE })).status).toBe(403);
    expect(d1.rows).toHaveLength(0);
  });

  /**
   * ⚠️ The single easiest thing here to get wrong. Any answer that differs from a
   * delivered invite turns this endpoint into a block detector.
   */
  it("is indistinguishable from success when the friend has blocked you", async () => {
    const { d1, env } = setup();
    state.blocked = true;
    const woken: string[] = [];
    const res = await invite(env, { id: ID, recipientId: FRIEND, code: CODE }, ME, (u) => woken.push(u));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID });
    expect(d1.rows).toHaveLength(0);
    expect(woken).toEqual([]);
  });

  it("does not stack when the same invite is retried", async () => {
    const { d1, env } = setup();
    await invite(env, { id: ID, recipientId: FRIEND, code: CODE });
    await invite(env, { id: "ZZZZ00000002", recipientId: FRIEND, code: CODE });
    expect(d1.rows).toHaveLength(1);
  });

  /** A new room from the same person is a new invite, and must still arrive. */
  it("delivers a different room to the same friend", async () => {
    const { d1, env } = setup();
    await invite(env, { id: ID, recipientId: FRIEND, code: CODE });
    await invite(env, { id: "ZZZZ00000002", recipientId: FRIEND, code: "ZZZ999" });
    expect(d1.rows).toHaveLength(2);
  });
});

describe("choose together — the inbox", () => {
  const get = (env: { DB: D1Database }, who: string | null = FRIEND) =>
    handleGetWatchInvites(
      new Request("https://x/api/watch/invites", { headers: who ? { Authorization: who } : undefined }),
      env,
    );

  it("lists what is waiting for me, newest first", async () => {
    const { d1, env } = setup();
    d1.rows.push(
      { id: "A1", sender_id: ME, recipient_id: FRIEND, code: "AAA111", created_at: Date.now() - 60_000, state: "pending" },
      { id: "B2", sender_id: ME, recipient_id: FRIEND, code: "BBB222", created_at: Date.now(), state: "pending" },
    );
    const body = (await (await get(env)).json()) as { invites: { id: string; code: string }[] };
    expect(body.invites.map((i) => i.id)).toEqual(["B2", "A1"]);
    expect(body.invites[0]).toMatchObject({ senderId: ME, code: "BBB222" });
  });

  it("hides what is not mine, not pending, or too old to point at a live room", async () => {
    const { d1, env } = setup();
    const old = Date.now() - 3 * 60 * 60 * 1000;
    d1.rows.push(
      { id: "MINE", sender_id: ME, recipient_id: FRIEND, code: "AAA111", created_at: Date.now(), state: "pending" },
      { id: "THEIRS", sender_id: ME, recipient_id: ME, code: "BBB222", created_at: Date.now(), state: "pending" },
      { id: "DONE", sender_id: ME, recipient_id: FRIEND, code: "CCC333", created_at: Date.now(), state: "declined" },
      { id: "STALE", sender_id: ME, recipient_id: FRIEND, code: "DDD444", created_at: old, state: "pending" },
    );
    const body = (await (await get(env)).json()) as { invites: { id: string }[] };
    expect(body.invites.map((i) => i.id)).toEqual(["MINE"]);
  });

  it("refuses a caller with no session", async () => {
    const { env } = setup();
    expect((await get(env, null)).status).toBe(401);
  });
});

describe("choose together — answering", () => {
  const accept = (env: { DB: D1Database }, id: string, who: string | null = FRIEND) =>
    handleAcceptWatchInvite(id, post(who, `/api/watch/invites/${id}/accept`, {}), env);
  const decline = (env: { DB: D1Database }, id: string, who = FRIEND) =>
    handleDeclineWatchInvite(id, post(who, `/api/watch/invites/${id}`), env);

  const pending = (d1: FakeD1) =>
    d1.rows.push({ id: ID, sender_id: ME, recipient_id: FRIEND, code: CODE, created_at: Date.now(), state: "pending" });

  /** The code comes back so the client can open the room without asking again. */
  it("hands back the room code", async () => {
    const { d1, env } = setup();
    pending(d1);
    const res = await accept(env, ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: CODE });
    expect(d1.rows[0].state).toBe("accepted");
  });

  it("is idempotent", async () => {
    const { d1, env } = setup();
    pending(d1);
    await accept(env, ID);
    expect(await (await accept(env, ID)).json()).toEqual({ code: CODE });
  });

  /** ⚠️ 404, not 403 — answering differently would confirm the id exists. */
  it("gives someone else's invite the same answer as an unknown one", async () => {
    const { d1, env } = setup();
    pending(d1);
    expect((await accept(env, ID, ME)).status).toBe(404);
    expect((await accept(env, "ZZZZ00009999")).status).toBe(404);
    expect(d1.rows[0].state).toBe("pending");
  });

  it("will not open a room the recipient already refused", async () => {
    const { d1, env } = setup();
    pending(d1);
    await decline(env, ID);
    expect(d1.rows[0].state).toBe("declined");
    expect((await accept(env, ID)).status).toBe(409);
  });

  /**
   * ⚠️ A decline is a STATE for the recipient — the row is what stops the same room
   * being offered again — but an outright DELETE for the sender withdrawing it,
   * because then there is nothing left to re-offer.
   */
  it("keeps a declined row, and removes one the sender withdraws", async () => {
    const { d1, env } = setup();
    pending(d1);
    await decline(env, ID);
    expect(d1.rows).toHaveLength(1);
    await handleDeclineWatchInvite(ID, post(ME, `/api/watch/invites/${ID}`), env);
    expect(d1.rows).toHaveLength(0);
  });

  it("says nothing about an id that does not exist", async () => {
    const { env } = setup();
    expect((await decline(env, "ZZZZ00009999")).status).toBe(204);
  });
});
