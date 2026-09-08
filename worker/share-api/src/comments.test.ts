// Comments in D1 — the surface that retires E2EE `social_opinions`.
//
// The properties pinned here are the ones that are silently wrong rather than
// visibly broken: the renderable predicate (a media-only comment has an empty
// body and must still count), the counter delta on a visibility change, the
// safe-direction visibility parse, and the rule that an edit keeps the existing
// row's id so reactions are not orphaned.

import { describe, it, expect } from "vitest";
import {
  handleDeleteComment,
  handleGetComments,
  handleGetFriendComments,
  handleGetReplies,
  handlePostComment,
  handleReactToComment,
  handleReportComment,
  parseSubject,
  PAGE_LIMIT,
} from "./comments";

const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const C = "CCCCK95Z9R77W60T6EHKFGFBY1";
const TOKENS: Record<string, string> = { "tok-a": A, "tok-b": B, "tok-c": C };

const MOVIE = { tmdbId: 603, mediaType: "movie" as const, season: -1, episode: -1 };

/**
 * Hand-rolled D1 stand-in, the shape `listsMatch.test.ts` established: every SQL
 * prefix the handlers issue gets an explicit branch, and anything unrecognised
 * throws. A fake that quietly answers "no rows" turns a broken query into a
 * passing test.
 */
class FakeD1 {
  comments: any[] = [];
  comment_reactions: any[] = [];
  friendships: any[] = [];
  blocks: any[] = [];
  profiles: any[] = [];
  reports: any[] = [];
  comment_translations: any[] = [];
  comment_write_events: any[] = [];
  sessions = new Map<string, string>();
  prepare(sql: string) {
    return new FakeStmt(this, sql.replace(/\s+/g, " ").trim());
  }
  async batch(stmts: FakeStmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
  /** The public comment count, now DERIVED from `comments` exactly as the app reads it. */
  count(tmdbId: number, mediaType: string, season = -1, episode = -1) {
    return this.comments.filter(
      (c) =>
        c.tmdb_id === tmdbId &&
        c.media_type === mediaType &&
        c.season === season &&
        c.episode === episode &&
        c.visibility === "public" &&
        c.hidden_at == null &&
        c.deleted_at == null &&
        (c.body !== "" || c.media_id != null),
    ).length;
  }
}

class FakeStmt {
  private args: any[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args as any[];
    return this;
  }

  /** Subject predicate shared by every comment query; binds are always [tmdb, type, season, episode]. */
  private onSubject(a: any[]) {
    return (c: any) => c.tmdb_id === a[0] && c.media_type === a[1] && c.season === a[2] && c.episode === a[3];
  }

