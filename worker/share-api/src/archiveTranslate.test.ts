// Auto-translation of PARTNER comments, and the cache that makes it affordable.
//
// The properties pinned here are the cost ones. Phase 1 refused this feature outright
// on a Neuron budget, so what matters is not that a translation appears — it is that
// the SECOND reader of the same comment in the same language spends nothing, that a
// comment already in the reader's language is never sent to the model at all, and that
// a page whose translation could not run still tells the client to offer the on-device
// button instead of silently showing text nobody can read.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { srcHash, translateArchiveRows } from "./comments";

/** `archive_translations`, and nothing else. Throws on SQL it does not know. */
class FakeD1 {
  rows: Array<{ archive_id: string; lang: string; text: string; src_hash: number; created_at: number }> = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql.replace(/\s+/g, " ").trim());
  }
  async batch(stmts: FakeStmt[]) {
    for (const s of stmts) await s.run();
  }
}
class FakeStmt {
  private a: any[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.a = args as any[];
    return this;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.startsWith("SELECT archive_id, text, src_hash FROM archive_translations")) {
      const [lang, ...ids] = this.a;
      const want = new Set(ids);
      return { results: this.db.rows.filter((r) => r.lang === lang && want.has(r.archive_id)) as T[] };
    }
    throw new Error("unhandled SQL: " + this.sql);
  }
  async run() {
    if (this.sql.startsWith("INSERT INTO archive_translations")) {
      // ⚠️ `created_at` included. The poll route filters on it, so a fake that drops it
      // makes every freshly written row look infinitely old.
      const [archive_id, lang, text, src_hash, created_at] = this.a;
      const i = this.db.rows.findIndex((r) => r.archive_id === archive_id && r.lang === lang);
      const row = { archive_id, lang, text, src_hash, created_at };
      if (i >= 0) this.db.rows[i] = row;
      else this.db.rows.push(row);
      return;
    }
    throw new Error("unhandled SQL: " + this.sql);
  }
}

let db: FakeD1;
let run: ReturnType<typeof vi.fn>;

/** @param withAI false models both "no binding" and "allowance exhausted" — one path. */
const env = (withAI = true): any => ({
  DB: db,
  AI: withAI ? { run } : undefined,
});

/** The partner's wire shape, trimmed to the fields translation reads. */
const row = (id: string, text: string, language: string | null) => ({
  id,
  text,
  language,
  userName: "someone",
  origin: { slug: "tvtime", displayName: "TV Time" },
});

beforeEach(() => {
  db = new FakeD1();
  run = vi.fn(async (_model: string, input: any) => ({
    translated_text: `[${input.target_lang}] ${input.text}`,
  }));
});