  private renderable(c: any) {
    return c.hidden_at == null && c.deleted_at == null && (c.body !== "" || c.media_id != null);
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    const a = this.args;
    if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const u = this.db.sessions.get(a[0]);
      return u ? ({ user_id: u, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
    }
    if (s.startsWith("SELECT 1 AS hit FROM blocks")) {
      const hit = this.db.blocks.some(
        (b) => (b.blocker_id === a[0] && b.blocked_id === a[1]) || (b.blocker_id === a[2] && b.blocked_id === a[3]),
      );
      return hit ? ({ hit: 1 } as T) : null;
    }
    if (s.startsWith("SELECT state FROM friendships")) {
      const r = this.db.friendships.find((f) => f.user_a === a[0] && f.user_b === a[1] && f.state === "accepted");
      return r ? ({ state: r.state } as T) : null;
    }
    // Burst-limit ledger. Counted per user and per IP hash over a 60s window.
    if (s.startsWith("SELECT COUNT(*) AS n FROM comment_write_events WHERE user_id")) {
      return { n: this.db.comment_write_events.filter((e) => e.user_id === a[0] && e.created_at > a[1]).length } as T;
    }
    if (s.startsWith("SELECT COUNT(*) AS n FROM comment_write_events WHERE ip_hash")) {
      return { n: this.db.comment_write_events.filter((e) => e.ip_hash === a[0] && e.created_at > a[1]).length } as T;
    }
    // ⚠️ Matched EXACTLY, not by prefix. The per-subject cap's query below starts
    // with these same words, so a `startsWith` here silently answered it with the
    // product-wide count — and the per-subject cap then fired on every subject.
    if (s === "SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND created_at > ?") {
      return { n: this.db.comments.filter((c) => c.author_id === a[0] && c.created_at > a[1]).length } as T;
    }
    if (s.startsWith("SELECT id, author_id, visibility, hidden_at, deleted_at, body, media_id, created_at FROM comments")) {
      return (this.db.comments.find((c) => c.id === a[0]) as T) ?? null;
    }
    // The per-subject hourly cap. Distinct from the product-wide one above, which is
    // keyed on author alone — matched on the longer prefix so the two cannot collide.
    if (s.startsWith("SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND tmdb_id")) {
      return {
        n: this.db.comments.filter(
          (c) =>
            c.author_id === a[0] &&
            c.tmdb_id === a[1] &&
            c.media_type === a[2] &&
            c.season === a[3] &&
            c.episode === a[4] &&
            c.created_at > a[5],
        ).length,
      } as T;
    }
    if (s.startsWith("SELECT id, tmdb_id, media_type, season, episode, visibility, hidden_at")) {
      return (this.db.comments.find((c) => c.id === a[0] && c.author_id === a[1]) as T) ?? null;
    }
    if (s.startsWith("SELECT id, author_id, visibility, hidden_at, deleted_at FROM comments")) {
      return (this.db.comments.find((c) => c.id === a[0]) as T) ?? null;
    }
    // Reply parent resolution, for depth flattening.
    if (s.startsWith("SELECT id, parent_id, root_id, depth, tmdb_id")) {
      return (this.db.comments.find((c) => c.id === a[0]) as T) ?? null;
    }
    // The replies endpoint's parent gate.
    if (s.startsWith("SELECT id, author_id, visibility, hidden_at, deleted_at FROM comments WHERE id")) {
      return (this.db.comments.find((c) => c.id === a[0]) as T) ?? null;
    }
    // notifyReply's target read.
    if (s.startsWith("SELECT id, author_id, last_notified_at FROM comments")) {
      return (this.db.comments.find((c) => c.id === a[0]) as T) ?? null;
    }
    if (s.startsWith("SELECT display_name FROM profiles")) {
      const r = this.db.profiles.find((x) => x.user_id === a[0]);
      return r ? ({ display_name: r.display_name } as T) : null;
    }
    if (s.startsWith("SELECT emoji FROM comment_reactions")) {
      const r = this.db.comment_reactions.find((x) => x.comment_id === a[0] && x.user_id === a[1]);
      return r ? ({ emoji: r.emoji } as T) : null;
    }
    if (s.startsWith("SELECT display_name FROM profiles")) {
      const p = this.db.profiles.find((x) => x.user_id === a[0]);
      return p ? ({ display_name: p.display_name } as T) : null;
    }
    if (s.startsWith("SELECT COUNT(*) AS n FROM comment_reactions")) {
      const n = this.db.comment_reactions.filter((r) => r.comment_id === a[0]).length;
      return { n } as T;
    }
    if (s.startsWith("SELECT id, tmdb_id, media_type, season, episode, author_id, body")) {
      return (this.db.comments.find((c) => c.id === a[0]) as T) ?? null;
    }
    if (s.startsWith("SELECT 1 AS n FROM reports WHERE target_id = ?")) {
      return (this.db.reports.some((r: any) => r.target_id === a[0]) ? { n: 1 } : null) as T | null;
    }
    if (s.startsWith("SELECT id FROM reports")) {
      const r = this.db.reports.find(
        (x) => x.reporter_id === a[0] && x.target_id === a[1] && x.kind === a[2] && x.state === "open",
      );
      return r ? ({ id: r.id } as T) : null;
    }
    if (s.startsWith("SELECT COUNT(DISTINCT reporter_id) AS n FROM reports")) {
      const reporters = new Set(
        this.db.reports.filter((x) => x.target_id === a[0] && x.kind === a[1] && x.state === "open")
          .map((x) => x.reporter_id),
      );
      return { n: reporters.size } as T;
    }
    throw new Error(`FakeD1: unhandled first() ${s}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql;
    const a = this.args;
    if (s.startsWith("SELECT user_a, user_b, state, requested_by, updated_at FROM friendships")) {
      return { results: this.db.friendships.filter((f) => f.user_a === a[0] || f.user_b === a[1]) as T[] };
    }
    if (s.startsWith("SELECT c.lang AS lang, COUNT(*) AS n")) {
      const by = new Map<string, number>();
      for (const c of this.db.comments) {
        if (!this.onSubject(a)(c) || c.visibility !== "public" || !this.renderable(c)) continue;
        if (s.includes("c.parent_id IS NULL") && c.parent_id != null) continue;
        if (c.lang == null) continue;
        by.set(c.lang, (by.get(c.lang) ?? 0) + 1);
      }
      const results = [...by.entries()]
        .map(([lang, n]) => ({ lang, n }))
        .sort((x, y) => y.n - x.n);
      return { results: results as T[] };
    }
    // The inline reply preview: one windowed query for the whole page.
    if (s.startsWith("SELECT * FROM (")) {
      const parents = new Set(a.slice(0, a.length - 1));
      const perParent = a[a.length - 1];
      const seen = new Map<string, number>();
      const rows: any[] = [];
      for (const c of this.db.comments
        .filter((c) => c.parent_id != null && parents.has(c.parent_id) && this.renderable(c))
        .sort((x, y) => x.created_at - y.created_at)) {
        const n = (seen.get(c.parent_id) ?? 0) + 1;
        seen.set(c.parent_id, n);
        if (n <= perParent) {
          rows.push({ ...c, ...(this.db.profiles.find((p) => p.user_id === c.author_id) ?? {}) });
        }
      }
      return { results: rows as T[] };
    }
    // One page of replies under a parent, OLDEST first — a thread reads in the
    // order it was written, so the cursor is a floor rather than a ceiling.
    if (s.startsWith("SELECT c.id, c.tmdb_id, c.media_type") && s.includes("c.parent_id = ?")) {
      const rows = this.db.comments
        .filter((c) => c.parent_id === a[0] && c.created_at > a[1] && this.renderable(c))
        .sort((x, y) => x.created_at - y.created_at)
        .slice(0, a[2])
        .map((c) => ({ ...c, ...(this.db.profiles.find((p) => p.user_id === c.author_id) ?? {}) }));
      return { results: rows as T[] };
    }
    if (s.startsWith("SELECT c.id, c.tmdb_id, c.media_type")) {
      const isPublic = s.includes("c.visibility = 'public'");
      const cursor = isPublic ? a[4] : a[a.length - 2];
      const authors = isPublic ? null : new Set(a.slice(4, a.length - 2));
      const lang = isPublic && a.length > 6 ? a[5] : null;
      const rows = this.db.comments
        .filter(this.onSubject(a))
        .filter((c) => c.visibility === (isPublic ? "public" : "friends"))
        .filter((c) => (authors ? authors.has(c.author_id) : true))
        .filter((c) => {
          if (c.created_at >= cursor) return false;
          if (this.renderable(c)) return true;
          // A deleted parent that still has replies is LISTABLE as a tombstone.
          // Keyed on the SQL so removing the predicate fails the test.
          return (
            s.includes("c.deleted_at IS NOT NULL AND c.reply_count > 0") &&
            c.deleted_at != null &&
            (c.reply_count ?? 0) > 0
          );
        })
        // ⚠️ Conditional on the SQL actually SAYING so, not on what this fake
        // assumes the query does. Hardcoding `parent_id == null` here made the
        // "replies stay out of the list" test pass with the predicate removed from
        // the real query — a test that cannot fail is not a test.
        .filter((c) => (s.includes("c.parent_id IS NULL") ? c.parent_id == null : true))
        // Same rule, same reason: conditional on the SQL saying so, so removing the
        // predicate from the real query fails the test rather than passing it.
        .filter((c) => (s.includes("c.parent_archive_id IS NULL") ? c.parent_archive_id == null : true))
        .filter((c) => (lang ? c.lang == null || c.lang === lang : true))
        .sort((x, y) => y.created_at - x.created_at)
        .slice(0, PAGE_LIMIT)
        .map((c) => ({ ...c, ...(this.db.profiles.find((p) => p.user_id === c.author_id) ?? {}) }));
      return { results: rows as T[] };
    }
    if (s.startsWith("SELECT comment_id, text, src_updated_at FROM comment_translations")) {
      const ids = new Set(a.slice(1));
      return { results: this.db.comment_translations.filter((t) => t.lang === a[0] && ids.has(t.comment_id)) as T[] };
    }
    if (s.startsWith("SELECT comment_id, emoji, COUNT(*) AS n FROM comment_reactions")) {
      const ids = new Set(a);
      const by = new Map<string, { comment_id: string; emoji: string; n: number }>();
      for (const r of this.db.comment_reactions) {
        if (!ids.has(r.comment_id)) continue;
        const k = `${r.comment_id} ${r.emoji}`;
        const row = by.get(k) ?? { comment_id: r.comment_id, emoji: r.emoji, n: 0 };
        row.n += 1;
        by.set(k, row);
      }
      return { results: [...by.values()] as T[] };
    }
    if (s.startsWith("SELECT r.comment_id, r.emoji")) {
      const ids = new Set(this.db.comments.filter(this.onSubject(a.slice(1))).map((c) => c.id));
      return {
        results: this.db.comment_reactions.filter((r) => r.user_id === a[0] && ids.has(r.comment_id)) as T[],
      };
    }
    throw new Error(`FakeD1: unhandled all() ${s}`);
  }

  async run() {
    const s = this.sql;
    const a = this.args;
    if (s.startsWith("INSERT INTO comments")) {
      this.db.comments.push({
        id: a[0], tmdb_id: a[1], media_type: a[2], season: a[3], episode: a[4], author_id: a[5],
        body: a[6], reaction: a[7], visibility: a[8], spoiler: a[9], lang: a[10],
        media_kind: a[11], media_provider: a[12], media_id: a[13], media_url: a[14],
        media_w: a[15], media_h: a[16],
        parent_id: a[17], in_reply_to_id: a[18], root_id: a[19], depth: a[20],
        mentions_json: a[21], reply_count: 0,
        // ⚠️ Positional. Adding parent_archive_id shifted the timestamps by one, and
        // a fake that kept reading a[22] would store the created_at into it and a
        // `null` into created_at — every ordering assertion silently meaningless.
        parent_archive_id: a[22] ?? null,
        hidden_at: null, deleted_at: null,
        created_at: a[23], updated_at: a[24],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM comments WHERE id = ?")) {
      const before = this.db.comments.length;
      this.db.comments = this.db.comments.filter((c) => !(c.id === a[0] && c.author_id === a[1]));
      return { success: true, meta: { changes: before - this.db.comments.length } };
    }
    // The unreported-with-replies shape: tombstoned AND stripped in one statement.
    if (s.startsWith("UPDATE comments SET deleted_at = ?, updated_at = ?, body = ''")) {
      const r = this.db.comments.find((c) => c.id === a[2] && c.author_id === a[3]);
      if (r) {
        Object.assign(r, {
          deleted_at: a[0], updated_at: a[1], body: "", reaction: null,
          media_kind: null, media_provider: null, media_id: null, media_url: null,
          media_w: null, media_h: null, mentions_json: null, lang: null,
        });
      }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE comments SET body =")) {
      const r = this.db.comments.find((c) => c.id === a[13] && c.author_id === a[14]);
      if (r) {
        Object.assign(r, {
          body: a[0], reaction: a[1], visibility: a[2], spoiler: a[3], lang: a[4],
          media_kind: a[5], media_provider: a[6], media_id: a[7], media_url: a[8],
          media_w: a[9], media_h: a[10], mentions_json: a[11],
          deleted_at: null, updated_at: a[12],
        });
      }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // The maintained reply counter, bumped in the same batch as the reply's insert.
    if (s.startsWith("UPDATE comments SET reply_count = reply_count + 1")) {
      const r = this.db.comments.find((c) => c.id === a[0]);
      if (r) r.reply_count = (r.reply_count ?? 0) + 1;
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE comments SET reply_count = MAX(reply_count - 1, 0)")) {
      const r = this.db.comments.find((c) => c.id === a[0]);
      if (r) r.reply_count = Math.max((r.reply_count ?? 0) - 1, 0);
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE comments SET deleted_at")) {
      const r = this.db.comments.find((c) => c.id === a[2] && c.author_id === a[3]);
      if (r) Object.assign(r, { deleted_at: a[0], updated_at: a[1] });
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("INSERT INTO comment_translations")) {
      const row = this.db.comment_translations.find((t) => t.comment_id === a[0] && t.lang === a[1]);
      if (row) Object.assign(row, { text: a[2], src_updated_at: a[3] });
      else this.db.comment_translations.push({ comment_id: a[0], lang: a[1], text: a[2], src_updated_at: a[3] });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO comment_write_events")) {
      this.db.comment_write_events.push({ id: a[0], user_id: a[1], ip_hash: a[2], created_at: a[3] });
      return { success: true } as any;
    }
    if (s.startsWith("DELETE FROM comment_write_events")) {
      this.db.comment_write_events = this.db.comment_write_events.filter((e) => e.created_at > a[0]);
      return { success: true } as any;
    }
    if (s.startsWith("INSERT INTO reports")) {
      this.db.reports.push({
        id: a[0], reporter_id: a[1], target_id: a[2], kind: a[3], context: a[4],
        state: "open", created_at: a[5], body_snapshot: a[6],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE comments SET spoiler = 1")) {
      const r = this.db.comments.find((c) => c.id === a[0]);
      if (r) r.spoiler = 1;
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE comments SET last_notified_at")) {
      // Conditional claim: only the caller that finds a stale timestamp wins.
      const r = this.db.comments.find((c) => c.id === a[1] && (c.last_notified_at ?? 0) < a[2]);
      if (r) r.last_notified_at = a[0];
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE comments SET hidden_at")) {
      const r = this.db.comments.find((c) => c.id === a[1]);
      if (r) r.hidden_at = a[0];
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("INSERT INTO comment_reactions")) {
      const found = this.db.comment_reactions.find((r) => r.comment_id === a[0] && r.user_id === a[1]);
      if (found) Object.assign(found, { emoji: a[2], created_at: a[3] });
      else this.db.comment_reactions.push({ comment_id: a[0], user_id: a[1], emoji: a[2], created_at: a[3] });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM comment_reactions WHERE comment_id = ? AND user_id")) {
      this.db.comment_reactions = this.db.comment_reactions.filter(
        (r) => !(r.comment_id === a[0] && r.user_id === a[1]),
      );
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM comment_reactions")) {
      this.db.comment_reactions = this.db.comment_reactions.filter((r) => r.comment_id !== a[0]);
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() ${s}`);
  }
}

/**
 * `waitUntil` must actually retain the promise here.
 *
 * A `() => {}` stub silently discards it, so anything the handler defers — the
 * cache put, and the reaction notification — has not run by the time the assertion
 * does, and the test reads as "it never notified" rather than "we did not wait".
 */
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any;
const flush = async () => {
  while (pending.length) await pending.shift();
};

function env() {
  const db = new FakeD1();
  for (const [tok, uid] of Object.entries(TOKENS)) db.sessions.set(tok, uid);
  return { DB: db, FIREBASE_PROJECT_ID: "flickto-cf7b6" } as any;
}

/** `resolveSession` looks a session up by sha256(token), so the fake keys the same way. */
async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function withSessions(e: any) {
  for (const [tok, uid] of Object.entries(TOKENS)) e.DB.sessions.set(await hash(tok), uid);
  return e;
}

const get = (path: string, token?: string) =>
  new Request(`https://flickto.app${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

const post = (path: string, body: unknown, token?: string) =>
  new Request(`https://flickto.app${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

function seed(db: FakeD1, over: Partial<any> = {}) {
  const now = Date.now();
  const row = {
    id: "C1", tmdb_id: 603, media_type: "movie", season: -1, episode: -1, author_id: A,
    body: "hello", reaction: null, visibility: "public", spoiler: 0, lang: "en",
    media_kind: null, media_provider: null, media_id: null, media_url: null,
    media_w: null, media_h: null, hidden_at: null, deleted_at: null,
    created_at: now, updated_at: now, ...over,
  };
  db.comments.push(row);
  return row;
}

describe("subject parsing", () => {
  it("defaults to the title level with -1 sentinels, never null", () => {
    const s = parseSubject("movie", "603", new URLSearchParams());
    expect(s).toEqual({ tmdbId: 603, mediaType: "movie", season: -1, episode: -1 });
  });

  it("takes an episode subject only when both season and episode are present", () => {
    expect(parseSubject("show", "1399", new URLSearchParams("season=2&episode=5"))).toEqual({
      tmdbId: 1399, mediaType: "show", season: 2, episode: 5,
    });
    // A season with no episode is not a subject — it falls back to title level
    // rather than forking the counter into a row nothing ever reads.
    expect(parseSubject("show", "1399", new URLSearchParams("season=2"))?.season).toBe(-1);
  });

  it("rejects an episode subject on a movie, and anything malformed", () => {
    expect(parseSubject("movie", "603", new URLSearchParams("season=1&episode=1"))).toBeNull();
    expect(parseSubject("person", "603", new URLSearchParams())).toBeNull();
    expect(parseSubject("movie", "0", new URLSearchParams())).toBeNull();
  });
});

describe("the public list", () => {
  it("returns public comments to an unauthenticated reader", async () => {
    const e = env();
    seed(e.DB);
    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toHaveLength(1);
  });

  it("carries Cache-Control, because a Worker response is never cached implicitly", async () => {
    const e = env();
    seed(e.DB);
    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("never leaks a friends-only, hidden or deleted comment", async () => {
    const e = env();
    seed(e.DB, { id: "C1", visibility: "friends" });
    seed(e.DB, { id: "C2", hidden_at: Date.now() });
    seed(e.DB, { id: "C3", deleted_at: Date.now() });
    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    expect((await res.json()).comments).toEqual([]);
  });

  it("hides a reaction-only comment but SHOWS a media-only one", async () => {
    const e = env();
    // The media reaction lives as a column on `comments`, so "react without
    // commenting" is a row with an empty body. It must not render as a comment.
    seed(e.DB, { id: "C1", body: "", reaction: "loved" });
    // …but `body <> ''` alone would then also hide a GIF-only comment, which is
    // the trap: the predicate is `body <> '' OR media_id IS NOT NULL`.
    seed(e.DB, { id: "C2", body: "", media_id: "gif123", media_kind: "gif", media_provider: "giphy", media_url: "u" });
    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    const ids = (await res.json()).comments.map((c: any) => c.id);
    expect(ids).toEqual(["C2"]);
  });

  it("filters by language when one is asked for, and always names what is available", async () => {
    const e = env();
    seed(e.DB, { id: "C1", lang: "en" });
    seed(e.DB, { id: "C2", lang: "tr" });
    // Detection failing must never hide content, so a null lang always shows.
    seed(e.DB, { id: "C3", lang: null });
    const res = await handleGetComments(get("/api/titles/movie/603/comments?only=en"), e, MOVIE, ctx);
    const body = await res.json();
    expect(body.comments.map((c: any) => c.id).sort()).toEqual(["C1", "C3"]);
    // The picker has to name the options whether or not a filter is active.
    expect(body.languages).toEqual([
      { lang: "en", n: 1 },
      { lang: "tr", n: 1 },
    ]);
  });

  /**
   * ⚠️ The default. Asking for nothing must return EVERYTHING — a reader whose device
   * language happens to differ from the comments should not find an empty sheet, which
   * is what filtering-by-default produced.
   */
  it("returns every language when none is asked for", async () => {
    const e = env();
    seed(e.DB, { id: "C1", lang: "en" });
    seed(e.DB, { id: "C2", lang: "tr" });
    seed(e.DB, { id: "C3", lang: null });
    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    const body = await res.json();
    expect(body.comments.map((c: any) => c.id).sort()).toEqual(["C1", "C2", "C3"]);
  });
});

describe("translation", () => {
  /** Records every call so the tests can assert how many subrequests were spent. */
  const fakeAi = (impl: (text: string) => string) => {
    const calls: string[] = [];
    return {
      calls,
      run: async (_model: string, input: any) => {
        calls.push(input.text);
        return { translated_text: impl(input.text) };
      },
    };
  };

  /**
   * ⚠️ Automatic is the whole point. Translation used to require `?all=1`, an opt-in
   * behind an affordance that was never rendered — so in practice it never ran at all.
   */
  it("translates automatically, with no opt-in flag", async () => {
    const e = env();
    e.AI = fakeAi((t) => `EN(${t})`);
    seed(e.DB, { id: "C1", lang: "tr", body: "harika" });
    const res = await handleGetComments(get("/api/titles/movie/603/comments?lang=en"), e, MOVIE, ctx);
    expect(e.AI.calls).toEqual(["harika"]);
    expect((await res.json()).comments[0].translated).toBe("EN(harika)");
  });

  /** No target language, nothing to translate into — and no AI spent finding out. */
  it("spends nothing when the reader sends no language", async () => {
    const e = env();
    e.AI = fakeAi((t) => `EN(${t})`);
    seed(e.DB, { id: "C1", lang: "tr", body: "harika" });
    await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    expect(e.AI.calls).toEqual([]);
  });

  it("translates the other-language comments when asked, and caches the result", async () => {
    const e = env();
    e.AI = fakeAi((t) => `EN(${t})`);
    seed(e.DB, { id: "C1", lang: "tr", body: "harika", updated_at: 500 });
    seed(e.DB, { id: "C2", lang: "en", body: "already english" });

    const res = await handleGetComments(get("/api/titles/movie/603/comments?lang=en"), e, MOVIE, ctx);
    const byId = Object.fromEntries((await res.json()).comments.map((c: any) => [c.id, c]));
    expect(byId.C1.translated).toBe("EN(harika)");
    // A comment already in the reader's language costs nothing and offers nothing.
    expect(byId.C2.translated).toBeNull();
    expect(byId.C2.translationFailed).toBe(false);
    expect(e.AI.calls).toEqual(["harika"]);
    expect(e.DB.comment_translations).toEqual([
      { comment_id: "C1", lang: "en", text: "EN(harika)", src_updated_at: 500 },
    ]);
  });

  it("serves the cache without calling the model again", async () => {
    const e = env();
    e.AI = fakeAi((t) => `EN(${t})`);
    seed(e.DB, { id: "C1", lang: "tr", body: "harika", updated_at: 500 });
    e.DB.comment_translations.push({ comment_id: "C1", lang: "en", text: "cached", src_updated_at: 500 });

    const res = await handleGetComments(get("/api/titles/movie/603/comments?lang=en"), e, MOVIE, ctx);
    expect((await res.json()).comments[0].translated).toBe("cached");
    expect(e.AI.calls).toEqual([]);
  });

  it("⚠️ re-translates after an edit, because a stale translation is worse than none", async () => {
    const e = env();
    e.AI = fakeAi(() => "fresh");
    seed(e.DB, { id: "C1", lang: "tr", body: "değişti", updated_at: 900 });
    // Written against the pre-edit body. `src_updated_at` is what catches it —
    // without the column this text would stay cached forever while readers see
    // something that no longer matches the original.
    e.DB.comment_translations.push({ comment_id: "C1", lang: "en", text: "stale", src_updated_at: 500 });

    const res = await handleGetComments(get("/api/titles/movie/603/comments?lang=en"), e, MOVIE, ctx);
    expect((await res.json()).comments[0].translated).toBe("fresh");
  });

  it("flags a failing comment instead of failing the whole fetch", async () => {
    const e = env();
    let n = 0;
    e.AI = {
      calls: [] as string[],
      run: async (_m: string, input: any) => {
        (e.AI.calls as string[]).push(input.text);
        n++;
        throw new Error("allowance exhausted");
      },
    };
    for (const id of ["C1", "C2", "C3"]) {
      seed(e.DB, { id, lang: "tr", body: `t-${id}`, created_at: Date.now() - Number(id[1]) });
    }
    const res = await handleGetComments(get("/api/titles/movie/603/comments?lang=en"), e, MOVIE, ctx);
    const body = await res.json();

    // The page still renders — the whole point of catching per comment.
    expect(body.comments).toHaveLength(3);
    expect(body.comments.every((c: any) => c.translationFailed)).toBe(true);
    // ⚠️ **Three, not one.** This asserted `1` while the calls were sequential and
    // stopped at the first failure. They now run TOGETHER, so an exhausted allowance is
    // discovered once per comment — three wasted subrequests out of a per-request cap
    // that is not otherwise spent, traded for the reason the loop was unwound: at ~1.95s
    // per call, a page of twenty foreign comments took ~40s serially and now takes one
    // round trip. See the doc on `translate` in comments.ts.
    expect(n).toBe(3);
  });

  it("flags everything untranslated when there is no AI binding at all", async () => {
    const e = env();
    seed(e.DB, { id: "C1", lang: "tr", body: "harika" });
    const res = await handleGetComments(get("/api/titles/movie/603/comments?lang=en"), e, MOVIE, ctx);
    // One code path for "no binding" and "allowance gone": both mean the client
    // should offer to translate on the device.
    expect((await res.json()).comments[0].translationFailed).toBe(true);
  });

  it("keys the cache on the filter as well as the language, so pages never collide", async () => {
    // Both are per-language rather than per-reader, so both are cacheable — but a
    // narrowed page and a full one are different responses and must not share an entry.
    const e = env();
    e.AI = fakeAi((t) => `EN(${t})`);
    seed(e.DB, { id: "C1", lang: "tr", body: "harika" });
    const all = await handleGetComments(get("/api/titles/movie/603/comments?lang=en"), e, MOVIE, ctx);
    const onlyEn = await handleGetComments(get("/api/titles/movie/603/comments?lang=en&only=en"), e, MOVIE, ctx);
    expect((await all.json()).comments).toHaveLength(1);
    expect((await onlyEn.json()).comments).toHaveLength(0);
  });
});

describe("the friends slice", () => {
  it("is 401 unauthenticated — it is the one path that must never be cached or public", async () => {
    const e = env();
    const res = await handleGetFriendComments(get("/api/titles/movie/603/comments/friends"), e, MOVIE, ctx);
    expect(res.status).toBe(401);
  });

  it("shows a friend's friends-only comment and the caller's own, but not a stranger's", async () => {
    const e = await withSessions(env());
    e.DB.friendships.push({ user_a: A, user_b: B, state: "accepted", requested_by: A, updated_at: 0 });
    seed(e.DB, { id: "MINE", author_id: A, visibility: "friends" });
    seed(e.DB, { id: "FRIEND", author_id: B, visibility: "friends" });
    seed(e.DB, { id: "STRANGER", author_id: C, visibility: "friends" });
    const res = await handleGetFriendComments(get("/api/titles/movie/603/comments/friends", "tok-a"), e, MOVIE, ctx);
    const ids = (await res.json()).comments.map((c: any) => c.id).sort();
    expect(ids).toEqual(["FRIEND", "MINE"]);
  });

  it("carries the caller's own reactions, which the cached path can never do", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1" });
    e.DB.comment_reactions.push({ comment_id: "C1", user_id: A, emoji: "🔥", created_at: 0 });
    const res = await handleGetFriendComments(get("/api/titles/movie/603/comments/friends", "tok-a"), e, MOVIE, ctx);
    expect((await res.json()).myReactions).toEqual({ C1: "🔥" });
  });
});

describe("writing", () => {
  const body = (over: Partial<any> = {}) => ({
    id: "0123456789ABCDEF", tmdbId: 603, mediaType: "movie", body: "nice", visibility: "public", ...over,
  });

  it("writes a public comment and increments the public counter in the same batch", async () => {
    const e = await withSessions(env());
    const res = await handlePostComment(post("/api/comments", body(), "tok-a"), e, ctx);
    expect(res.status).toBe(200);
    expect(e.DB.comments).toHaveLength(1);
    expect(e.DB.count(603, "movie")).toBe(1);
  });

  it("parses visibility in the SAFE direction — anything unrecognised is friends-only", async () => {
    const e = await withSessions(env());
    await handlePostComment(post("/api/comments", body({ visibility: "everyone" }), "tok-a"), e, ctx);
    expect(e.DB.comments[0].visibility).toBe("friends");
    // …and a friends-only comment must not touch the PUBLIC counter, which would
    // otherwise show a number the reader cannot reconcile with what they see.
    expect(e.DB.count(603, "movie")).toBe(0);
  });

  it("keeps the EXISTING row's id on an edit, so reactions are not orphaned", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "ORIGINAL", author_id: A });
    // ⚠️ Addressed by ID now. The same request naming a DIFFERENT id is no longer
    // an edit of this row — it is a second comment. See the test below.
    const res = await handlePostComment(post("/api/comments", body({ id: "ORIGINAL" }), "tok-a"), e, ctx);
    expect((await res.json()).id).toBe("ORIGINAL");
    expect(e.DB.comments).toHaveLength(1);
  });

  it("writes a SECOND comment on a subject the author has already commented on", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "ORIGINAL", author_id: A });
    const res = await handlePostComment(post("/api/comments", body({ id: "SECONDONE" }), "tok-a"), e, ctx);
    expect(res.status).toBe(200);
    // The whole point of A1: one comment per user per subject is lifted. Before this,
    // the by-subject lookup turned this request into an edit of ORIGINAL.
    expect(e.DB.comments).toHaveLength(2);
    expect((await res.json()).id).toBe("SECONDONE");
  });

  it("⚠️ refuses an edit of someone ELSE's comment, as a 404 rather than a 403", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "THEIRSCOMMENT", author_id: B, body: "theirs" });
    // Ownership was implicit while the lookup was by (author, subject) — it could only
    // ever return the caller's own row. Addressing by id makes it a guessable
    // parameter, so the check has to be explicit. 404 so ids cannot be probed.
    const res = await handlePostComment(post("/api/comments", body({ id: "THEIRSCOMMENT" }), "tok-a"), e, ctx);
    expect(res.status).toBe(404);
    expect(e.DB.comments[0].body).toBe("theirs");
  });

  it("drops from the public count when an edit changes visibility, in both directions", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "SEEDCOMMENT01", author_id: A, visibility: "public" });

    await handlePostComment(
      post("/api/comments", body({ id: "SEEDCOMMENT01", visibility: "friends" }), "tok-a"),
      e,
      ctx,
    );
    expect(e.DB.count(603, "movie")).toBe(0);

    await handlePostComment(
      post("/api/comments", body({ id: "SEEDCOMMENT01", visibility: "public" }), "tok-a"),
      e,
      ctx,
    );
    expect(e.DB.count(603, "movie")).toBe(1);
  });

  it("⚠️ accepts a LEGACY friendId-shaped id, which Crockford base32 would reject", async () => {
    const e = await withSessions(env());
    // The social_opinions migration reuses `{friendId}:{tmdbId}` ids so a re-run
    // and a second device are idempotent — and a device friendId is [A-Z0-9],
    // which includes I, L, O and U. Crockford excludes exactly those four, so a
    // narrower regex would 400 every migrated comment containing one, silently.
    const res = await handlePostComment(
      post("/api/comments", body({ id: "QUILLOU12345:603" }), "tok-a"),
      e,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("tells every accepted friend about a NEW comment, with a renderable name", async () => {
    const e = await withSessions(env());
    e.DB.friendships.push({ user_a: A, user_b: B, state: "accepted", requested_by: A, updated_at: 0 });
    e.DB.friendships.push({ user_a: A, user_b: C, state: "accepted", requested_by: A, updated_at: 0 });
    e.DB.profiles.push({ user_id: A, display_name: "Alex" });
    const calls: Array<{ userId: string; data: Record<string, string> }> = [];

    await handlePostComment(post("/api/comments", body(), "tok-a"), e, ctx, (userId, data) =>
      calls.push({ userId, data }),
    );
    await flush();

    expect(calls.map((c) => c.userId).sort()).toEqual([B, C].sort());
    // The client cannot render "Alex commented" from an opaque id, and making each
    // recipient look it up would turn one push into one request per friend.
    expect(calls[0].data.authorName).toBe("Alex");
    expect(calls[0].data.kind).toBe("friend_comment");
  });

  it("⚠️ does NOT re-notify on an edit", async () => {
    const e = await withSessions(env());
    e.DB.friendships.push({ user_a: A, user_b: B, state: "accepted", requested_by: A, updated_at: 0 });
    const calls: string[] = [];
    const notify = (userId: string) => calls.push(userId);

    await handlePostComment(post("/api/comments", body(), "tok-a"), e, ctx, notify);
    await flush();
    await handlePostComment(post("/api/comments", body({ body: "corrected" }), "tok-a"), e, ctx, notify);
    await flush();

    // Editing is allowed forever, so notifying on every write would let one person
    // re-notify all their friends by retyping a word.
    expect(calls).toEqual([B]);
  });

  it("notifies nobody when the author has no friends", async () => {
    const e = await withSessions(env());
    const calls: string[] = [];
    await handlePostComment(post("/api/comments", body(), "tok-a"), e, ctx, (userId) => calls.push(userId));
    await flush();
    expect(calls).toEqual([]);
  });

  it("refuses a comment with no text, no media and no reaction", async () => {
    const e = await withSessions(env());
    const res = await handlePostComment(post("/api/comments", body({ body: "  " }), "tok-a"), e, ctx);
    expect(res.status).toBe(400);
  });

  it("rate-limits NEW comments but never edits", async () => {
    const e = await withSessions(env());
    e.COMMENTS_PER_HOUR = "1";
    // ⚠️ Distinct ids. The id is what distinguishes a create from an edit now, so
    // reusing one across two subjects would read as an edit and never be charged.
    await handlePostComment(post("/api/comments", body({ id: "AAAAAAAAAAAA", tmdbId: 1 }), "tok-a"), e, ctx);
    const blocked = await handlePostComment(
      post("/api/comments", body({ id: "BBBBBBBBBBBB", tmdbId: 2 }), "tok-a"),
      e,
      ctx,
    );
    expect(blocked.status).toBe(429);
    // The same author editing what they already wrote is not spending budget.
    const edit = await handlePostComment(
      post("/api/comments", body({ id: "AAAAAAAAAAAA", tmdbId: 1, body: "fixed" }), "tok-a"),
      e,
      ctx,
    );
    expect(edit.status).toBe(200);
  });

  it("⚠️ caps NEW comments per SUBJECT, the control that replaced one-per-subject", async () => {
    const e = await withSessions(env());
    // `COMMENTS_PER_HOUR` is product-wide, so without this cap one author could spend
    // the entire hourly budget flooding a single title's sheet — which is exactly what
    // one-comment-per-user-per-subject used to make impossible.
    e.COMMENTS_PER_SUBJECT_PER_HOUR = "2";
    const write = (id: string, over: Record<string, unknown> = {}) =>
      handlePostComment(post("/api/comments", body({ id, ...over }), "tok-a"), e, ctx);

    expect((await write("AAAAAAAAAAAA")).status).toBe(200);
    expect((await write("BBBBBBBBBBBB")).status).toBe(200);
    expect((await write("CCCCCCCCCCCC")).status).toBe(429);

    // …and it is PER SUBJECT: a different title is unaffected.
    expect((await write("DDDDDDDDDDDD", { tmdbId: 604 })).status).toBe(200);
    // …and an EDIT of an existing row is never charged, exactly as the hourly cap.
    expect((await write("AAAAAAAAAAAA", { body: "fixed" })).status).toBe(200);
  });

  it("keeps a hidden comment hidden through an edit", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "SEEDCOMMENT01", author_id: A, hidden_at: 123 });
    await handlePostComment(
      post("/api/comments", body({ id: "SEEDCOMMENT01", body: "rewritten" }), "tok-a"),
      e,
      ctx,
    );
    expect(e.DB.comments[0].hidden_at).toBe(123);
  });
});

describe("replies", () => {
  const body = (over: Partial<any> = {}) => ({
    id: "0123456789ABCDEF", tmdbId: 603, mediaType: "movie", body: "nice", visibility: "public", ...over,
  });
  const write = (e: any, id: string, over: Record<string, unknown> = {}, token = "tok-a") =>
    handlePostComment(post("/api/comments", body({ id, ...over }), token), e, ctx);
  const del = (e: any, id: string, token: string) =>
    handleDeleteComment(
      id,
      new Request("https://flickto.app/api/comments/" + id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token },
      }),
      e,
      ctx,
    );

  it("stores a reply under its parent and bumps the maintained count", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    const res = await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001", body: "agreed" });
    expect(res.status).toBe(200);

    const reply = e.DB.comments.find((c: any) => c.id === "REPLY0000001");
    expect(reply.parent_id).toBe("TOPLEVEL0001");
    expect(reply.depth).toBe(1);
    expect(reply.root_id).toBe("TOPLEVEL0001");
    // Maintained, not counted per read: a correlated subquery here would multiply
    // the cost of the hottest query in the product.
    expect(e.DB.comments.find((c: any) => c.id === "TOPLEVEL0001").reply_count).toBe(1);
  });

  it("flattens past depth 2, keeping who was actually answered", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001" });
    await write(e, "REPLY0000002", { parentId: "REPLY0000001" });
    // Replying to a depth-2 comment. The row is stored AT the cap under the same
    // parent, and in_reply_to_id is what stops the answer being lost.
    await write(e, "REPLY0000003", { parentId: "REPLY0000002" });

    const two = e.DB.comments.find((c: any) => c.id === "REPLY0000002");
    const three = e.DB.comments.find((c: any) => c.id === "REPLY0000003");
    expect(two.depth).toBe(2);
    expect(three.depth).toBe(2);
    expect(three.parent_id).toBe(two.parent_id);
    expect(three.in_reply_to_id).toBe("REPLY0000002");
    expect(three.root_id).toBe("TOPLEVEL0001");
  });

  it("keeps replies OUT of the top-level list", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001" });

    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    const out = await res.json();
    // Otherwise a thread's replies appear as loose rows in created_at order,
    // detached from what they answer, spending the page limit.
    expect(out.comments.map((c: any) => c.id)).toEqual(["TOPLEVEL0001"]);
    expect(out.comments[0].replyCount).toBe(1);
  });

  it("carries an inline preview, so a short thread needs no expand call", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001", body: "first reply" });
    await write(e, "REPLY0000002", { parentId: "TOPLEVEL0001", body: "second reply" });

    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    const out = await res.json();
    expect(out.comments[0].replies.map((r: any) => r.body)).toEqual(["first reply", "second reply"]);
  });

  it("returns a reply page oldest-first, unlike the top-level list", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001", body: "earlier" });
    e.DB.comments[e.DB.comments.length - 1].created_at = 1000;
    await write(e, "REPLY0000002", { parentId: "TOPLEVEL0001", body: "later" });
    e.DB.comments[e.DB.comments.length - 1].created_at = 2000;

    const res = await handleGetReplies("TOPLEVEL0001", get("/api/comments/TOPLEVEL0001/replies"), e, ctx);
    const out = await res.json();
    expect(out.comments.map((c: any) => c.body)).toEqual(["earlier", "later"]);
  });

  it("hides a whole subtree from the replies route when the parent is hidden", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001" });
    e.DB.comments.find((c: any) => c.id === "TOPLEVEL0001").hidden_at = Date.now();

    // Moderation must not be escapable by addressing the subtree directly.
    const res = await handleGetReplies("TOPLEVEL0001", get("/api/comments/TOPLEVEL0001/replies"), e, ctx);
    expect(res.status).toBe(404);
  });

  it("refuses a reply to a hidden or missing parent", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    e.DB.comments[0].hidden_at = Date.now();
    expect((await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001" })).status).toBe(404);
    expect((await write(e, "REPLY0000002", { parentId: "NOSUCHPARENT0" })).status).toBe(404);
  });

  it("refuses a reply whose subject differs from its parent's", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    // The reply would land on a page its parent is not on, where nothing renders it.
    const res = await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001", tmdbId: 604 });
    expect(res.status).toBe(400);
  });

  it("decrements the parent's count when a reply is deleted, never below zero", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001" });

    await del(e, "REPLY0000001", "tok-a");
    expect(e.DB.comments.find((c: any) => c.id === "TOPLEVEL0001").reply_count).toBe(0);
    await del(e, "REPLY0000001", "tok-a");
    expect(e.DB.comments.find((c: any) => c.id === "TOPLEVEL0001").reply_count).toBe(0);
  });

  it("tombstones a deleted parent rather than cascading over other people's words", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001" }, "tok-b");

    await del(e, "TOPLEVEL0001", "tok-a");

    // B's reply is B's to delete. The parent row survives as a tombstone so the
    // subtree is not orphaned, and reply_count is left alone - it is what tells the
    // client to draw the tombstone rather than omit the row.
    const reply = e.DB.comments.find((c: any) => c.id === "REPLY0000001");
    expect(reply.deleted_at).toBeFalsy();
    expect(e.DB.comments.find((c: any) => c.id === "TOPLEVEL0001").reply_count).toBe(1);
  });

  it("serves the replies under a DELETED parent, past the inline preview", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001", { body: "the original" });
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001", body: "reply one" }, "tok-b");
    await write(e, "REPLY0000002", { parentId: "TOPLEVEL0001", body: "reply two" }, "tok-b");
    await write(e, "REPLY0000003", { parentId: "TOPLEVEL0001", body: "reply three" }, "tok-c");
    await del(e, "TOPLEVEL0001", "tok-a");

    // The tombstone advertises three but carries only the two-reply preview, so the
    // client MUST be able to expand for the rest. This route used to 404 on any
    // deleted parent, which truncated every tombstoned thread at two replies with no
    // error - the client swallows the failure and the badge silently overpromises.
    const list = await (await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx)).json();
    expect(list.comments[0].replyCount).toBe(3);
    expect(list.comments[0].replies).toHaveLength(2);

    const res = await handleGetReplies("TOPLEVEL0001", get("/api/comments/TOPLEVEL0001/replies"), e, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).comments.map((c: any) => c.body)).toEqual([
      "reply one",
      "reply two",
      "reply three",
    ]);
  });

  it("still refuses the subtree of a HIDDEN parent", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001" }, "tok-b");
    e.DB.comments.find((c: any) => c.id === "TOPLEVEL0001").hidden_at = Date.now();

    // The half of the old guard that must NOT relax: moderation is escapable if the
    // subtree can be addressed directly.
    const res = await handleGetReplies("TOPLEVEL0001", get("/api/comments/TOPLEVEL0001/replies"), e, ctx);
    expect(res.status).toBe(404);
  });

  it("serves a FRIENDS-ONLY deleted parent's replies to a friend, and nobody else", async () => {
    const e = await withSessions(env());
    e.DB.friendships.push({ user_a: A, user_b: B, state: "accepted", requested_by: A, updated_at: 0 });
    await write(e, "TOPLEVEL0001", { visibility: "friends" });
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001", visibility: "friends" }, "tok-b");
    await del(e, "TOPLEVEL0001", "tok-a");

    // `mayReadComment` refuses a deleted row outright, so the visibility branch had
    // to be told the parent is only the ACCESS RULE here, not the thing being read.
    const friend = await handleGetReplies("TOPLEVEL0001", get("/api/comments/TOPLEVEL0001/replies", "tok-b"), e, ctx);
    expect(friend.status).toBe(200);
    expect((await friend.json()).comments).toHaveLength(1);

    // A stranger is still refused - relaxing the deleted check must not relax this one.
    const stranger = await handleGetReplies("TOPLEVEL0001", get("/api/comments/TOPLEVEL0001/replies", "tok-c"), e, ctx);
    expect(stranger.status).toBe(404);
  });

  // ── Replying into another app's thread ──────────────────────────────────

  it("stores a reply to an ARCHIVE comment against the partner id, not parent_id", async () => {
    const e = await withSessions(env());
    const archiveId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

    const res = await handlePostComment(
      post("/api/comments", body({ id: "REPLY0000001", parentArchiveId: archiveId, visibility: "public" }), "tok-a"),
      e,
      ctx,
    );
    expect(res.status).toBe(200);

    const row = e.DB.comments.find((c: any) => c.id === "REPLY0000001");
    // ⚠️ parent_id stays NULL: the thing this answers has never been in our table, and
    // the depth/flatten walk would chase a row that cannot exist.
    expect(row.parent_id).toBeNull();
    expect(row.parent_archive_id).toBe(archiveId);
    // The timestamps must survive the column being added in the middle of the insert.
    expect(typeof row.created_at).toBe("number");
    expect(row.created_at).toBeGreaterThan(0);
  });

  it("keeps an archive reply OUT of the top-level list", async () => {
    const e = await withSessions(env());
    const archiveId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    await write(e, "TOPLEVEL0001", { visibility: "public" });
    await handlePostComment(
      post("/api/comments", body({ id: "REPLY0000001", parentArchiveId: archiveId, visibility: "public" }), "tok-a"),
      e,
      ctx,
    );

    // It is a reply — it just belongs to a thread we do not own. Listing it beside the
    // top-level rows would detach it from its conversation and spend a page slot.
    const out = await (await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx)).json();
    expect(out.comments.map((c: any) => c.id)).toEqual(["TOPLEVEL0001"]);
  });

  it("refuses a friends-only reply into another app's thread", async () => {
    const e = await withSessions(env());
    const res = await handlePostComment(
      post(
        "/api/comments",
        body({ id: "REPLY0000001", parentArchiveId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", visibility: "friends" }),
        "tok-a",
      ),
      e,
      ctx,
    );
    // The mirror only ever publishes public rows, so a friends-only reply would be
    // accepted and then never reach the person it answers.
    expect(res.status).toBe(400);
    expect(e.DB.comments).toHaveLength(0);
  });

  it("refuses a request carrying BOTH parent kinds, rather than picking one", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    const res = await handlePostComment(
      post(
        "/api/comments",
        body({
          id: "REPLY0000001",
          parentId: "TOPLEVEL0001",
          parentArchiveId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
          visibility: "public",
        }),
        "tok-a",
      ),
      e,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a PREFIXED archive id — the slug is a rendering key, not an id", async () => {
    const e = await withSessions(env());
    const res = await handlePostComment(
      post(
        "/api/comments",
        body({
          id: "REPLY0000001",
          parentArchiveId: "showrss:3f2504e0-4f89-11d3-9a0c-0305e82c3301",
          visibility: "public",
        }),
        "tok-a",
      ),
      e,
      ctx,
    );
    // The mirror posts to /comments/{parentArchiveId}/replies, where a prefixed value
    // is a 404 — so it must never reach storage in the first place.
    expect(res.status).toBe(400);
  });

  it("notifies the person ANSWERED, not the author's friend list", async () => {
    const e = await withSessions(env());
    e.DB.friendships.push({ user_a: A, user_b: C, state: "accepted", requested_by: A, updated_at: 0 });
    e.DB.profiles.push({ user_id: A, display_name: "Alex" });
    await write(e, "TOPLEVEL0001", {}, "tok-b");

    const calls: Array<{ userId: string; data: Record<string, string> }> = [];
    await handlePostComment(
      post("/api/comments", body({ id: "REPLY0000001", parentId: "TOPLEVEL0001" }), "tok-a"),
      e,
      ctx,
      (userId, data) => calls.push({ userId, data }),
    );
    await flush();

    // Fanning "Alex commented" out per reply would turn one busy thread into a
    // notification storm, and C, a friend, is not part of this conversation.
    expect(calls.map((c) => c.userId)).toEqual([B]);
    expect(calls[0].data.kind).toBe("comment_reply");
    expect(calls[0].data.authorName).toBe("Alex");
  });

  it("never notifies you about a reply to your own comment", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    const calls: string[] = [];
    await handlePostComment(
      post("/api/comments", body({ id: "REPLY0000001", parentId: "TOPLEVEL0001" }), "tok-a"),
      e,
      ctx,
      (userId) => calls.push(userId),
    );
    await flush();
    expect(calls).toEqual([]);
  });

  it("stores mention spans, and drops malformed ones rather than the comment", async () => {
    const e = await withSessions(env());
    const res = await write(e, "TOPLEVEL0001", {
      mentions: [
        { authorId: B, start: 0, end: 5, text: "@Bee" },
        { authorId: "not-a-user-id", start: 0, end: 5, text: "@nope" },
        { authorId: C, start: 9, end: 4, text: "@backwards" },
      ],
    });
    expect(res.status).toBe(200);
    // Rendering reads these spans, so a bad one is a rendering bug in every app
    // that consumes the mirrored row - ours and every other partner's.
    const stored = JSON.parse(e.DB.comments[0].mentions_json);
    expect(stored).toHaveLength(1);
    expect(stored[0].authorId).toBe(B);
  });

  it("keeps a DELETED parent in the list as a tombstone, so its thread is not orphaned", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001", { body: "the original text" });
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001", body: "a reply" }, "tok-b");
    await del(e, "TOPLEVEL0001", "tok-a");

    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    const out = await res.json();

    // Without this the parent leaves the list (RENDERABLE excludes deleted rows) and
    // its replies - other people's words, deliberately not cascaded - become
    // unreachable through any route.
    expect(out.comments).toHaveLength(1);
    const row = out.comments[0];
    expect(row.deleted).toBe(true);
    expect(row.replyCount).toBe(1);
    // A tombstone carries NOTHING of the original.
    expect(row.body).toBe("");
    expect(row.authorId).toBe("");
    expect(row.media).toBeNull();
    expect(row.replies.map((r: any) => r.body)).toEqual(["a reply"]);
  });

  it("drops a deleted comment with NO replies entirely, rather than tombstoning it", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await del(e, "TOPLEVEL0001", "tok-a");

    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    // Nothing hangs off it, so there is nothing to hold a place for.
    expect((await res.json()).comments).toEqual([]);
  });

  it("never re-parents a comment on an edit", async () => {
    const e = await withSessions(env());
    await write(e, "TOPLEVEL0001");
    await write(e, "REPLY0000001", { parentId: "TOPLEVEL0001" });
    await write(e, "OTHERTOP0001");

    await write(e, "REPLY0000001", { parentId: "OTHERTOP0001", body: "edited" });

    // Re-parenting a comment that already has replies would strand the subtree.
    const reply = e.DB.comments.find((c: any) => c.id === "REPLY0000001");
    expect(reply.parent_id).toBe("TOPLEVEL0001");
    expect(reply.body).toBe("edited");
  });
});