describe("translating a partner's comments", () => {
  it("translates a foreign row and puts the result on the row itself", async () => {
    const out = (await translateArchiveRows(env(), [row("uuid-1", "Beste Folge", "de")], "en")) as any[];

    expect(out[0].translated).toBe("[en] Beste Folge");
    expect(out[0].translationFailed).toBe(false);
    // ⚠️ The original survives. The client renders `translated ?? body`, and an
    // overwritten original leaves a reader no way back to what was actually written.
    expect(out[0].text).toBe("Beste Folge");
    expect(out[0].origin.slug).toBe("tvtime");
  });

  it("⚠️ never calls the model for a comment already in the reader's language", async () => {
    const out = (await translateArchiveRows(env(), [row("uuid-1", "Best episode", "en")], "en")) as any[];

    expect(run).not.toHaveBeenCalled();
    // Not flagged failed either: there is nothing to offer on-device.
    expect(out[0].translated).toBeUndefined();
    expect(out[0].translationFailed).toBeUndefined();
  });

  it("⚠️ regional target codes match the base language — `pt-BR` is not a foreign language to `pt`", async () => {
    await translateArchiveRows(env(), [row("uuid-1", "Melhor episódio", "pt")], "pt-BR");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the cache — the whole reason this ships at all", () => {
  it("⚠️ a second reader in the same language spends NO model call", async () => {
    const rows = [row("uuid-1", "Beste Folge", "de")];
    await translateArchiveRows(env(), rows, "en");
    expect(run).toHaveBeenCalledTimes(1);

    run.mockClear();
    const out = (await translateArchiveRows(env(), rows, "en")) as any[];

    expect(run).not.toHaveBeenCalled();
    expect(out[0].translated).toBe("[en] Beste Folge");
  });

  it("caches per language, so a second language is a second entry rather than a hit", async () => {
    const rows = [row("uuid-1", "Beste Folge", "de")];
    await translateArchiveRows(env(), rows, "en");
    await translateArchiveRows(env(), rows, "fr");

    expect(run).toHaveBeenCalledTimes(2);
    expect(db.rows.map((r) => r.lang).sort()).toEqual(["en", "fr"]);
  });

  it("⚠️ is keyed on the BARE partner uuid, never our prefixed id", async () => {
    await translateArchiveRows(env(), [row("uuid-1", "Beste Folge", "de")], "en");
    expect(db.rows[0].archive_id).toBe("uuid-1");
  });

  it("⚠️ re-translates when the upstream text changed — the hash is the version", async () => {
    await translateArchiveRows(env(), [row("uuid-1", "Beste Folge", "de")], "en");
    run.mockClear();

    const out = (await translateArchiveRows(env(), [row("uuid-1", "Schlimmste Folge", "de")], "en")) as any[];

    expect(run).toHaveBeenCalledTimes(1);
    expect(out[0].translated).toBe("[en] Schlimmste Folge");
    // One row, not two: the edit replaces rather than accumulating a version per edit.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].src_hash).toBe(srcHash("Schlimmste Folge"));
  });
});

describe("degrading without breaking the page", () => {
  it("⚠️ flags a row the server could not translate, which is what shows the on-device button", async () => {
    const out = (await translateArchiveRows(env(false), [row("uuid-1", "Beste Folge", "de")], "en")) as any[];

    expect(out[0].translationFailed).toBe(true);
    expect(out[0].translated).toBeNull();
    // The row still renders in its original language rather than vanishing.
    expect(out[0].text).toBe("Beste Folge");
  });

  it("fails each comment on its own — one model hiccup must not empty the page", async () => {
    run.mockImplementation(async (_m: string, input: any) =>
      input.text === "zwei" ? Promise.reject(new Error("model hiccup")) : { translated_text: "ok" },
    );
    const rows = [row("uuid-1", "eins", "de"), row("uuid-2", "zwei", "de"), row("uuid-3", "drei", "de")];

    const out = (await translateArchiveRows(env(), rows, "en")) as any[];

    expect(out.map((r) => r.translationFailed)).toEqual([false, true, false]);
  });

  it("⚠️ fires every call TOGETHER — the sequential loop was the latency bug", async () => {
    run.mockRejectedValue(new Error("neurons exhausted"));
    const rows = [row("uuid-1", "eins", "de"), row("uuid-2", "zwei", "de"), row("uuid-3", "drei", "de")];

    const out = (await translateArchiveRows(env(), rows, "en")) as any[];

    // The old loop stopped at the first failure and called once. That ordering is
    // deliberately gone: discovering exhaustion three times costs three subrequests we
    // are capped on anyway, and buys back the 40s worst case a serial page would take.
    expect(run).toHaveBeenCalledTimes(3);
    expect(out.map((r) => r.translationFailed)).toEqual([true, true, true]);
  });

  it("⚠️ costs ONE model round trip for the page, not one per comment", async () => {
    run.mockImplementation(
      async (_m: string, input: any) =>
        new Promise((res) => setTimeout(() => res({ translated_text: `[x] ${input.text}` }), 120)),
    );
    const rows = ["eins", "zwei", "drei", "vier", "fünf"].map((t, i) => row(`uuid-${i}`, t, "de"));

    const started = Date.now();
    const out = (await translateArchiveRows(env(), rows, "en")) as any[];
    const elapsed = Date.now() - started;

    expect(out.every((r) => r.translated)).toBe(true);
    // Serial would be 5 × 120ms = 600ms. Measured against half that, so the assertion
    // fails on a regression to sequential rather than on a slow machine.
    expect(elapsed).toBeLessThan(300);
  });

  it("⚠️ a call slower than the deadline is failed for THIS reader but still cached", async () => {
    run.mockImplementation(
      async (_m: string, input: any) =>
        new Promise((res) => setTimeout(() => res({ translated_text: `[en] ${input.text}` }), 2_200)),
    );
    // A real ctx: without one the flush is awaited, which would defeat the deadline.
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as any;
    const rows = [row("uuid-1", "Beste Folge", "de")];

    const started = Date.now();
    const out = (await translateArchiveRows(env(), rows, "en", ctx)) as any[];
    const elapsed = Date.now() - started;

    // Shipped without waiting for the model.
    expect(elapsed).toBeLessThan(2_000);
    expect(out[0].translationFailed).toBe(true);
    expect(out[0].translated).toBeNull();

    // ...but the work was never cancelled, so the NEXT reader gets it free.
    await Promise.all(pending);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].text).toBe("[en] Beste Folge");

    run.mockClear();
    const second = (await translateArchiveRows(env(), rows, "en", ctx)) as any[];
    expect(run).not.toHaveBeenCalled();
    expect(second[0].translated).toBe("[en] Beste Folge");
  });

  it("⚠️ leaves a row with no detected language alone rather than flagging it failed", async () => {
    const out = (await translateArchiveRows(env(), [row("uuid-1", "?????", null)], "en")) as any[];

    expect(run).not.toHaveBeenCalled();
    // Flagging it would offer on-device translation, which needs a source language just
    // as badly as we do — a button that cannot work.
    expect(out[0].translationFailed).toBeUndefined();
  });

  it("⚠️ an older client that sends no `lang` gets exactly the response it got before", async () => {
    const rows = [row("uuid-1", "Beste Folge", "de")];
    const out = await translateArchiveRows(env(), rows, "");

    expect(run).not.toHaveBeenCalled();
    expect(out).toBe(rows);
  });
});