describe("reacting", () => {
  const react = (e: any, id: string, emoji: string, token: string) =>
    handleReactToComment(id, post(`/api/comments/${id}/reaction`, { emoji }, token), e, ctx);
  const unreactRequest = (id: string, token: string) =>
    new Request(`https://flickto.app/api/comments/${id}/reaction`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  const unreact = (e: any, id: string, token: string) =>
    handleReactToComment(id, unreactRequest(id, token), e, ctx);
  // Counts are DERIVED from the reaction rows now, exactly as loadReactionCounts does.
  const countOf = (e: any, emoji: string) =>
    e.DB.comment_reactions.filter((r: any) => r.emoji === emoji).length;

  it("records the reaction, and its count derives from the row", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    expect((await react(e, "C1", "🔥", "tok-a")).status).toBe(204);
    expect(e.DB.comment_reactions).toHaveLength(1);
    expect(countOf(e, "🔥")).toBe(1);
  });

  it("moves the count when the reaction CHANGES, rather than adding a second row", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    await react(e, "C1", "🔥", "tok-a");
    await react(e, "C1", "😂", "tok-a");
    expect(e.DB.comment_reactions).toHaveLength(1);
    expect(countOf(e, "🔥")).toBe(0);
    expect(countOf(e, "😂")).toBe(1);
  });

  it("is idempotent on a re-tap of the same emoji", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    await react(e, "C1", "🔥", "tok-a");
    await react(e, "C1", "🔥", "tok-a");
    expect(countOf(e, "🔥")).toBe(1);
  });

  it("removes the reaction and decrements on DELETE", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    await react(e, "C1", "🔥", "tok-a");
    expect((await unreact(e, "C1", "tok-a")).status).toBe(204);
    expect(e.DB.comment_reactions).toEqual([]);
    expect(countOf(e, "🔥")).toBe(0);
  });

  it("rejects an emoji outside the fixed six", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    // 💩 in particular: a picker creates a reaction-moderation surface that the
    // fixed set simply does not have.
    expect((await react(e, "C1", "💩", "tok-a")).status).toBe(400);
  });

  it("answers 404 for a friends-only comment by a stranger, exactly as for a missing one", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: C, visibility: "friends" });
    expect((await react(e, "C1", "🔥", "tok-a")).status).toBe(404);
    expect((await react(e, "NOPE0000", "🔥", "tok-a")).status).toBe(404);
  });

  // ── Notifying the author ────────────────────────────────────────────────
  // The one notification a STRANGER can trigger, so its volume is
  // attacker-controllable and every guard below is load-bearing.

  /** Captures `notify(userId, data)` calls so the guards can be asserted. */
  const spy = () => {
    const calls: Array<{ userId: string; data: Record<string, string> }> = [];
    return { calls, notify: (userId: string, data: Record<string, string>) => calls.push({ userId, data }) };
  };

  it("notifies the author with a COUNT and no reactor identity", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    // Seven prior reactions from other users; the eighth arrives below.
    for (let i = 0; i < 7; i++) {
      e.DB.comment_reactions.push({ comment_id: "C1", user_id: `seed-${i}`, emoji: "🔥", created_at: 0 });
    }
    const n = spy();

    await handleReactToComment("C1", post("/api/comments/C1/reaction", { emoji: "🔥" }, "tok-a"), e, ctx, n.notify);

    await flush();

    expect(n.calls).toHaveLength(1);
    expect(n.calls[0].userId).toBe(B);
    expect(n.calls[0].data.kind).toBe("comment_reaction");
    expect(n.calls[0].data.commentId).toBe("C1");
    // The count rides the payload so the client renders without a sync round
    // trip — otherwise every reaction costs the RECIPIENT a Worker request.
    expect(n.calls[0].data.count).toBe("8");
    // ⚠️ Naming the reactor would be inconsistent with counts-only reactions AND
    // would expose a non-friend identity that is hidden everywhere else.
    expect(JSON.stringify(n.calls[0].data)).not.toContain(A);
  });

  it("stays quiet inside the cooldown, then notifies again once it lapses", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    const n = spy();

    await handleReactToComment("C1", post("/api/comments/C1/reaction", { emoji: "🔥" }, "tok-a"), e, ctx, n.notify);
    await handleReactToComment("C1", post("/api/comments/C1/reaction", { emoji: "❤️" }, "tok-c"), e, ctx, n.notify);
    await flush();
    // A comment that does well can draw hundreds; one push per reaction is the
    // failure mode this exists to prevent.
    expect(n.calls).toHaveLength(1);

    // 16 minutes later the cooldown has lapsed.
    e.DB.comments[0].last_notified_at = Date.now() - 16 * 60 * 1000;
    await handleReactToComment("C1", post("/api/comments/C1/reaction", { emoji: "😂" }, "tok-a"), e, ctx, n.notify);
    await flush();
    expect(n.calls).toHaveLength(2);
  });

  it("never notifies you about your own reaction", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: A });
    const n = spy();
    await handleReactToComment("C1", post("/api/comments/C1/reaction", { emoji: "🔥" }, "tok-a"), e, ctx, n.notify);
    await flush();
    expect(n.calls).toEqual([]);
  });

  it("never notifies across a block, in either direction", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    // A public comment stays readable and reactable — the block only silences the
    // notification, which is what stops it being a way to poke someone.
    e.DB.blocks.push({ blocker_id: B, blocked_id: A });
    const n = spy();
    await handleReactToComment("C1", post("/api/comments/C1/reaction", { emoji: "🔥" }, "tok-a"), e, ctx, n.notify);
    await flush();
    expect(n.calls).toEqual([]);
  });

  it("does not notify when a reaction is REMOVED", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    await react(e, "C1", "🔥", "tok-a");
    e.DB.comments[0].last_notified_at = 0;
    const n = spy();

    await handleReactToComment("C1", unreactRequest("C1", "tok-a"), e, ctx, n.notify);
    await flush();
    // "Someone un-reacted" is not news, and notifying would double the volume of
    // the noisiest event in the app.
    expect(n.calls).toEqual([]);
  });

  it("surfaces counts on the public list without revealing who reacted", async () => {
    const e = env();
    seed(e.DB, { id: "C1" });
    for (let i = 0; i < 3; i++) {
      e.DB.comment_reactions.push({ comment_id: "C1", user_id: `u-${i}`, emoji: "❤️", created_at: 0 });
    }
    const res = await handleGetComments(get("/api/titles/movie/603/comments"), e, MOVIE, ctx);
    const [c] = (await res.json()).comments;
    expect(c.reactions).toEqual({ "❤️": 3 });
    expect(c).not.toHaveProperty("reactors");
  });
});

describe("reporting", () => {
  const report = (e: any, id: string, reason: string, token: string) =>
    handleReportComment(id, post(`/api/comments/${id}/report`, { reason }, e && token), e, ctx);

  it("snapshots the body, because editing forever is otherwise a way to escape a report", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "SEEDCOMMENT01", author_id: B, body: "the original text" });
    await report(e, "SEEDCOMMENT01", "abuse", "tok-a");
    expect(e.DB.reports[0].body_snapshot).toBe("the original text");

    // The author rewrites it. The live row changes; the snapshot does not, and the
    // divergence is itself the signal the admin needs.
    await handlePostComment(
      post(
        "/api/comments",
        { id: "SEEDCOMMENT01", tmdbId: 603, mediaType: "movie", body: "something innocuous" },
        "tok-b",
      ),
      e,
      ctx,
    );
    expect(e.DB.comments[0].body).toBe("something innocuous");
    expect(e.DB.reports[0].body_snapshot).toBe("the original text");
  });

  it("hides at three DISTINCT reporters, and not before", async () => {
    const e = await withSessions(env());
    e.REPORT_AUTOHIDE = "3";
    seed(e.DB, { id: "C1", author_id: B });

    await report(e, "C1", "abuse", "tok-a");
    // The same reporter again is a no-op, not a second vote.
    await report(e, "C1", "abuse", "tok-a");
    expect(e.DB.comments[0].hidden_at).toBeNull();

    await report(e, "C1", "abuse", "tok-c");
    expect(e.DB.comments[0].hidden_at).toBeNull();

    e.DB.sessions.set(await hash("tok-d"), "DDDDM06Z0S88X71U7FJLGHGCZ2");
    await report(e, "C1", "abuse", "tok-d");
    expect(e.DB.comments[0].hidden_at).toBeGreaterThan(0);
    // Hiding takes the comment out of the public count in the same batch.
    expect(e.DB.count(603, "movie")).toBe(0);
  });

  it("BLURS at two spoiler reports instead of hiding — the counts never mix", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });

    await report(e, "C1", "spoiler", "tok-a");
    expect(e.DB.comments[0].spoiler).toBe(0);
    await report(e, "C1", "spoiler", "tok-c");

    expect(e.DB.comments[0].spoiler).toBe(1);
    // ⚠️ The point of the separation: two spoiler reports must NOT move the comment
    // one step closer to being hidden, or "report as spoiler" is a censorship lever.
    expect(e.DB.comments[0].hidden_at).toBeNull();
    expect(e.DB.count(603, "movie")).toBe(1);
  });

  it("lets one person file both a spoiler and an abuse report on the same comment", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    await report(e, "C1", "spoiler", "tok-a");
    await report(e, "C1", "abuse", "tok-a");
    expect(e.DB.reports.map((r: any) => r.kind).sort()).toEqual(["comment", "comment_spoiler"]);
  });

  it("counts only OPEN reports, so a dismissed set cannot be re-tripped by one person", async () => {
    const e = await withSessions(env());
    e.REPORT_AUTOHIDE = "3";
    seed(e.DB, { id: "C1", author_id: B });
    // An admin restored this comment and dismissed the three reports that hid it.
    for (const r of [A, C, "DDDDM06Z0S88X71U7FJLGHGCZ2"]) {
      e.DB.reports.push({ id: r, reporter_id: r, target_id: "C1", kind: "comment", state: "dismissed" });
    }
    e.DB.sessions.set(await hash("tok-e"), "EEEEN17Z1T99Y82V8GKMHJHD03");
    await report(e, "C1", "abuse", "tok-e");
    // One new report against three dismissed ones must not re-hide it — otherwise
    // a single person overturns the moderator.
    expect(e.DB.comments[0].hidden_at).toBeNull();
  });

  it("ignores an author reporting their own comment", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: A });
    expect((await report(e, "C1", "abuse", "tok-a")).status).toBe(204);
    expect(e.DB.reports).toEqual([]);
  });

  it("rejects an unknown reason", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    expect((await report(e, "C1", "i just dislike it", "tok-a")).status).toBe(400);
  });
});