// ── The polling route ────────────────────────────────────────────────────────
//
// The sheet asks this a couple of seconds after it opens, for the comments the deadline
// gave up on. What matters is that it stays trivially cheap — a refetch of the real
// endpoint would spend a commsuni read_unit per poll — and that it cannot serve a
// translation of text the partner has since edited.

import { handleGetTranslations } from "./comments";

const UUID_A = "04fbee2d-1111-4222-8333-444455556666";
const UUID_B = "1dcf4bb9-1111-4222-8333-444455556666";

/** A FakeD1 that also answers the poll query, plus the session lookup that gates it. */
class PollD1 extends FakeD1 {
  /** Set false to model a signed-out caller. */
  signedIn = true;
  prepare(sql: string): any {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const ok = this.signedIn;
      return {
        bind() { return this; },
        async first() {
          return ok ? { user_id: "USER-A", expires_at: Date.now() + 60_000, revoked_at: null } : null;
        },
      };
    }
    if (norm.startsWith("SELECT archive_id, text FROM archive_translations")) {
      const db = this;
      return {
        _a: [] as any[],
        bind(...a: unknown[]) { this._a = a as any[]; return this; },
        async all() {
          const [lang, minAge, ...ids] = this._a;
          const want = new Set(ids);
          return {
            results: db.rows.filter(
              (r: any) => r.lang === lang && want.has(r.archive_id) && (r.created_at ?? 0) > (minAge as number),
            ),
          };
        },
      };
    }
    return super.prepare(sql);
  }
}

const pollReq = (ids: string[], lang = "en") =>
  new Request(`https://x.invalid/api/comments/translations?lang=${lang}&ids=${ids.join(",")}`, {
    headers: { Authorization: "Bearer t" },
  });

/** resolveSession reads the sessions table; a signed-in reader is the normal case. */
const pollEnv = (db: PollD1): any => ({
  DB: db,
  SESSION_OK: true,
});

describe("polling for late translations", () => {
  let pdb: PollD1;
  beforeEach(() => {
    pdb = new PollD1();
    db = pdb as any;
  });

  it("⚠️ hands back what the background write left, spending no model call", async () => {
    // The real sequence: a page translated (the write lands under waitUntil), then the
    // sheet polls for it. No pre-seeded row — this is the path a reader actually takes.
    await translateArchiveRows(env(), [row(UUID_A, "Beste Folge", "de")], "en");
    run.mockClear();

    const res = await handleGetTranslations(pollReq([UUID_A]), pollEnv(pdb), undefined);

    // The whole point: no inference, no upstream read_unit — one indexed D1 read.
    expect(run).not.toHaveBeenCalled();
    expect((await res.json() as any).translations[UUID_A]).toBe("[en] Beste Folge");
  });

  it("returns nothing for a comment still in flight, rather than erroring", async () => {
    const res = await handleGetTranslations(pollReq([UUID_B]), pollEnv(pdb), undefined);
    expect((await res.json() as any).translations).toEqual({});
  });

  it("⚠️ refuses a row old enough to have been overtaken by an upstream edit", async () => {
    pdb.rows.push({
      archive_id: UUID_A, lang: "en", text: "possibly stale",
      src_hash: 1, created_at: Date.now() - 10 * 60 * 1000,
    } as any);

    const res = await handleGetTranslations(pollReq([UUID_A]), pollEnv(pdb), undefined);

    // A stale translation is worse than none — the rule the whole cache is keyed on.
    expect((await res.json() as any).translations).toEqual({});
  });

  it("refuses a signed-out caller, like every other archive read (§1)", async () => {
    pdb.signedIn = false;
    const res = await handleGetTranslations(pollReq([UUID_A]), pollEnv(pdb), undefined);
    expect(res.status).toBe(401);
  });

  it("⚠️ ignores our own `{slug}:{uuid}` prefix, which means nothing to the table", async () => {
    pdb.rows.push({ archive_id: UUID_A, lang: "en", text: "Best episode", src_hash: 1, created_at: Date.now() } as any);

    const res = await handleGetTranslations(pollReq([`tvtime:${UUID_A}`]), pollEnv(pdb), undefined);

    expect((await res.json() as any).translations).toEqual({});
  });
});