describe("deleting", () => {
  it("tombstones rather than removing a REPORTED comment, so moderation history survives", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: A, body: "the reported text" });
    // ⚠️ The report is the whole point of this test and it used to be missing: the
    // comment was deleted with nothing filed against it and the retained body was
    // asserted anyway, so the test passed for a reason its own name does not give.
    e.DB.reports.push({ id: "R1", reporter_id: B, target_id: "C1", kind: "comment", state: "open" });

    await handleDeleteComment("C1", get("/api/comments/C1", "tok-a"), e, ctx);

    expect(e.DB.comments[0].deleted_at).toBeGreaterThan(0);
    expect(e.DB.comments[0].body).toBe("the reported text");
  });

  it("keeps a DISMISSED report's comment too — it is still a decision that was made", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: A, body: "the reported text" });
    e.DB.reports.push({ id: "R1", reporter_id: B, target_id: "C1", kind: "comment", state: "dismissed" });

    await handleDeleteComment("C1", get("/api/comments/C1", "tok-a"), e, ctx);

    expect(e.DB.comments[0].body).toBe("the reported text");
  });

  it("REMOVES an unreported comment outright rather than keeping the text", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: A, body: "just a comment" });

    await handleDeleteComment("C1", get("/api/comments/C1", "tok-a"), e, ctx);

    // Nothing reports it, nothing hangs off it, and the two moderation surfaces that
    // read `comments.body` are both driven by a join on `reports` — so the retained
    // text was read by nothing and simply outlived the author's request to remove it.
    expect(e.DB.comments).toHaveLength(0);
  });

  it("keeps an unreported PARENT as a bare anchor, with its text stripped", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: A, body: "the original", reply_count: 1 });
    seed(e.DB, { id: "C2", author_id: B, body: "a reply", parent_id: "C1" });

    await handleDeleteComment("C1", get("/api/comments/C1", "tok-a"), e, ctx);

    // The row has to survive — it is what stops the reply being orphaned — but a
    // tombstone renders none of its content, so none of it is kept.
    const row = e.DB.comments.find((c: any) => c.id === "C1");
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(row.body).toBe("");
    expect(row.media_id).toBeNull();
    expect(row.reply_count).toBe(1);
    // And the reply itself is untouched: other people's words are never cascaded.
    expect(e.DB.comments.find((c: any) => c.id === "C2").body).toBe("a reply");
  });

  it("removes the comment from the public count and drops its reactions", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: A });
    e.DB.comment_reactions.push({ comment_id: "C1", user_id: B, emoji: "👍", created_at: 0 });

    await handleDeleteComment("C1", get("/api/comments/C1", "tok-a"), e, ctx);
    expect(e.DB.count(603, "movie")).toBe(0);
    expect(e.DB.comment_reactions).toEqual([]);
  });

  it("answers 204 for someone else's comment, so ids cannot be probed", async () => {
    const e = await withSessions(env());
    seed(e.DB, { id: "C1", author_id: B });
    const res = await handleDeleteComment("C1", get("/api/comments/C1", "tok-a"), e, ctx);
    expect(res.status).toBe(204);
    expect(e.DB.comments[0].deleted_at).toBeNull();
  });
});
