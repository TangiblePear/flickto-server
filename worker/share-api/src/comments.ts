// ── Comments, server-side ────────────────────────────────────────────────────
// Flat comments at two levels — title (movie or show) and episode — replacing the
// E2EE `social_opinions` surface.
//
// The forcing argument for moving off E2EE is moderation: `reports.kind` already
// anticipated 'comment', but a report against a comment the server cannot read is
// unactionable, and Play expects UGC moderation to actually work. The promise
// being made is "only your friends can read this", NOT "not even we can" — a
// server-side friendship check delivers the former completely, and D1 is encrypted
// at rest, so a stolen disk is not the exposure E2EE would be defending against.
//
// ── Two read paths, never one query ─────────────────────────────────────────
// Never `WHERE visibility='public' OR author_id IN (<friends>)`. An `IN` list
// beside `ORDER BY … LIMIT` defeats the index ordering — every comment on the
// title is gathered before sorting — and it makes the response per-reader, so it
// can never be cached.
//
//   1. the public list is unauthenticated and identical for every reader, so it
//      edge-caches: a thousand people on a hot episode cost ONE D1 query.
//   2. the friends slice is authenticated and NEVER cached. `caches.default` keys
//      on URL, so caching it would serve one user's friends-only comments to
//      another — the same cross-account leak already hit on the client, where
//      OkHttp keyed on URL and `/api/me/profile` is one URL for every user.
//
// The client merges the two by timestamp. Signed out, only path 1 runs.
//
// ⚠️ **Loading comments ALWAYS costs a Worker request.** D1 is reachable only from
// a Worker, and a Worker on a route always runs — Cloudflare does not serve its
// response from CDN cache without invoking it. `caches.default` saves the D1
// QUERY, not the request. That is why the client must never load comments on
// detail-page open, and why there is no comment count on the detail page.

import { areFriends, isBlockedEitherWay } from "./authz";
import { resolveSession } from "./auth";
import { loadFriendships } from "./friends";
import { postingSuspendedUntil, suspendedBody } from "./suspension";
import { isPremiere, visibleBorderId, visiblePictureUrl } from "./premiere";
import { appVersion } from "./profiles";
import { evaluateAppCheck, logAppCheck, type AppCheckEnv } from "./appcheck";
import { recordAdminAction } from "./adminAudit";
import { ARCHIVE_PAGE_LIMIT, loadArchivePage } from "./commsuniComments";
import { drainArchiveOutbox, queueMirror, queueUnmirror } from "./commsuniMirror";
import { resolveReference, refPath } from "./commsuniEntities";

export interface CommentsEnv extends AppCheckEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
  /** Per-author hourly cap. Config, not a constant, so it tunes without a deploy. */
  COMMENTS_PER_HOUR?: string;
  /**
   * Per-author hourly cap on NEW comments **on one subject**.
   *
   * ⚠️ This is the control that replaced one-comment-per-user-per-subject. That
   * restriction was the primary anti-spam design, and lifting it leaves
   * `COMMENTS_PER_HOUR` — which is product-wide, so nothing stopped one author
   * spending the whole hourly budget flooding a single title's sheet. "0" disables.
   */
  COMMENTS_PER_SUBJECT_PER_HOUR?: string;
  /**
   * Short-window burst caps on the comment write path, per minute.
   *
   * These exist because the hourly cap above has two blind spots: it is spent only
   * by a NEW comment (so an edit loop is free), and it is per-author (so N accounts
   * driven by one script cost nothing extra). The user cap closes the first, the IP
   * cap the second. "0" disables either.
   *
   * ⚠️ Counted in D1 rather than through Cloudflare's `unsafe.bindings` ratelimit.
   * That binding was tried first and **silently did nothing in production** — see
   * migration 0041 for the evidence. Do not reintroduce it without proving a 429.
   */
  COMMENT_WRITES_PER_MINUTE?: string;
  COMMENT_WRITES_PER_MINUTE_IP?: string;
  /** Rate-limit strikes in the window that trigger an automatic posting suspension. */
  STRIKES_TO_SUSPEND?: string;
  /** How long an automatic suspension lasts. */
  AUTO_SUSPEND_MS?: string;
  /**
   * Workers AI, for the inline translation tier. **Optional on purpose**: with no
   * binding every comment comes back flagged untranslated and the client falls
   * back to on-device ML Kit, which is exactly the behaviour when the daily
   * allowance runs out. One code path, two causes.
   */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, If-Match, X-Revoke-Session, X-App-Version, X-Firebase-AppCheck",
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });
const noContent = () => new Response(null, { status: 204, headers: CORS });
const notFound = () => json({ error: "not_found" }, 404);

const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/**
 * Author-minted comment id.
 *
 * ⚠️ **The full A-Z, not Crockford base32.** New ids are `{userId}:{subject}` and
 * would fit the narrower alphabet, but the `social_opinions` migration reuses the
 * existing `{friendId}:{tmdbId}` ids so a re-run and a second device are idempotent
 * — and a **device friendId is `[A-Z0-9]{12,40}`**, which includes I, L, O and U.
 * Crockford excludes exactly those four, so a narrower regex would 400 every
 * migrated comment from any friendId containing one, silently, forever.
 */
const COMMENT_ID_RE = /^[0-9A-Z:]{8,80}$/;

/**
 * An archive comment id: a bare partner UUID.
 *
 * ⚠️ Deliberately NOT [COMMENT_ID_RE], which is uppercase-only and would reject the
 * lowercase hex a UUID normally arrives in. The route patterns in `index.ts` already
 * spell this shape out for the archive report and reply reads; this is the same shape
 * in the one place a request BODY carries it.
 */
const ARCHIVE_ID_RE = /^[0-9a-fA-F-]{36}$/;

export const MAX_BODY = 500;
const MAX_REACTION = 32;
const MAX_MEDIA_URL = 512;
const MAX_MEDIA_ID = 128;
const MAX_LANG = 8;
/**
 * ⚠️ **20, and the number is load-bearing.** Free-plan Workers allow 50
 * subrequests per invocation, and the translation tier spends one AI call per
 * untranslated comment on top of the session, friendship, comment and
 * reaction-count queries. A 50-comment page blows the limit outright. Same cap
 * that already forced `FRESHNESS_CHUNK = 25`.
 */
export const PAGE_LIMIT = 20;

/**
 * One page of replies inside an expanded thread.
 *
 * ⚠️ Sized against the SAME 50-subrequest budget [PAGE_LIMIT] is, and smaller
 * because a reply page can be fully untranslated: replies are translated exactly
 * like top-level comments, so a page of N spends up to N AI calls on top of the
 * session and reaction-count queries. Replies must not be able to inflate that
 * budget just because they arrive on their own request.
 */
export const REPLY_PAGE_LIMIT = 10;

/**
 * Replies carried inline on a top-level row, so a short thread needs no expand
 * call at all. Most threads are short, which is what makes this the difference
 * between "one extra request per expanded thread" and "one per thread, always".
 */
const INLINE_REPLY_PREVIEW = 2;

/**
 * ⚠️ **Depth is capped at 2 and flattened SERVER-side**, copied from the archive:
 * a reply to a depth-2 comment is stored at depth 2 under the same `parent_id`,
 * with `in_reply_to_id` naming what the user actually answered. Clients post to
 * whatever was tapped and render what comes back — they do not pre-compute this.
 */
const MAX_DEPTH = 2;

/** Mention spans per comment. Structured `{authorId, start, end, text}`, never a regex. */
const MAX_MENTIONS = 3;

/** Bounds the language picker so a subject with absurd variety cannot become a scan. */
const MAX_LANG_OPTIONS = 25;
/** The caller's own reactions on one subject. Realistically a handful; this is the belt. */
const MY_REACTIONS_LIMIT = 200;
const DEFAULT_COMMENTS_PER_HOUR = 30;
const DEFAULT_COMMENTS_PER_SUBJECT_PER_HOUR = 5;
/** Public list TTL. Also the exact size of the public → friends-only leak window. */
export const PUBLIC_CACHE_SECONDS = 60;

const MEDIA_KINDS = new Set(["gif", "image"]);
// "giphy" stays valid for historical rows; "klipy" is the current GIF provider.
const MEDIA_PROVIDERS = new Set(["giphy", "klipy", "r2"]);

/**
 * The six. Fixed, not a picker.
 *
 * No 😡 deliberately: it is a known amplifier of hostile engagement (Facebook's
 * own finding) and has no constructive use on a comment about an episode. 😮
 * earns its place in a TV app specifically — twists, deaths, cliffhangers.
 *
 * ⚠️ This set may be **grown** safely; shrinking it strands existing rows in
 * `comment_reactions`, which then have to be rendered anyway or migrated. Adding
 * is free, removing is not — and the same asymmetry runs the other way for the
 * fixed-set decision itself: fixed → picker later is additive, picker → fixed
 * discards reactions people actually made.
 */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const REACTIONS = new Set(REACTION_EMOJI);

/**
 * Wake a user's devices with a payload they can render without asking us anything.
 *
 * Injected rather than imported for the same reason `lists.ts` takes one: the push
 * record lives in R2 and is keyed by the device friendId, neither of which belongs
 * in a D1-only module.
 *
 * ⚠️ **This is the side effect that gets forgotten.** Shared lists (2026-07-27) and
 * friend requests (2026-07-28) both shipped correct server state that no client was
 * ever told about, because the relay POST they replaced had been firing the FCM as a
 * side effect. Fire-and-forget by contract: a reaction must never fail because a
 * push did.
 */
export type CommentNotifier = (userId: string, data: Record<string, string>) => void;

/**
 * How long a comment stays quiet after notifying its author.
 *
 * Volume here is unbounded and attacker-controllable — a stranger can react to
 * anything you have written — and there is **no cron budget** for a scheduled
 * digest, so the write path throttles itself.
 */
const REACTION_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Friends told about one new comment. Bounded so a single comment can never become
 * an unbounded fan-out inside one request — friend counts are tens, so this is a
 * belt rather than a real limit.
 */
const MAX_COMMENT_NOTIFY_FANOUT = 50;

// ── Subject ─────────────────────────────────────────────────────────────────

/**
 * What a comment is attached to. `season`/`episode` are **-1 for title level, never
 * null**: SQLite permits NULL in composite PRIMARY KEY columns, so nullable
 * columns in `comment_counts`' key would not enforce uniqueness and the counter
 * would silently fork into duplicate rows.
 */
export interface Subject {
  tmdbId: number;
  mediaType: "movie" | "show";
  season: number;
  episode: number;
}

/**
 * -1 unless BOTH season and episode are present and non-negative.
 *
 * ⚠️ The absence check is not redundant with the range check. `Number(null)` is
 * **0**, so a missing `episode` parameter parses as episode 0 — which made every
 * title-level read on a movie look like an episode subject and answer 400.
 */
function level(season: unknown, episode: unknown): [number, number] {
  if (season == null || season === "" || episode == null || episode === "") return [-1, -1];
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 0) return [-1, -1];
  return [s, e];
}

/**
 * Parse a subject out of `/api/titles/{type}/{tmdbId}/comments…` plus the query
 * string. Returns null for anything malformed — an episode subject on a movie
 * included, since a movie has no episodes and accepting one would fork the
 * counter into a row nothing ever reads.
 */
export function parseSubject(mediaType: string, rawId: string, params: URLSearchParams): Subject | null {
  if (mediaType !== "movie" && mediaType !== "show") return null;
  const tmdbId = Number(rawId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const [season, episode] = level(params.get("season"), params.get("episode"));
  if (season >= 0 && mediaType !== "show") return null;
  return { tmdbId, mediaType, season, episode };
}

// ── Rows and wire shape ─────────────────────────────────────────────────────

/**
 * One mention span. `start`/`end` index into the comment body, so rendering is a
 * substring replacement rather than a pattern match over prose.
 */
export interface Mention {
  authorId: string;
  start: number;
  end: number;
  text: string;
}

export interface CommentRow {
  id: string;
  tmdb_id: number;
  media_type: string;
  season: number;
  episode: number;
  author_id: string;
  body: string;
  reaction: string | null;
  visibility: string;
  spoiler: number;
  lang: string | null;
  media_kind: string | null;
  media_provider: string | null;
  media_id: string | null;
  media_url: string | null;
  media_w: number | null;
  media_h: number | null;
  hidden_at: number | null;
  deleted_at: number | null;
  /**
   * Thread placement. ⚠️ `parent_id` and `in_reply_to_id` are NOT redundant:
   * the first groups the thread, the second names who was actually answered, and
   * they differ exactly when a deeper reply is flattened up into the display
   * level. Migration 0044 has the full reasoning.
   */
  parent_id: string | null;
  in_reply_to_id: string | null;
  root_id: string | null;
  depth: number;
  reply_count: number;
  mentions_json: string | null;
  created_at: number;
  updated_at: number;
  display_name?: string | null;
  border_id?: string | null;
  avatar_id?: string | null;
  picture_url?: string | null;
  /** Joined from `users`, not `profiles` — see premiere.ts and migration 0028. */
  premiere_until?: number | null;
  /** Admin comp, joined from `users`. Both columns feed `isPremiere`; migration 0031. */
  premiere_comp_until?: number | null;
  picture_animated?: number | null;
}

/**
 * Everything a comment row needs to be rendered, minus the reader-specific bits
 * (`myReaction`, block filtering) which are deliberately not on the cached path.
 *
 * `edited` rather than exposing `updated_at` on its own: the UI shows a marker,
 * and the raw timestamp invites a client to sort by it and reorder the list.
 *
 * `reactions` is **counts only** — there is no "who reacted" list, which would
 * cost a per-tap query plus display-name resolution for every reactor. The
 * caller's own reaction is the one reader-specific bit, and it rides
 * `myReactions` on the authenticated path instead.
 */
function toWire(
  r: CommentRow,
  reactions: Record<string, number> = {},
  translation?: Translated,
  replies?: unknown[],
) {
  /**
   * ⚠️ A tombstone carries NOTHING of the original — not the text, not the media, not
   * the author. It exists only so a thread whose parent was deleted still has
   * somewhere to hang. Stripping here rather than at the query keeps the one place
   * that decides what a comment looks like on the wire.
   */
  const tombstone = r.deleted_at != null;
  if (tombstone) {
    return {
      reactions: {},
      translated: null,
      translationFailed: false,
      id: r.id,
      authorId: "",
      authorName: null,
      authorAvatarId: null,
      authorBorderId: null,
      authorPictureUrl: null,
      authorIsPremiere: false,
      body: "",
      reaction: null,
      visibility: r.visibility,
      spoiler: false,
      lang: null,
      media: null,
      edited: false,
      deleted: true,
      parentCommentId: r.parent_id,
      inReplyToCommentId: null,
      rootCommentId: r.root_id ?? r.id,
      depth: r.depth ?? 0,
      replyCount: r.reply_count ?? 0,
      mentions: [],
      replies: replies ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  return {
    reactions,
    /** Server-side translation, when one was asked for and succeeded. */
    translated: translation?.text ?? null,
    /**
     * The cue for tier 3. True means "we tried and could not" — an exhausted
     * daily allowance, a model error, or no AI binding at all — and the client
     * should offer "Translate on this device". False on a comment already in the
     * reader's language, where there is nothing to offer.
     */
    translationFailed: translation?.failed ?? false,
    id: r.id,
    authorId: r.author_id,
    authorName: r.display_name ?? null,
    authorAvatarId: r.avatar_id ?? null,
    authorBorderId: visibleBorderId(r.border_id, r) || null,
    authorPictureUrl: visiblePictureUrl(r.picture_url, r) || null,
    authorIsPremiere: isPremiere(r),
    body: r.body,
    reaction: r.reaction,
    visibility: r.visibility,
    spoiler: r.spoiler === 1,
    lang: r.lang,
    media:
      r.media_id == null
        ? null
        : {
            kind: r.media_kind,
            provider: r.media_provider,
            id: r.media_id,
            url: r.media_url,
            w: r.media_w,
            h: r.media_h,
          },
    edited: r.updated_at > r.created_at,
    deleted: false,
    /**
     * Thread fields, named as the archive names them so one client model and one
     * renderer serve both layers. `parentCommentId` places the row;
     * `inReplyToCommentId` is who was actually answered and drives the "replying
     * to" label, mentions, notifications and jump-to-target.
     */
    parentCommentId: r.parent_id,
    inReplyToCommentId: r.in_reply_to_id,
    rootCommentId: r.root_id ?? r.id,
    depth: r.depth ?? 0,
    replyCount: r.reply_count ?? 0,
    mentions: parseMentions(r.mentions_json),
    /**
     * The inline preview of the first replies, present only on top-level rows of a
     * list read. ⚠️ This is what stops the expand call happening at all for short
     * threads — most threads are short, so it removes the large majority of those
     * requests. `null` means "not loaded here", which is NOT the same as "none":
     * `replyCount` is the authority on whether any exist.
     */
    replies: replies ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Mention spans, or an empty list.
 *
 * ⚠️ Rendering reads these SPANS, never a regex over the body. A regex cannot tell
 * an @-mention from an email address or a literal @ in prose, and it cannot resolve
 * which account was meant — and our mirrored replies would reach other partner apps
 * as plain text they render as ordinary prose.
 */
function parseMentions(raw: string | null): Mention[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_MENTIONS) : [];
  } catch {
    // Stored JSON that will not parse is a bug, but a comment that will not RENDER
    // because of its mention metadata is a worse one.
    return [];
  }
}

const SELECT_COLUMNS = `c.id, c.tmdb_id, c.media_type, c.season, c.episode, c.author_id, c.body,
       c.reaction, c.visibility, c.spoiler, c.lang, c.media_kind, c.media_provider,
       c.media_id, c.media_url, c.media_w, c.media_h, c.hidden_at, c.deleted_at,
       c.parent_id, c.in_reply_to_id, c.root_id, c.depth, c.reply_count, c.mentions_json,
       c.created_at, c.updated_at,
       p.display_name, p.avatar_id, p.border_id, p.picture_url,
       u.premiere_until, u.premiere_comp_until, u.picture_animated`;

/**
 * A comment is only rendered — and only counted — when it has something to show.
 *
 * ⚠️ `body <> ''` alone is WRONG once media exists: keeping the media reaction as
 * a column preserves "react without commenting" (empty body, non-null reaction),
 * and a GIF-only comment is also empty-bodied. Both halves of this predicate have
 * to appear identically in the read queries and in `n_public`, or the badge stops
 * matching the list.
 */
const RENDERABLE = `c.hidden_at IS NULL AND c.deleted_at IS NULL AND (c.body <> '' OR c.media_id IS NOT NULL)`;

/**
 * The list endpoints return **top-level comments only**; replies arrive through
 * `handleGetReplies` on expand, or in the inline preview carried on the parent.
 *
 * ⚠️ Without this a thread's replies would appear as separate rows in the main
 * list, in `created_at` order, detached from what they answer — and the page limit
 * of 20 would be spent on them.
 */
/**
 * ⚠️ `parent_archive_id` too, for exactly the same reason. A reply to another app's
 * comment has no NATIVE parent — `parent_id` is null because the thing it answers has
 * never been in this table — so `parent_id IS NULL` alone would file it in the main
 * list as though it were a fresh top-level comment, detached from the conversation it
 * belongs to and spending one of the 20 page slots. It is a reply; it just belongs to
 * a thread we do not own.
 */
const TOP_LEVEL = `c.parent_id IS NULL AND c.parent_archive_id IS NULL`;

/**
 * What a **top-level** list read may return: anything renderable, plus a deleted
 * comment that still has replies.
 *
 * ⚠️ Without the second half, deleting a parent silently orphans its whole subtree:
 * [RENDERABLE] excludes deleted rows, so the parent leaves the list and its replies —
 * other people's words, which we deliberately do not cascade — become unreachable.
 * The row comes back as a tombstone instead: no text, no media, no author, no
 * actions. `toWire` is what strips it; this predicate only decides it is returned.
 *
 * Replies themselves stay on plain [RENDERABLE] — a deleted reply has nothing
 * hanging off it, so there is nothing to orphan and nothing to mark.
 */
const LISTABLE = `(${RENDERABLE} OR (c.deleted_at IS NOT NULL AND c.reply_count > 0))`;

// ── The friend feed ─────────────────────────────────────────────────────────

/**
 * Recent comments by [authors], shaped as feed events.
 *
 * **Comments reach the friend feed with NO extra write.** There is deliberately
 * no `feed_events` row for a comment: `schema.sql` commits to fan-out on READ
 * precisely because reads have a 5M/day budget against 100k writes, so the feed
 * query asks `comments` as well and merges. The cost is one extra index —
 * `idx_comments_author_time` — and a second indexed query inside a Worker request
 * that is already happening, so not a second *chargeable* request.
 *
 * **Public and friends-only alike.** Visibility governs who may *read* a comment,
 * not whether your friends learn that you commented — and excluding public ones
 * would be backwards, since public is the *more* visible setting. Every author
 * here is already an accepted friend of the reader, which is also what makes
 * blocking need no separate check: `handleBlock` deletes the friendship row, so a
 * blocked author simply stops matching.
 *
 * Hidden, deleted and empty rows are excluded by the same predicate the comment
 * lists use, so the feed can never advertise a comment the reader cannot open.
 */
export async function loadFriendCommentEvents(
  env: CommentsEnv,
  authors: string[],
  limit: number,
  before: number,
  since: number,
) {
  if (authors.length === 0) return [];
  const placeholders = authors.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.author_id, c.tmdb_id, c.media_type, c.season, c.episode,
            c.body, c.spoiler, c.created_at
       FROM comments c
      WHERE c.author_id IN (${placeholders}) AND c.created_at < ? AND c.created_at > ?
        AND ${RENDERABLE}
      ORDER BY c.created_at DESC
      LIMIT ?`,
  )
    .bind(...authors, before, since, limit)
    .all<{
      id: string;
      author_id: string;
      tmdb_id: number;
      media_type: string;
      season: number;
      episode: number;
      body: string;
      spoiler: number;
      created_at: number;
    }>();

  return (results ?? []).map((r) => ({
    id: `comment:${r.id}`,
    userId: r.author_id,
    kind: "comment",
    tmdbId: r.tmdb_id,
    mediaType: r.media_type,
    // The client needs the comment id to deep-link into the sheet scrolled to it,
    // and `spoiler` so it can blur in the feed as well as in the list — a feed
    // that reveals what the comment page hides would defeat the flag entirely.
    payload: JSON.stringify({
      commentId: r.id,
      season: r.season,
      episode: r.episode,
      body: r.body,
      spoiler: r.spoiler === 1,
    }),
    createdAt: r.created_at,
  }));
}

// ── Reaction counts ─────────────────────────────────────────────────────────

/**
 * Reaction counts for a page of comments — one extra query per page, not per
 * comment, and reader-independent so it caches with the public list.
 *
 * Counts are derived from `comment_reactions` with `COUNT(*)` + `GROUP BY` rather
 * than kept in a materialised table: reacting is the noisiest write in the app, and
 * a counter row per emoji doubled every one of those writes. The source table has a
 * covering `(comment_id, emoji)` index so this is an index-only scan.
 */
export async function loadReactionCounts(
  env: CommentsEnv,
  ids: string[],
): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT comment_id, emoji, COUNT(*) AS n
       FROM comment_reactions
      WHERE comment_id IN (${placeholders})
      GROUP BY comment_id, emoji`,
  )
    .bind(...ids)
    .all<{ comment_id: string; emoji: string; n: number }>();

  for (const r of results ?? []) {
    (out[r.comment_id] ??= {})[r.emoji] = r.n;
  }
  return out;
}

// ── Translation ─────────────────────────────────────────────────────────────
//
// Everyone sees every comment, in their own language, without asking:
//
//   1. **translate inline, here, by default.** The request is already paid for, so
//      AI inference and D1 queries inside it are subrequests, not billed
//      invocations — translation costs ZERO extra requests. Translations are cached
//      per comment in D1 keyed on `src_updated_at`, so the model runs once per
//      comment per language across every reader, and the response stays
//      per-*language* rather than per-*reader*, so it still edge-caches.
//   2. **allowance exhausted: on-device.** The failure is caught PER COMMENT and
//      the comment comes back flagged (`translationFailed`) rather than failing the
//      whole fetch. The client then offers ML Kit on Android.
//
// ⚠️ **`lang` is the translation TARGET, never a filter.** It was both once, and the
// result was that a reader whose language differed from the comments watched them
// load and then vanish. Narrowing is a separate, explicit `only` parameter driven by
// the language picker — a thing the reader chooses, not a guess made from their
// locale.
//
// ⚠️ **Never accept a client-generated translation back into this cache.** It is
// tempting — a device that translated something could warm the cache for everyone
// — and it is an injection vector: a user could upload an arbitrary "translation"
// of someone else's comment and the server would serve it as authoritative.

const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";

/**
 * How long a response will WAIT on translation before shipping without it.
 *
 * ⚠️ Sized from measurement, not taste: one m2m100 call is ~1.95s wall on Workers AI
 * (House of the Dragon, 2026-09-08). Since the calls now run together, a page needs one
 * round trip rather than one per comment — so this is "a bit less than one call", which
 * lets a fast call through and refuses to let a slow one hold the sheet. Raising it past
 * ~2s buys a few more first-view translations at the cost of the thing being fixed.
 */
const TRANSLATION_DEADLINE_MS = 1_500;

/** m2m100 wants a bare language code; our locales carry regions (`pt-BR`, `pt-PT`). */
const baseLang = (tag: string) => tag.split(/[-_]/)[0].toLowerCase();

interface Translated {
  /** The translated text, or null when this comment could not be translated. */
  text: string | null;
  /** True when translation was attempted and failed — the client's cue to try on-device. */
  failed: boolean;
}

/**
 * The one shape the translator understands, so a native row and a partner's row reach
 * it the same way.
 *
 * [version] is what makes a cached translation safe to reuse: it must change whenever
 * the source text does, or a stale translation stays cached forever while readers see
 * text that no longer matches the original. Native rows have `updated_at`; archive rows
 * carry no `updatedAt` at all and hash their body instead.
 */
interface Translatable {
  id: string;
  body: string;
  lang: string | null;
  version: number;
}

/**
 * Where translations for one kind of comment live.
 *
 * ⚠️ Two tables, one engine — see migration 0056 for why partner translations are not
 * simply extra rows in `comment_translations`. The engine below is identical for both;
 * only the cache differs, and the difference is a retention boundary rather than a
 * schema one.
 */
interface TranslationStore {
  /** Cached translations for [ids] in [target]. One indexed batch read, never per id. */
  read(
    env: CommentsEnv,
    ids: string[],
    target: string,
  ): Promise<Map<string, { text: string; version: number }>>;
  /** A statement writing one result back. Batched by the engine, never run alone. */
  write(
    env: CommentsEnv,
    id: string,
    target: string,
    text: string,
    version: number,
  ): D1PreparedStatement;
  /**
   * Bounds the AI calls one page may spend.
   *
   * ⚠️ **Subrequests are the constraint** — 50 per invocation on the free plan — and
   * it is always the PAGE LIMIT of whatever this store serves, because one call per
   * comment is the worst case and a page can never be longer than its own limit. The
   * native budget is roughly: session + friendships + comments ~3, cache lookup 1, one
   * AI call per untranslated comment up to 20, batched writeback 1. About 25. The
   * archive budget is the friends path's ~13 (session, friendships, the two comment
   * queries, reaction counts, my reactions, and the eight the archive read itself
   * spends) plus the same 22, which is why [ARCHIVE_PAGE_LIMIT] is also 20 and why a
   * 50-comment page would blow the limit outright.
   */
  limit: number;
}

const nativeTranslations: TranslationStore = {
  async read(env, ids, target) {
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT comment_id, text, src_updated_at FROM comment_translations
        WHERE lang = ? AND comment_id IN (${placeholders})`,
    )
      .bind(target, ...ids)
      .all<{ comment_id: string; text: string; src_updated_at: number }>();
    return new Map(
      (results ?? []).map((r) => [r.comment_id, { text: r.text, version: r.src_updated_at }]),
    );
  },
  write(env, id, target, text, version) {
    return env.DB.prepare(
      `INSERT INTO comment_translations (comment_id, lang, text, src_updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(comment_id, lang) DO UPDATE
         SET text = excluded.text, src_updated_at = excluded.src_updated_at`,
    ).bind(id, target, text, version);
  },
  limit: PAGE_LIMIT,
};

const archiveTranslations: TranslationStore = {
  async read(env, ids, target) {
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT archive_id, text, src_hash FROM archive_translations
        WHERE lang = ? AND archive_id IN (${placeholders})`,
    )
      .bind(target, ...ids)
      .all<{ archive_id: string; text: string; src_hash: number }>();
    return new Map(
      (results ?? []).map((r) => [r.archive_id, { text: r.text, version: r.src_hash }]),
    );
  },
  write(env, id, target, text, version) {
    return env.DB.prepare(
      `INSERT INTO archive_translations (archive_id, lang, text, src_hash, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(archive_id, lang) DO UPDATE
         SET text = excluded.text, src_hash = excluded.src_hash, created_at = excluded.created_at`,
    ).bind(id, target, text, version, Date.now());
  },
  limit: ARCHIVE_PAGE_LIMIT,
};

/**
 * FNV-1a 32, over the source text.
 *
 * Stands in for the `updated_at` an archive row does not have. Synchronous on purpose:
 * `crypto.subtle.digest` is async and would turn a pure function into something every
 * caller has to await, for a stronger guarantee than cache invalidation needs.
 */
export function srcHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Translate [items] into [target], reading [store] first and writing new results back
 * in one batch.
 *
 * **Concurrent, and bounded by a deadline rather than by a count.**
 *
 * ⚠️ This was a sequential loop, and the loop was the whole latency bug. Measured on
 * House of the Dragon, 2026-09-08: one `env.AI.run` costs ~1.95s wall (6ms CPU — it is
 * pure inference wait), so a page needing two translations took 4.2s and a page of
 * twenty foreign comments — a Brazilian or Turkish title, i.e. exactly what this
 * feature exists for — would have taken ~40s and died. Firing them together makes the
 * page cost ONE model round trip instead of one per comment, and costs nothing extra
 * against the subrequest cap: it is still one call per comment either way.
 *
 * ⚠️ **The old "stop at the first failure" degradation is deliberately gone.** It
 * existed so an exhausted allowance was discovered once rather than twenty times, which
 * is only possible while the calls are ordered. Concurrency trades those wasted
 * subrequests for the 40s cliff above — the right way round, because subrequests are
 * capped per request and cost nothing when unused, while a 40s response is a broken
 * screen.
 *
 * ⚠️ **The deadline never cancels the work, it only stops WAITING for it.** Whatever
 * has not landed in [TRANSLATION_DEADLINE_MS] is reported `failed` to this reader — the
 * established cue meaning "we could not, try on-device" — while the call keeps running
 * under `waitUntil` and still writes to the cache. So the slow first reader pays a
 * bounded wait and everyone after them, including that same reader on a refresh, gets a
 * cache hit. Without this the deadline would be pure loss: a wait AND no cached result.
 */
async function translate(
  env: CommentsEnv,
  items: Translatable[],
  target: string,
  store: TranslationStore,
  ctx?: ExecutionContext,
): Promise<Record<string, Translated>> {
  const out: Record<string, Translated> = {};
  const needed = items.filter(
    (r) => r.body !== "" && r.lang != null && baseLang(r.lang) !== baseLang(target),
  );
  if (needed.length === 0) return out;

  const cached = await store.read(env, needed.map((r) => r.id), target);

  const misses: Translatable[] = [];
  for (const row of needed) {
    const hit = cached.get(row.id);
    // The version check is what makes editing safe: a stale translation would
    // otherwise stay cached forever while readers see text that no longer
    // matches the original.
    if (hit && hit.version === row.version) out[row.id] = { text: hit.text, failed: false };
    else misses.push(row);
  }
  if (misses.length === 0) return out;

  // No binding is the same answer as an exhausted allowance, and always has been: one
  // code path, two causes.
  if (!env.AI) {
    for (const row of misses) out[row.id] = { text: null, failed: true };
    return out;
  }

  // Anything past the cap is not attempted at all. Flagged, so the client can offer
  // on-device rather than silently showing text the reader cannot read.
  for (const row of misses.slice(store.limit)) out[row.id] = { text: null, failed: true };
  const budget = misses.slice(0, store.limit);

  /** Filled as calls land, read at the deadline AND again when the last one finishes. */
  const done = new Map<string, string | null>();
  const jobs = Promise.all(
    budget.map(async (row) => {
      try {
        const result = (await env.AI!.run(TRANSLATION_MODEL, {
          text: row.body,
          source_lang: baseLang(row.lang!),
          target_lang: baseLang(target),
        })) as { translated_text?: string } | null;
        const text = result?.translated_text ?? "";
        // Per comment, never per fetch. One model hiccup must not empty the page.
        done.set(row.id, text || null);
      } catch {
        done.set(row.id, null);
      }
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    jobs.then(() => clearTimeout(timer)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TRANSLATION_DEADLINE_MS);
    }),
  ]);

  for (const row of budget) {
    // ⚠️ `has`, not a truthy check. A finished-but-failed call stores null and must read
    // as failed; a call still in flight is absent and reads as failed for THIS reader
    // only — it is still running, and its result still reaches the cache below.
    const text = done.has(row.id) ? done.get(row.id)! : null;
    out[row.id] = { text, failed: text === null };
  }

  /**
   * Write back everything that eventually succeeded, late arrivals included.
   *
   * Batched, because each write would otherwise be its own subrequest against the same
   * 50-per-invocation budget the AI calls are already spending — and hung off `jobs`
   * rather than the deadline so a call that missed the response still warms the cache.
   */
  const flush = jobs.then(() => {
    const writes = budget
      .filter((row) => done.get(row.id))
      .map((row) => store.write(env, row.id, target, done.get(row.id)!, row.version));
    return writes.length > 0 ? env.DB.batch(writes) : undefined;
  });
  // ⚠️ Without a `ctx` there is nowhere to hand unfinished work, so this awaits every
  // call and the deadline above does nothing. That is correct for the only callers that
  // lack one — tests and synchronous paths — but it means a NEW call site that forgets
  // to thread `ctx` silently gets the old blocking behaviour back, at full latency.
  if (ctx) ctx.waitUntil(flush);
  else await flush;

  return out;
}

/** Our own comments. `updated_at` is the version, so an edit invalidates. */
async function translateRows(
  env: CommentsEnv,
  rows: CommentRow[],
  target: string,
  ctx?: ExecutionContext,
): Promise<Record<string, Translated>> {
  return translate(
    env,
    rows.map((r) => ({ id: r.id, body: r.body, lang: r.lang, version: r.updated_at })),
    target,
    nativeTranslations,
    ctx,
  );
}

/**
 * How recent a cached row must be for the polling route below to serve it.
 *
 * ⚠️ This is a STALENESS guard, not a cache expiry — the row itself lives on and the
 * authoritative read path keeps serving it via the hash check. The route below has no
 * source text to hash against (the client sends ids, not bodies), so without a bound it
 * could hand back a translation of a comment the partner has since edited, and "a stale
 * translation is worse than none" is the rule this whole cache is keyed on. Bounding to
 * rows written minutes ago means the only row it can serve is one our own `waitUntil`
 * just wrote, which is exactly what the client is asking about.
 */
const TRANSLATION_POLL_MAX_AGE_MS = 5 * 60 * 1000;

/** Ids one poll may ask about — a merged page is 20 native + 20 archive. */
const MAX_POLL_IDS = 40;

/**
 * `GET /api/comments/translations?lang=&ids=` — did the slow ones land yet?
 *
 * ⚠️ **Reads the cache and NOTHING else: no model call, no upstream call.** That is the
 * entire reason it is a route of its own rather than the client re-fetching
 * `/comments/friends`. A refetch would re-hit commsuni and spend a `read_unit` against a
 * 120/minute budget on every poll, to re-derive a page the client is already holding —
 * so polling the real endpoint would cost more than the translation did.
 *
 * ⚠️ **Archive rows only.** Native comments come from the edge-cached public path, where
 * the response is shared per-language and a pending translation resolves for everyone on
 * the next cache miss; adding them here would mean a second table lookup on a path whose
 * whole point is to be trivially cheap. If native rows ever need this, `comment_translations`
 * has no `created_at` and the guard above would need one.
 *
 * Session-gated like every other archive read (§1).
 */
export async function handleGetTranslations(req: Request, env: CommentsEnv, ctx?: ExecutionContext) {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const target = (url.searchParams.get("lang") ?? "").slice(0, MAX_LANG);
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((x) => x.trim())
    // ⚠️ Bare partner UUIDs. The client's own `{slug}:{uuid}` prefix means nothing here
    // and would match no row — the same trap `archiveUuidOf` exists for on the reply path.
    .filter((x) => ARCHIVE_ID_RE.test(x))
    .slice(0, MAX_POLL_IDS);

  if (!target || ids.length === 0) return json({ translations: {} });

  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT archive_id, text FROM archive_translations
      WHERE lang = ? AND created_at > ? AND archive_id IN (${placeholders})`,
  )
    .bind(target, Date.now() - TRANSLATION_POLL_MAX_AGE_MS, ...ids)
    .all<{ archive_id: string; text: string }>()
    .catch(() => ({ results: [] as Array<{ archive_id: string; text: string }> }));

  const translations: Record<string, string> = {};
  for (const r of results ?? []) translations[r.archive_id] = r.text;
  return json({ translations });
}

/**
 * A partner's comments, translated in place.
 *
 * ⚠️ **Returns new rows rather than mutating.** The array is upstream's payload passed
 * straight through, and it is also what `addNativeReplyCounts` and the block filter
 * read; spreading keeps every one of those working on a plain object with two extra
 * fields, which is exactly what the client's `ArchiveCommentDto` now expects.
 *
 * ⚠️ **Keyed on the BARE partner uuid**, which is what `archive_translations` stores.
 * The client's prefixed `{slug}:{uuid}` id is its own and means nothing here.
 *
 * ⚠️ **Top-level rows only.** Upstream also nests a `replies` array on a page row — the
 * block filter reaches into it — but the client's `ArchiveCommentDto` has no such field
 * and expands a thread through `/api/archive/comments/{id}/replies` instead, so
 * translating them here would spend model calls on text nothing renders.
 *
 * ⚠️ Rows with no `language` are left alone and are NOT flagged failed. Failed means
 * "we tried and could not", which is the client's cue to offer on-device translation —
 * and on-device translation needs a source language just as badly as we do, so offering
 * it there would be a button that cannot work.
 */
export async function translateArchiveRows(
  env: CommentsEnv,
  rows: unknown[],
  target: string,
  ctx?: ExecutionContext,
): Promise<unknown[]> {
  if (!target || rows.length === 0) return rows;

  const shaped = rows.map((r) => r as { id?: string; text?: string; language?: string | null });
  const results = await translate(
    env,
    shaped
      .filter((r) => !!r.id)
      .map((r) => ({
        id: r.id!,
        body: r.text ?? "",
        lang: r.language ?? null,
        version: srcHash(r.text ?? ""),
      })),
    target,
    archiveTranslations,
    ctx,
  );

  return rows.map((row, i) => {
    const hit = results[shaped[i].id ?? ""];
    if (!hit) return row;
    return { ...(row as object), translated: hit.text, translationFailed: hit.failed };
  });
}

// ── Path 1: the public list (unauthenticated, edge-cached) ──────────────────

/**
 * Canonical cache key. Built from the parsed subject rather than `req.url` so
 * `?episode=2&season=1` and `?season=1&episode=2` are one cache entry, not two —
 * `caches.default` keys on the URL byte-for-byte and would otherwise fork.
 */
function publicCacheKey(s: Subject, lang: string, only: string, cursor: number): Request {
  return new Request(
    `https://comments.invalid/${s.mediaType}/${s.tmdbId}/${s.season}/${s.episode}` +
      `?lang=${lang}&only=${only}&cursor=${cursor}`,
  );
}

/** `caches.default` where it exists (Workers). Node/vitest has no Cache API. */
function edgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * Public comments on [subject], newest first.
 *
 * **Keyset pagination, never `OFFSET`.** `LIMIT 20 OFFSET 200` scans and discards
 * 200 rows, so page 50 costs 50× page 1.
 *
 * [lang] filters to one language — tier 1 of the translation design, and a `WHERE`
 * clause on a query already being made, so it is free. A comment whose language
 * was never detected (`lang IS NULL`) always shows: failed detection must not
 * silently hide content.
 */
export async function loadPublicComments(env: CommentsEnv, s: Subject, lang: string, cursor: number) {
  const langFilter = lang ? " AND (c.lang IS NULL OR c.lang = ?)" : "";
  const binds: unknown[] = [s.tmdbId, s.mediaType, s.season, s.episode, cursor];
  if (lang) binds.push(lang);
  binds.push(PAGE_LIMIT);

  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM comments c LEFT JOIN profiles p ON p.user_id = c.author_id
                       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.tmdb_id = ? AND c.media_type = ? AND c.season = ? AND c.episode = ?
        AND c.visibility = 'public' AND c.created_at < ? AND ${LISTABLE} AND ${TOP_LEVEL}${langFilter}
      ORDER BY c.created_at DESC
      LIMIT ?`,
  )
    .bind(...binds)
    .all<CommentRow>();

  return results ?? [];
}

/**
 * The first [INLINE_REPLY_PREVIEW] replies for each of [parentIds], keyed by parent.
 *
 * ⚠️ **One query for the whole page, never one per parent.** A per-parent query
 * would put 20 subrequests into a read that already spends several, against a
 * 50-subrequest budget — the same arithmetic that caps `PAGE_LIMIT`. A window
 * function does it in one: rank each parent's replies by age and keep the first
 * few.
 *
 * Empty in, empty out, and no query at all — a signed-out read of a subject with
 * no threads must not pay for this.
 */
async function loadInlineReplies(
  env: CommentsEnv,
  parentIds: string[],
): Promise<Record<string, CommentRow[]>> {
  const out: Record<string, CommentRow[]> = {};
  if (parentIds.length === 0) return out;

  const placeholders = parentIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT ${SELECT_COLUMNS},
              ROW_NUMBER() OVER (PARTITION BY c.parent_id ORDER BY c.created_at ASC) AS rn
         FROM comments c LEFT JOIN profiles p ON p.user_id = c.author_id
                         LEFT JOIN users u ON u.id = c.author_id
        WHERE c.parent_id IN (${placeholders}) AND ${RENDERABLE}
     ) WHERE rn <= ?`,
  )
    .bind(...parentIds, INLINE_REPLY_PREVIEW)
    .all<CommentRow>();

  for (const r of results ?? []) {
    if (r.parent_id == null) continue;
    (out[r.parent_id] ??= []).push(r);
  }
  return out;
}

/**
 * Attach the inline reply preview to a page of top-level rows.
 *
 * Only rows that actually report replies are asked for — `reply_count` is a
 * maintained column, so this is free and skips the query entirely for the common
 * case of a page with no threads on it.
 */
async function withInlineReplies(
  env: CommentsEnv,
  rows: CommentRow[],
  counts: Record<string, Record<string, number>>,
): Promise<Array<ReturnType<typeof toWire>>> {
  const threaded = rows.filter((r) => (r.reply_count ?? 0) > 0).map((r) => r.id);
  const inline = await loadInlineReplies(env, threaded);
  return rows.map((r) =>
    toWire(
      r,
      counts[r.id],
      undefined,
      inline[r.id]?.map((reply) => toWire(reply, counts[reply.id])),
    ),
  );
}

/**
 * Which languages this subject's public comments are actually written in.
 *
 * Replaces a bare "N comments in other languages" count. A count can only power a
 * single "show all" toggle; the picker needs to name the languages, and naming them
 * is what lets a reader choose one deliberately instead of being filtered by a guess
 * about their locale.
 *
 * One grouped query on the same indexed subject prefix the list read already walks,
 * bounded by [MAX_LANG_OPTIONS] so it can never become a scan. Rows whose language
 * was never detected are excluded — they always show regardless of filter, so they
 * are not a choice anyone can make.
 */
async function languageBreakdown(env: CommentsEnv, s: Subject): Promise<Array<{ lang: string; n: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT c.lang AS lang, COUNT(*) AS n
       FROM comments c
      WHERE c.tmdb_id = ? AND c.media_type = ? AND c.season = ? AND c.episode = ?
        AND c.visibility = 'public' AND ${RENDERABLE} AND ${TOP_LEVEL} AND c.lang IS NOT NULL
      GROUP BY c.lang
      ORDER BY n DESC
      LIMIT ?`,
  )
    .bind(s.tmdbId, s.mediaType, s.season, s.episode, MAX_LANG_OPTIONS)
    .all<{ lang: string; n: number }>();
  return results ?? [];
}


/**
 * `GET /api/titles/{type}/{tmdbId}/comments?season=&episode=&lang=&cursor=`
 *
 * ⚠️ **Caching a Worker response is not automatic.** Unlike the R2-direct paths
 * (home rails, unified detail) where Cloudflare's CDN caches for free, a Worker
 * runs *in front of* the cache, so its response is never stored just because it
 * carries `Cache-Control`. It has to be put there explicitly, below.
 *
 * `caches.default` is **per-colo**, so the win scales with concurrent readers in
 * one region and is near-zero at low traffic. Built in anyway: retrofitting
 * caching around an endpoint's contract later is worse than writing it now.
 */
export async function handleGetComments(req: Request, env: CommentsEnv, s: Subject, ctx?: ExecutionContext) {
  // The second drain trigger. Hanging the only one off the friends path made the
  // outbox depend on a signed-in reader opening a sheet — a comment posted and not
  // followed by one sat queued indefinitely, which is exactly what happened on the
  // first live mirror. Both read paths now drain; neither waits for it.
  if (ctx) ctx.waitUntil(drainArchiveOutbox(env as any).catch(() => 0));

  const url = new URL(req.url);
  /**
   * The reader's language, used ONLY as the translation target.
   *
   * ⚠️ This used to double as a filter, and that was the bug: a reader whose language
   * did not match the comments saw them fetched and then hidden, with nothing saying
   * why. Showing everything and translating into their language is what they actually
   * wanted from "I speak German" — not "hide anything not German".
   */
  const lang = (url.searchParams.get("lang") ?? "").slice(0, MAX_LANG);
  /** Optional narrowing, from the language picker. Absent ⇒ every language. */
  const only = (url.searchParams.get("only") ?? "").slice(0, MAX_LANG);
  const cursor = Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER;

  const cache = edgeCache();
  const key = publicCacheKey(s, lang, only, cursor);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const rows = await loadPublicComments(env, s, only, cursor);
  const counts = await loadReactionCounts(env, rows.map((r) => r.id));
  // Automatic, not opt-in. Cached per comment in D1 and keyed on `src_updated_at`, so
  // the cost is paid once per comment per language across every reader — and the
  // response stays per-LANGUAGE rather than per-reader, so it still edge-caches.
  const threaded = rows.filter((r) => (r.reply_count ?? 0) > 0).map((r) => r.id);
  const inline = await loadInlineReplies(env, threaded);
  const inlineRows = Object.values(inline).flat();
  const replyCounts = await loadReactionCounts(env, inlineRows.map((r) => r.id));
  // ⚠️ Replies are translated exactly like top-level comments — decided, not an
  // oversight. They go through the SAME `translateRows` call as the page they ride
  // on, so the subrequest budget sees one batch, not two, and the per-comment D1
  // cache means steady-state spend is proportional to NEW replies, not to reads.
  const translations = lang ? await translateRows(env, [...rows, ...inlineRows], lang, ctx) : {};
  const res = json({
    comments: rows.map((r) =>
      toWire(
        r,
        counts[r.id],
        translations[r.id],
        inline[r.id]?.map((reply) => toWire(reply, replyCounts[reply.id], translations[reply.id])),
      ),
    ),
    languages: await languageBreakdown(env, s),
    cursor: rows.length === PAGE_LIMIT ? rows[rows.length - 1].created_at : null,
  });
  res.headers.set("Cache-Control", `public, max-age=${PUBLIC_CACHE_SECONDS}`);

  // Fire-and-forget: a response must never be delayed by storing it.
  const put = cache?.put(key, res.clone());
  if (put) {
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

// ── Path 2: the friends slice (authenticated, NEVER cached) ─────────────────

/**
 * `GET /api/titles/{type}/{tmdbId}/comments/friends?season=&episode=`
 *
 * The friends-only comments the caller may read, plus the caller's own comment on
 * this subject whatever its visibility, plus the caller's own reactions across the
 * whole subject.
 *
 * The `IN` list is acceptable **here** and not on the public path: the index prefix
 * reaches `visibility='friends'` so the ordering survives and the engine walks
 * newest-first and stops at 20. Worst case it walks every friends-only comment on
 * the subject, a small minority of them. On the public path the same `IN` would sit
 * beside `OR` and defeat the ordering entirely.
 *
 * The caller's own id joins the author list rather than being `OR`-ed in, which is
 * how "my own friends-only comment is visible to me" costs nothing extra.
 *
 * `myReactions` rides this response rather than a request of its own: the toggle
 * state is needed for public comments too, and this is the one authenticated call
 * the sheet already makes.
 */
export async function handleGetFriendComments(
  req: Request,
  env: CommentsEnv,
  s: Subject,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const cursor = Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER;
  /**
   * The reader's language, and the archive half's translation TARGET.
   *
   * ⚠️ Absent means "translate nothing", not "translate into English" — an older
   * client that does not send it must keep getting exactly the response it got before.
   */
  const lang = (url.searchParams.get("lang") ?? "").slice(0, MAX_LANG);

  /**
   * ⚠️ Started BEFORE the D1 work and awaited after it, so the upstream round trip
   * overlaps the queries rather than being serialised behind them. The friends path
   * spends ~6 subrequests today against the free plan's 50; the archive fetch plus its
   * D1 lookups adds ~5, and translating the page adds a cache read, a batched write and
   * up to [ARCHIVE_PAGE_LIMIT] AI calls on a page nobody has read in this language yet.
   * Still inside the cap, and steady state is the cache read alone.
   *
   * `.catch(() => null)` because this must never reject the whole response: a broken
   * archive hides its own section and nothing else.
   */
  const archivePromise = loadArchivePage(
    env as any,
    s.mediaType,
    s.tmdbId,
    s.season,
    s.episode,
    session.userId,
    Number(url.searchParams.get("tvdbId")) || null,
    url.searchParams.get("archiveCursor"),
  ).catch(() => null);

  // The outbox drains on somebody else's request — the account is at its 5-cron limit,
  // which is why the orphan reaper is triggered this way too. Bounded to 5 items: each
  // is an outbound subrequest and an unbounded drain would blow the 50-subrequest cap
  // and take down whatever request happened to trigger it.
  {
    const drain = drainArchiveOutbox(env as any).catch(() => 0);
    if (ctx) ctx.waitUntil(drain);
    // No `await` fallback: without a ctx this is a test or a synchronous path, and
    // making a read wait on outbound writes would be the one thing the drain must
    // never do.
  }

  const { accepted } = await loadFriendships(env as any, session.userId);
  const authors = [session.userId, ...accepted];
  const placeholders = authors.map(() => "?").join(",");

  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM comments c LEFT JOIN profiles p ON p.user_id = c.author_id
                       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.tmdb_id = ? AND c.media_type = ? AND c.season = ? AND c.episode = ?
        AND c.visibility = 'friends' AND c.author_id IN (${placeholders})
        AND c.created_at < ? AND ${LISTABLE} AND ${TOP_LEVEL}
      ORDER BY c.created_at DESC
      LIMIT ?`,
  )
    .bind(s.tmdbId, s.mediaType, s.season, s.episode, ...authors, cursor, PAGE_LIMIT)
    .all<CommentRow>();

  const rows = results ?? [];
  const counts = await loadReactionCounts(env, rows.map((r) => r.id));
  const archivePage = await archivePromise;
  // ⚠️ Our replies are counted onto the partner's rows before they go out. The archive
  // cannot know about a reply living in our database, so without this the expander is
  // missing on exactly the thread someone just replied to.
  //
  // ⚠️ Translation runs FIRST, on the partner's own fields, and the reply counts are
  // added to what it returns — not the other way round. `translateArchiveRows` rebuilds
  // each row by spreading, so running it second would spread over the counted row and
  // keep the count, but only by accident; ordering it first means neither pass has to
  // know what the other added.
  const archive = archivePage
    ? {
        ...archivePage,
        comments: await addNativeReplyCounts(
          env,
          await translateArchiveRows(env, archivePage.comments, lang, ctx),
        ),
      }
    : archivePage;
  return json({
    comments: await withInlineReplies(env, rows, counts),
    myReactions: await loadMyReactions(env, s, session.userId),
    cursor: rows.length === PAGE_LIMIT ? rows[rows.length - 1].created_at : null,
    /**
     * The archive half, or null.
     *
     * ⚠️ **It rides THIS call rather than a route of its own, and that is the whole
     * point.** A Worker on a route always runs, so a separate `/comments/archive`
     * would be a third chargeable invocation per sheet open for nothing. This call is
     * already authenticated, already made on every signed-in open, and already never
     * cached — and archive reads require a session anyway (§1), so the two have
     * identical preconditions. Measured at 2 invocations per open on 2026-08-30; keep
     * it that way.
     *
     * Awaited alongside the D1 work above rather than before it — see the Promise.all
     * at the top of this handler.
     */
    archive,
  });
}

/**
 * One page of replies under a parent, oldest first.
 *
 * ⚠️ **Fetched lazily, on expand only — never while rendering a list.** This is
 * the one genuinely new per-user-action invocation replies add, and it applies to
 * native comments as much as archive ones. The inline preview on the parent is what
 * keeps it from firing for the short threads that are the majority.
 *
 * Oldest first, unlike the top-level list: a thread reads in the order it was
 * written. The cursor is therefore a `created_at` FLOOR, not a ceiling.
 *
 * ⚠️ **A HIDDEN parent returns nothing** — moderation must not be escapable by
 * addressing the subtree directly, or hiding a parent that still has replies would
 * leave every reply readable through this route.
 *
 * ⚠️ **A DELETED parent does not.** These two were one guard, and collapsing them
 * truncated every tombstoned thread past the inline preview: the list attaches the
 * first [INLINE_REPLY_PREVIEW] replies to a tombstone (that is the whole point of
 * keeping the row — see `LISTABLE`), the client expands only when it holds fewer
 * than `replyCount`, and that expand landed here and 404'd. A thread with three
 * replies therefore advertised three, showed two, and the client swallowed the
 * failure — no error, just a thread stopping short of its own badge. An author
 * deleting their own words is the case the tombstone EXISTS to keep reachable; only
 * a moderator's hide is meant to take the subtree with it.
 */
export async function handleGetReplies(
  parentId: string,
  req: Request,
  env: CommentsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!COMMENT_ID_RE.test(parentId)) return json({ error: "invalid_payload" }, 400);

  const url = new URL(req.url);
  const cursor = Number(url.searchParams.get("cursor")) || 0;
  const lang = (url.searchParams.get("lang") ?? "").slice(0, MAX_LANG);

  const parent = await env.DB.prepare(
    `SELECT id, author_id, visibility, hidden_at, deleted_at FROM comments WHERE id = ?`,
  )
    .bind(parentId)
    .first<{
      id: string;
      author_id: string;
      visibility: string;
      hidden_at: number | null;
      deleted_at: number | null;
    }>();
  if (!parent) return notFound();
  if (parent.hidden_at != null) return notFound();

  // A friends-only thread is readable by exactly the people who may read its
  // parent, so the check is the parent's, not a second rule. `mayReadComment`
  // already handles blocks bidirectionally and the author's own view.
  if (parent.visibility !== "public") {
    const session = await resolveSession(req, env as any, ctx);
    if (!session) return json({ error: "unauthorized" }, 401);
    // ⚠️ `deleted_at` blanked on purpose. `mayReadComment` refuses a deleted row
    // outright, which is right for the permalink and notification paths it also
    // serves — there the comment ITSELF is what is being opened. Here the parent is
    // only the access rule for its replies, and those are not deleted, so the
    // question is who was allowed to read this thread, not whether the parent still
    // renders. Without this a friends-only tombstone stays truncated even after the
    // hidden/deleted split above.
    const allowed = await mayReadComment(env, session.userId, { ...parent, deleted_at: null } as CommentRow);
    if (!allowed) return notFound();
  }

  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM comments c LEFT JOIN profiles p ON p.user_id = c.author_id
                       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.parent_id = ? AND c.created_at > ? AND ${RENDERABLE}
      ORDER BY c.created_at ASC
      LIMIT ?`,
  )
    .bind(parentId, cursor, REPLY_PAGE_LIMIT)
    .all<CommentRow>();

  const rows = results ?? [];
  const counts = await loadReactionCounts(env, rows.map((r) => r.id));
  const translations = lang ? await translateRows(env, rows, lang, ctx) : {};
  return json({
    comments: rows.map((r) => toWire(r, counts[r.id], translations[r.id])),
    cursor: rows.length === REPLY_PAGE_LIMIT ? rows[rows.length - 1].created_at : null,
  });
}

/**
 * Our own replies sitting under an archive comment.
 *
 * ⚠️ Returned in the NATIVE wire shape and kept in a separate field, never merged into
 * the partner's own reply array. A row shaped like an archive comment renders with the
 * partner's source badge and `isActionable = false` — so our author would lose the
 * edit and delete on their own words, and gain a report button pointed at themselves.
 * Two shapes, one thread, merged by `createdAt` on the client.
 */
export async function loadNativeArchiveReplies(
  env: CommentsEnv,
  archiveId: string,
  lang: string,
  ctx?: ExecutionContext,
): Promise<Array<ReturnType<typeof toWire>>> {
  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM comments c LEFT JOIN profiles p ON p.user_id = c.author_id
                       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.parent_archive_id = ? AND ${RENDERABLE}
      ORDER BY c.created_at ASC
      LIMIT ?`,
  )
    .bind(archiveId, REPLY_PAGE_LIMIT)
    .all<CommentRow>();

  const rows = results ?? [];
  if (rows.length === 0) return [];
  const counts = await loadReactionCounts(env, rows.map((r) => r.id));
  const translations = lang ? await translateRows(env, rows, lang, ctx) : {};
  return rows.map((r) => toWire(r, counts[r.id], translations[r.id]));
}

/**
 * Add our replies to each archive row's `replyCount`.
 *
 * ⚠️ Without this the expander never appears on the one row that needs it. The count
 * on an archive comment is the PARTNER's, and it cannot know about a reply that lives
 * in our database — so the first person to answer an otherwise unanswered archive
 * comment would post into a thread with no affordance to open it, and never see their
 * own reply again.
 *
 * One query for the page, keyed by parent, exactly as the native inline preview does.
 */
export async function addNativeReplyCounts(
  env: CommentsEnv,
  comments: unknown[],
): Promise<unknown[]> {
  const ids = comments.map((c) => (c as { id?: string })?.id ?? "").filter(Boolean);
  if (ids.length === 0) return comments;

  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT c.parent_archive_id AS pid, COUNT(*) AS n
       FROM comments c
      WHERE c.parent_archive_id IN (${placeholders}) AND ${RENDERABLE}
      GROUP BY c.parent_archive_id`,
  )
    .bind(...ids)
    .all<{ pid: string; n: number }>()
    .catch(() => ({ results: [] as Array<{ pid: string; n: number }> }));

  const extra = new Map((results ?? []).map((r) => [r.pid, Number(r.n) || 0]));
  if (extra.size === 0) return comments;

  return comments.map((c) => {
    const row = c as { id?: string; replyCount?: number };
    const n = extra.get(row?.id ?? "") ?? 0;
    return n === 0 ? c : { ...row, replyCount: (row.replyCount ?? 0) + n };
  });
}

/**
 * The caller's own reaction on every comment they have reacted to on this subject.
 *
 * Scoped by subject rather than by an id list so the client never has to send the
 * page back, which also means it covers public comments the caller reacted to —
 * the toggle state has to render on those too, and they arrive on the cached path
 * that by definition cannot carry anything reader-specific.
 */
async function loadMyReactions(env: CommentsEnv, s: Subject, userId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT r.comment_id, r.emoji
       FROM comment_reactions r
       JOIN comments c ON c.id = r.comment_id
      WHERE r.user_id = ?
        AND c.tmdb_id = ? AND c.media_type = ? AND c.season = ? AND c.episode = ?
      LIMIT ?`,
  )
    .bind(userId, s.tmdbId, s.mediaType, s.season, s.episode, MY_REACTIONS_LIMIT)
    .all<{ comment_id: string; emoji: string }>();

  const out: Record<string, string> = {};
  for (const r of results ?? []) out[r.comment_id] = r.emoji;
  return out;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** Per-author hourly cap, the same shape as the friend-request limiter. */
async function rateLimited(env: CommentsEnv, userId: string): Promise<boolean> {
  const limit = Number(env.COMMENTS_PER_HOUR ?? DEFAULT_COMMENTS_PER_HOUR);
  if (limit <= 0) return false;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND created_at > ?")
    .bind(userId, Date.now() - 3600_000)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= limit;
}

/**
 * Has this author already written the hour's allowance on **this subject**?
 *
 * ⚠️ The belt that became the control. `wrangler.toml` used to say plainly that
 * "the real anti-spam control is one comment per user per subject" — that is gone,
 * so a per-thread cap has to exist or one sheet can absorb the entire product-wide
 * hourly budget. Counted over `comments` on the same index the subject reads use,
 * so it costs one indexed row count rather than a new table.
 */
async function subjectRateLimited(env: CommentsEnv, userId: string, s: Subject): Promise<boolean> {
  const limit = Number(env.COMMENTS_PER_SUBJECT_PER_HOUR ?? DEFAULT_COMMENTS_PER_SUBJECT_PER_HOUR);
  if (limit <= 0) return false;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM comments
      WHERE author_id = ? AND tmdb_id = ? AND media_type = ? AND season = ? AND episode = ?
        AND created_at > ?`,
  )
    .bind(userId, s.tmdbId, s.mediaType, s.season, s.episode, Date.now() - 3600_000)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= limit;
}

const BURST_WINDOW_MS = 60_000;
const DEFAULT_WRITES_PER_MINUTE = 5;
const DEFAULT_WRITES_PER_MINUTE_IP = 20;

/** Hex SHA-256. Used to key the IP counter without storing the address itself. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Burst limit on a comment write, per author AND per connecting IP.
 *
 * Both are checked, not either: the per-user key is what finally bounds the edit
 * loop that the hourly cap leaves free, and the per-IP key is what makes running
 * twenty accounts from one script cost twenty times as much as it currently does.
 *
 * The IP check runs second so a single abusive account trips its own key first —
 * an IP strike is the broader signal and shouldn't be spent on one user's typo.
 */
async function burstLimited(env: CommentsEnv, req: Request, userId: string): Promise<boolean> {
  const userLimit = Number(env.COMMENT_WRITES_PER_MINUTE ?? DEFAULT_WRITES_PER_MINUTE);
  const ipLimit = Number(env.COMMENT_WRITES_PER_MINUTE_IP ?? DEFAULT_WRITES_PER_MINUTE_IP);
  if (userLimit <= 0 && ipLimit <= 0) return false;

  const now = Date.now();
  const since = now - BURST_WINDOW_MS;
  const rawIp = req.headers.get("CF-Connecting-IP") ?? "";
  const ipHash = rawIp ? await sha256Hex(rawIp) : null;

  if (userLimit > 0) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM comment_write_events WHERE user_id = ? AND created_at > ?",
    )
      .bind(userId, since)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= userLimit) return true;
  }

  if (ipLimit > 0 && ipHash) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM comment_write_events WHERE ip_hash = ? AND created_at > ?",
    )
      .bind(ipHash, since)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= ipLimit) return true;
  }

  // Only an ACCEPTED write is recorded, matching the R2 limiter's increment-when-under
  // rule. A refused attempt that extended its own window would turn a fixed cap into a
  // penalty box, and the client retries blind — one burst would lock someone out for
  // far longer than the window.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO comment_write_events (id, user_id, ip_hash, created_at) VALUES (?, ?, ?, ?)").bind(
      newId(),
      userId,
      ipHash,
      now,
    ),
    // Pruned here rather than on a schedule: this account has no cron budget left, and
    // the table is only ever read over the last window anyway.
    env.DB.prepare("DELETE FROM comment_write_events WHERE created_at <= ?").bind(since),
  ]);

  return false;
}

/**
 * The 429 body for a comment write.
 *
 * `Retry-After` travels because the Android outbox retries blind: a dirty row
 * whose only feedback is a bare 429 is exactly the shape that produced the
 * reaction poison pill, where a permanently-failing write retried every sync
 * forever. A client that is told when to come back can park instead of spinning.
 */
const rateLimitedBody = (retryAfterSeconds = 60) =>
  json({ error: "rate_limited" }, 429, { "Retry-After": String(retryAfterSeconds) });

const STRIKE_WINDOW_MS = 3600_000;
/**
 * At most one strike per user per scope per minute.
 *
 * ⚠️ Load-bearing, and the reason is the CLIENT. `CommentsRepository.syncOutbox`
 * leaves a row dirty on anything that is not a 403 suspension, and every user action
 * kicks another sweep — so one refused write is retried repeatedly with no backoff.
 * Counting each retry would let a person who tapped send a few times too fast rack up
 * ten strikes in seconds and earn a 24h suspension for it.
 *
 * Debounced to the limiter's own period, ten strikes means ten *minutes* of sustained
 * hammering, which a human bursting through the composer cannot produce and a script
 * cannot avoid.
 */
const STRIKE_DEBOUNCE_MS = 60_000;
const DEFAULT_STRIKES_TO_SUSPEND = 10;
/** One day, matching the shortest option an admin can pick in SUSPEND_DURATIONS. */
const DEFAULT_AUTO_SUSPEND_MS = 86_400_000;

/**
 * Record one rate-limit strike and suspend posting once they pile up.
 *
 * Hitting a limit once is ordinary — a fast thumb, a retry after a dropped
 * response. Hitting it ten times in an hour is a script, and the limiter alone
 * would let that script keep trying forever at one request per window. The strike
 * table turns "refused" into "stopped".
 *
 * Runs entirely inside `ctx.waitUntil`, so a caller that has already been refused
 * never waits on it, and a failure here can never convert a 429 into a 500 —
 * the same best-effort posture `recordAdminAction` takes.
 */
async function recordStrike(env: CommentsEnv, ctx: ExecutionContext | undefined, userId: string, scope: string): Promise<void> {
  const work = (async () => {
    try {
      const now = Date.now();

      const recent = await env.DB.prepare(
        "SELECT 1 AS hit FROM rate_limit_strikes WHERE user_id = ? AND scope = ? AND created_at > ? LIMIT 1",
      )
        .bind(userId, scope, now - STRIKE_DEBOUNCE_MS)
        .first<{ hit: number }>();
      if (recent) return;

      await env.DB.prepare(
        "INSERT INTO rate_limit_strikes (id, user_id, scope, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(newId(), userId, scope, now)
        .run();

      const threshold = Number(env.STRIKES_TO_SUSPEND ?? DEFAULT_STRIKES_TO_SUSPEND);
      if (threshold <= 0) return;

      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM rate_limit_strikes WHERE user_id = ? AND created_at > ?",
      )
        .bind(userId, now - STRIKE_WINDOW_MS)
        .first<{ n: number }>();
      if ((row?.n ?? 0) < threshold) return;

      // Only ever EXTENDS a suspension. `MAX` means an automatic 24h cannot cut
      // short a longer one an admin set by hand.
      const until = now + Number(env.AUTO_SUSPEND_MS ?? DEFAULT_AUTO_SUSPEND_MS);
      await env.DB.prepare(
        "UPDATE users SET posting_suspended_until = MAX(COALESCE(posting_suspended_until, 0), ?) WHERE id = ?",
      )
        .bind(until, userId)
        .run();

      // Logged as an admin action with a `system` actor so an automatic suspension
      // appears in the same audit trail as a manual one — otherwise a user asking
      // "why can't I post" has no answer anyone can look up.
      await recordAdminAction(env.DB, "system", "auto_posting_suspend", userId, {
        reason: "rate_limit_strikes",
        scope,
        strikes: row?.n ?? 0,
        until,
      });

      // Prune the window in the same pass. There is no cron budget left on this
      // account, so anything not cleaned opportunistically grows forever.
      await env.DB.prepare("DELETE FROM rate_limit_strikes WHERE created_at <= ?")
        .bind(now - STRIKE_WINDOW_MS)
        .run();
    } catch (e) {
      console.error("recordStrike failed", scope, e);
    }
  })();

  if (ctx) ctx.waitUntil(work);
  else await work;
}

interface MediaInput {
  kind: string | null;
  provider: string | null;
  id: string | null;
  url: string | null;
  w: number | null;
  h: number | null;
}

/** One media item per comment, or none. Any malformed part drops the whole item. */
/**
 * Validate client-supplied mention spans.
 *
 * Capped at [MAX_MENTIONS] and shape-checked rather than trusted: the spans index
 * into the body and are rendered as substring replacements, so a bad `start`/`end`
 * is a rendering bug on every client that reads them — ours and, once mirrored,
 * every other partner app's.
 */
function parseMentionsInput(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return [];
  const out: Mention[] = [];
  for (const m of raw.slice(0, MAX_MENTIONS)) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const authorId = typeof o.authorId === "string" ? o.authorId : "";
    const start = Number(o.start);
    const end = Number(o.end);
    const text = typeof o.text === "string" ? o.text.slice(0, MAX_BODY) : "";
    if (!USER_ID_RE.test(authorId)) continue;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue;
    out.push({ authorId, start, end, text });
  }
  return out;
}

function parseMedia(raw: unknown): MediaInput {
  const none: MediaInput = { kind: null, provider: null, id: null, url: null, w: null, h: null };
  if (!raw || typeof raw !== "object") return none;
  const m = raw as Record<string, unknown>;
  const kind = typeof m.kind === "string" ? m.kind : "";
  const provider = typeof m.provider === "string" ? m.provider : "";
  const id = typeof m.id === "string" ? m.id.slice(0, MAX_MEDIA_ID) : "";
  const url = typeof m.url === "string" ? m.url.slice(0, MAX_MEDIA_URL) : "";
  if (!MEDIA_KINDS.has(kind) || !MEDIA_PROVIDERS.has(provider) || !id || !url) return none;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  return { kind, provider, id, url, w: num(m.w), h: num(m.h) };
}

/**
 * `POST /api/comments` — write or edit the caller's comment on a subject.
 *
 * One comment per user per subject, editable forever. That is the primary
 * anti-spam control: spam is bounded by how many subjects someone can be bothered
 * to visit. So this is an upsert on `(author_id, subject)`, not an insert — and
 * the id is the caller's, stable, so a retry after a dropped response is the same
 * comment rather than a second one.
 *
 * ⚠️ The **existing row's id wins** on an edit. A client that regenerates its id
 * would otherwise orphan every reaction on the comment it thinks it is editing.
 *
 * Editing forever is safe only because a report snapshots the body it was filed
 * against — see `handleReportComment`.
 */
export async function handlePostComment(
  req: Request,
  env: CommentsEnv,
  ctx?: ExecutionContext,
  notify?: CommentNotifier,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  // App Check proves the caller is a genuine install, which a session token cannot:
  // a session is a 90-day bearer credential anyone can mint by signing in once and
  // then use from a script forever. Under `log` this only records; see appcheck.ts.
  const version = appVersion(req);
  const { outcome, enforced } = await evaluateAppCheck(req, env, version);
  logAppCheck(outcome, version, env.APPCHECK_MODE ?? "off");
  if (enforced) return json({ error: "app_check_required" }, 403);

  // Burst limit BEFORE the body is read: a refused write should cost as little as
  // possible, and this is the path a flood arrives on.
  if (await burstLimited(env, req, session.userId)) {
    await recordStrike(env, ctx, session.userId, "comment_write");
    return rateLimitedBody();
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Editing is a POST here too, and it is blocked as well: an author who could edit
  // while suspended could turn clean text into abuse without posting anything new.
  const suspendedUntil = await postingSuspendedUntil(env.DB, session.userId);
  if (suspendedUntil > 0) return json(suspendedBody(suspendedUntil), 403);

  const id = typeof payload.id === "string" ? payload.id : "";
  const mediaType = typeof payload.mediaType === "string" ? payload.mediaType : "";
  const params = new URLSearchParams();
  params.set("season", String(payload.season ?? -1));
  params.set("episode", String(payload.episode ?? -1));
  const subject = parseSubject(mediaType, String(payload.tmdbId ?? ""), params);

  if (!COMMENT_ID_RE.test(id) || !subject) return json({ error: "invalid_payload" }, 400);

  const body = typeof payload.body === "string" ? payload.body.trim().slice(0, MAX_BODY) : "";
  const reaction = typeof payload.reaction === "string" ? payload.reaction.slice(0, MAX_REACTION) : null;
  const media = parseMedia(payload.media);
  const lang = typeof payload.lang === "string" ? payload.lang.slice(0, MAX_LANG) || null : null;
  const spoiler = payload.spoiler === true ? 1 : 0;
  // ⚠️ Lenient parse in the SAFE direction. An unrecognised value must never widen
  // access, so anything that is not exactly 'public' is friends-only.
  const visibility = payload.visibility === "public" ? "public" : "friends";

  // A comment with no text, no media and no media reaction is not a comment.
  if (!body && !media.id && !reaction) return json({ error: "invalid_payload" }, 400);

  // Thread placement. Absent ⇒ a top-level comment, which is every comment written
  // before 0044 and most written after it.
  const parentIdRaw = typeof payload.parentId === "string" ? payload.parentId : "";
  const inReplyToRaw = typeof payload.inReplyToId === "string" ? payload.inReplyToId : "";
  /**
   * Replying into ANOTHER APP's thread.
   *
   * ⚠️ A separate field, never `parentId` widened to accept a UUID. `parentId` is
   * resolved against this table and drives the depth/flatten walk; letting a partner
   * id through it would send every one of those lookups after a row that cannot
   * exist. The two are mutually exclusive and a request carrying both is rejected
   * rather than silently resolved in one direction.
   *
   * ⚠️ BARE uuid — the client's `slug:` prefix is a rendering key and must be
   * stripped before it gets here. The mirror publishes to
   * `/comments/{parentArchiveId}/replies`, where a prefixed value is a 404.
   */
  const parentArchiveRaw = typeof payload.parentArchiveId === "string" ? payload.parentArchiveId : "";
  const mentions = parseMentionsInput(payload.mentions);
  if (parentIdRaw && !COMMENT_ID_RE.test(parentIdRaw)) return json({ error: "invalid_payload" }, 400);
  if (inReplyToRaw && !COMMENT_ID_RE.test(inReplyToRaw)) return json({ error: "invalid_payload" }, 400);
  if (parentArchiveRaw && !ARCHIVE_ID_RE.test(parentArchiveRaw)) return json({ error: "invalid_payload" }, 400);
  if (parentArchiveRaw && parentIdRaw) return json({ error: "invalid_payload" }, 400);
  /**
   * ⚠️ **Public only, and enforced HERE rather than trusted from the client.**
   *
   * This reply is published to a third party the moment the mirror drains it, and
   * `mayMirror` only ever publishes public rows — so a friends-only one would be
   * accepted, stored, and then silently never reach the person it answers. The app
   * withholds the toggle; this is what makes it true.
   */
  if (parentArchiveRaw && visibility !== "public") return json({ error: "visibility_required" }, 400);

  // ⚠️ **Looked up by ID, not by (author, subject).** A user may now hold many
  // comments on one subject, so the subject no longer identifies a row — and a
  // by-subject lookup would turn every second comment into an edit of the first,
  // silently collapsing them. The id IS the create/edit distinction now: an id that
  // already exists is an edit, an id that does not is a create. Client ids are
  // deterministic per user action, so a retry after a dropped response still lands
  // on the same row rather than duplicating.
  const existing = await env.DB.prepare(
    `SELECT id, author_id, visibility, hidden_at, deleted_at, body, media_id, created_at
       FROM comments
      WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      author_id: string;
      visibility: string;
      hidden_at: number | null;
      deleted_at: number | null;
      body: string;
      media_id: string | null;
      created_at: number;
    }>();

  // ⚠️ An edit must be by the author. The old by-subject lookup could only ever
  // return the caller's own row, so ownership was implicit; addressing by id makes
  // it a guessable parameter and the check has to become explicit. 404, not 403 —
  // the same answer a missing id gets, so ids cannot be probed for existence.
  if (existing && existing.author_id !== session.userId) return notFound();

  // Only a NEW comment spends rate-limit budget. Editing is not posting, and
  // charging for it would make a typo fix cost the same as a new comment.
  if (!existing && (await rateLimited(env, session.userId))) {
    await recordStrike(env, ctx, session.userId, "comment_hourly");
    return rateLimitedBody(3600);
  }

  // ⚠️ The per-subject cap replaces one-comment-per-subject as the flood control on
  // a single thread. `COMMENTS_PER_HOUR` alone is product-wide, so without this one
  // user could spend their whole hourly budget on one title's sheet. Checked after
  // the hourly cap so the coarser refusal wins, and only for a NEW comment.
  if (!existing && (await subjectRateLimited(env, session.userId, subject))) {
    await recordStrike(env, ctx, session.userId, "comment_subject_hourly");
    return rateLimitedBody(3600);
  }

  /**
   * Resolve where this reply actually lands.
   *
   * ⚠️ **The flattening is ours to do, not the client's.** Depth is capped at
   * [MAX_DEPTH]: a reply to a comment already at the cap is stored at the cap under
   * the SAME `parent_id`, with `in_reply_to_id` naming what the user actually
   * tapped. Clients post to whatever was tapped and render what comes back, which
   * is also what the archive does — so one mirror path serves both.
   */
  let parentId: string | null = null;
  let inReplyToId: string | null = null;
  let rootId: string | null = null;
  let depth = 0;
  if (!existing && parentIdRaw) {
    const target = await env.DB.prepare(
      `SELECT id, parent_id, root_id, depth, tmdb_id, media_type, season, episode,
              hidden_at, deleted_at
         FROM comments WHERE id = ?`,
    )
      .bind(parentIdRaw)
      .first<{
        id: string;
        parent_id: string | null;
        root_id: string | null;
        depth: number;
        tmdb_id: number;
        media_type: string;
        season: number;
        episode: number;
        hidden_at: number | null;
        deleted_at: number | null;
      }>();
    if (!target) return json({ error: "parent_not_found" }, 404);
    // Replying to something moderated away would resurrect it as a visible thread.
    if (target.hidden_at != null || target.deleted_at != null) return json({ error: "parent_not_found" }, 404);
    // A reply belongs to its parent's subject. Accepting a mismatch would put the
    // reply on a page its parent is not on, where nothing would ever render it.
    if (
      target.tmdb_id !== subject.tmdbId ||
      target.media_type !== subject.mediaType ||
      target.season !== subject.season ||
      target.episode !== subject.episode
    ) {
      return json({ error: "invalid_payload" }, 400);
    }

    const targetDepth = target.depth ?? 0;
    if (targetDepth >= MAX_DEPTH) {
      // Flattened: same parent as the comment being answered.
      parentId = target.parent_id;
      depth = MAX_DEPTH;
    } else {
      parentId = target.id;
      depth = targetDepth + 1;
    }
    rootId = target.root_id ?? target.id;
    // What the user actually answered, which is the target even when flattened.
    inReplyToId = inReplyToRaw || target.id;
  }

  const now = Date.now();

  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(
      env.DB.prepare(
        `UPDATE comments
            SET body = ?, reaction = ?, visibility = ?, spoiler = ?, lang = ?,
                media_kind = ?, media_provider = ?, media_id = ?, media_url = ?,
                media_w = ?, media_h = ?, mentions_json = ?, deleted_at = NULL,
                updated_at = ?
          WHERE id = ? AND author_id = ?`,
      ).bind(
        body,
        reaction,
        visibility,
        spoiler,
        lang,
        media.kind,
        media.provider,
        media.id,
        media.url,
        media.w,
        media.h,
        // ⚠️ Mentions move with the text and nothing else does. An edit must NOT
        // touch `parent_id` / `depth` / `root_id`: re-parenting a comment that
        // already has replies would strand the subtree, and the columns are simply
        // absent from this statement so it cannot happen by accident.
        mentions.length ? JSON.stringify(mentions) : null,
        now,
        existing.id,
        session.userId,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO comments (id, tmdb_id, media_type, season, episode, author_id, body,
                               reaction, visibility, spoiler, lang, media_kind, media_provider,
                               media_id, media_url, media_w, media_h,
                               parent_id, in_reply_to_id, root_id, depth, mentions_json,
                               parent_archive_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        subject.tmdbId,
        subject.mediaType,
        subject.season,
        subject.episode,
        session.userId,
        body,
        reaction,
        visibility,
        spoiler,
        lang,
        media.kind,
        media.provider,
        media.id,
        media.url,
        media.w,
        media.h,
        parentId,
        inReplyToId,
        // A top-level comment's root is itself, so `root_id` is never null and no
        // read site needs a COALESCE. Migration 0044 backfills the same way.
        rootId ?? id,
        depth,
        mentions.length ? JSON.stringify(mentions) : null,
        // Null for everything that is not a reply into another app's thread, which is
        // every comment this product wrote before now.
        parentArchiveRaw || null,
        now,
        now,
      ),
    );

    // ⚠️ **Maintained, in the SAME batch as the insert.** A correlated count on
    // every page read would multiply the cost of the hottest query in the product.
    // In the batch so a reply and its count can never disagree.
    if (parentId) {
      statements.push(
        env.DB.prepare(`UPDATE comments SET reply_count = reply_count + 1 WHERE id = ?`).bind(parentId),
      );
    }
  }

  await env.DB.batch(statements);

  // ⚠️ **Only on a NEW comment.** Editing is allowed forever, so notifying on every
  // write would let one person re-notify all their friends by retyping a word — and
  // "Alex commented" arriving twice about the same comment is indistinguishable from
  // Alex commenting twice.
  if (!existing) {
    // ⚠️ A reply notifies the person answered, NOT the author's whole friend list.
    // "Alex commented" fanning out for every reply would turn one busy thread into
    // a notification storm, and the reply is already visible to anyone reading it.
    const task = parentId
      ? notifyReply(env, session.userId, id, inReplyToId ?? parentId, subject, notify)
      : notifyFriendsOfComment(env, session.userId, id, subject, notify);
    const p = task;
    if (ctx) ctx.waitUntil(p);
    else await p;
  }

  // ⚠️ **Queued, never sent inline.** The drain runs later, re-reads the row and
  // re-checks `mayMirror`, so an auto-hide, a suspension or a fast delete lands BEFORE
  // anything leaves. Posting stays optimistic from Room either way, so nothing about
  // the user's own view depends on this.
  //
  // Nothing happens at all unless COMMSUNI_MIRROR is "1" and the comment is public;
  // both are checked inside queueMirror, and both fail closed.
  {
    const mirror = (async () => {
      const ref = await resolveReference(
        env as any,
        subject.mediaType as any,
        subject.tmdbId,
        subject.season,
        subject.episode,
        Number(new URL(req.url).searchParams.get("tvdbId")) || null,
      );
      if (!ref) return; // No TVDB id ⇒ no addressable conversation. Not an error.
      await queueMirror(
        env as any,
        {
          id: existing?.id ?? id,
          author_id: session.userId,
          visibility,
          body,
          lang,
          spoiler: spoiler ? 1 : 0,
          updated_at: now,
        },
        refPath(ref),
        // ⚠️ This is what makes the reply publisher reachable. `queueMirror` has always
        // chosen `kind = "reply"` when handed a parent archive id, and `publishComment`
        // has always posted those to `/comments/{parentArchiveId}/replies` — but the one
        // call site never passed it, so both were unreachable from the moment they were
        // written. Nothing else changes: a top-level comment still queues as "comment".
        parentArchiveRaw ? { parentArchiveId: parentArchiveRaw } : {},
      );
    })().catch(() => {});
    // ⚠️ `const p = f(); ctx.waitUntil(p)`, never `ctx?.waitUntil(f())` — optional
    // chaining short-circuits the whole expression INCLUDING its argument, so the
    // function is never called at all.
    if (ctx) ctx.waitUntil(mirror);
    else await mirror;
  }

  return json({
    id: existing?.id ?? id,
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
    parentCommentId: parentId,
    inReplyToCommentId: inReplyToId,
    depth,
  });
}

/**
 * Tell the author's friends that they commented.
 *
 * Fan-out on **write** here, unlike the feed, and that asymmetry is deliberate: a
 * notification has to be *pushed* to be a notification, so there is no read-side
 * equivalent. It stays affordable because it is bounded by friend count (tens) and
 * fires once per comment rather than once per view.
 *
 * **Every accepted friend is notified regardless of visibility.** A friends-only
 * comment is readable by exactly this set, and a public one is readable by more —
 * so there is no visibility under which a friend may not open what they were told
 * about. Blocking needs no separate check either: `handleBlock` deletes the
 * friendship row, so a blocked user simply stops appearing in `accepted`.
 *
 * The display name rides the payload because the client cannot render "Alex
 * commented" from an opaque user id, and making each recipient look it up would
 * turn one push into one Worker request per friend.
 */
async function notifyFriendsOfComment(
  env: CommentsEnv,
  authorId: string,
  commentId: string,
  subject: Subject,
  notify?: CommentNotifier,
): Promise<void> {
  if (!notify) return;

  const { accepted } = await loadFriendships(env as any, authorId);
  if (accepted.length === 0) return;

  const profile = await env.DB.prepare("SELECT display_name FROM profiles WHERE user_id = ?")
    .bind(authorId)
    .first<{ display_name: string | null }>();

  const data = {
    kind: "friend_comment",
    commentId,
    authorId,
    authorName: profile?.display_name ?? "",
    tmdbId: String(subject.tmdbId),
    mediaType: subject.mediaType,
    season: String(subject.season),
    episode: String(subject.episode),
  };
  // Bounded so one account with an enormous friend list cannot turn a single
  // comment into an unbounded fan-out inside one request.
  for (const friendId of accepted.slice(0, MAX_COMMENT_NOTIFY_FANOUT)) notify(friendId, data);
}

/**
 * `DELETE /api/comments/{id}` — remove the caller's own comment.
 *
 * **Retention is now conditional on there being something to retain it FOR.**
 *
 * The body used to be kept on every delete, for moderation history. That is only
 * load-bearing when the comment was reported: `handleReportComment` snapshots the text
 * into `reports.body_snapshot` at report time, and the two moderation surfaces that
 * read `comments.body` (the queue and the admin panel) are both driven by a join on
 * `reports`. With no report row, the retained text was read by nothing and simply sat
 * there — an author asked for it to be gone and it was not.
 *
 * So:
 *
 *  - **reported** — unchanged. The row and its body stay, and the admin panel keeps
 *    rendering the snapshot beside the current text, whose divergence is its own
 *    signal.
 *  - **not reported, no replies** — the row is DELETED. Nothing anchors to it and
 *    nothing may read it.
 *  - **not reported, with replies** — the row survives as the thread's anchor, with
 *    body, media and reaction stripped. A tombstone renders none of it anyway
 *    (`toWire`), so this only removes what was invisible and unread.
 *
 * ⚠️ Any report state counts, not just `open`. A dismissed report is a decision that
 * was made about this text, and the panel still shows it.
 *
 * Reaction rows and their counts go for real: they are other people's rows about a
 * comment that no longer renders, so keeping them would leak the comment's
 * existence through the reaction counts of a subject.
 */
export async function handleDeleteComment(
  id: string,
  req: Request,
  env: CommentsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  // Shares the write budget with POST deliberately: delete-then-repost on the same
  // subject is an edit, and an edit is free under the hourly cap, so without this
  // the pair is an uncapped write loop.
  if (await burstLimited(env, req, session.userId)) {
    await recordStrike(env, ctx, session.userId, "comment_write");
    return rateLimitedBody();
  }

  const row = await env.DB.prepare(
    `SELECT id, tmdb_id, media_type, season, episode, visibility, hidden_at, deleted_at, body, media_id,
            parent_id, reply_count
       FROM comments WHERE id = ? AND author_id = ?`,
  )
    .bind(id, session.userId)
    .first<CommentRow>();
  // 204 even for an unknown id, so this cannot be used to probe which ids exist.
  if (!row) return noContent();

  // Is there a moderation record that the text belongs to? Any state — see above.
  const reported = await env.DB
    .prepare("SELECT 1 AS n FROM reports WHERE target_id = ? LIMIT 1")
    .bind(id)
    .first<{ n: number }>()
    .catch(() => ({ n: 1 })); // On a read failure, keep it. Losing evidence is worse.

  const keepsThread = (row.reply_count ?? 0) > 0;
  const statements: D1PreparedStatement[] = [];

  if (reported) {
    statements.push(
      env.DB.prepare("UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ? AND author_id = ?").bind(
        Date.now(),
        Date.now(),
        id,
        session.userId,
      ),
    );
  } else if (keepsThread) {
    // The row is the thread's anchor and has to survive; its content does not.
    statements.push(
      env.DB
        .prepare(
          `UPDATE comments
              SET deleted_at = ?, updated_at = ?, body = '', reaction = NULL,
                  media_kind = NULL, media_provider = NULL, media_id = NULL, media_url = NULL,
                  media_w = NULL, media_h = NULL, mentions_json = NULL, lang = NULL
            WHERE id = ? AND author_id = ?`,
        )
        .bind(Date.now(), Date.now(), id, session.userId),
    );
  } else {
    statements.push(
      env.DB.prepare("DELETE FROM comments WHERE id = ? AND author_id = ?").bind(id, session.userId),
    );
  }

  statements.push(env.DB.prepare("DELETE FROM comment_reactions WHERE comment_id = ?").bind(id));

  // ⚠️ Deleting a REPLY decrements its parent's maintained count. Without this the
  // parent advertises replies that no longer render, and the badge stops matching
  // the thread — the same class of drift the renderable predicate warns about.
  // Floored at zero so a double-delete can never drive it negative.
  if (row.parent_id) {
    statements.push(
      env.DB
        .prepare("UPDATE comments SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?")
        .bind(row.parent_id),
    );
  }

  // ⚠️ A deleted PARENT is a tombstone, never a cascade. Its replies are other
  // people's words and deleting them would be deleting content their authors never
  // asked to remove — so the row survives (`deleted_at`, not DELETE) and the reads
  // render the minimal tombstone the archive uses: no old text, no media, no author
  // actions. `reply_count` is deliberately left alone; it is what tells the client
  // to draw a tombstone rather than omit the row entirely.
  //
  // ⚠️ This is why `keepsThread` above chooses UPDATE over DELETE, and it is the one
  // case where an unreported comment leaves anything behind at all. What survives is
  // the anchor, not the comment: the body and media are blanked in the same statement.

  await env.DB.batch(statements);

  // ⚠️ **Delete must propagate.** Without this the user deletes in Flickto and the text
  // stays live in every other partner app for ever — a policy failure, not a bug. Runs
  // even when the mirror is switched OFF: rows published while it was on must still be
  // retractable afterwards.
  {
    // ⚠️ Drained in THIS request, not left for the next reader. The published policy
    // says a deleted comment is retracted upstream "usually within minutes", and the
    // read-path drain alone cannot promise that: on a quiet app nobody opens a sheet
    // and the retraction sits queued indefinitely. Publishing may wait; removal may not.
    //
    // Draining here is safe in a way draining on POST would not be. The delay before a
    // publish exists so an auto-hide, a suspension or a fast delete can land first;
    // there is no equivalent concern for taking something down.
    const teardown = queueUnmirror(env as any, id)
      .then(() => drainArchiveOutbox(env as any))
      .catch(() => 0);
    if (ctx) ctx.waitUntil(teardown);
    else await teardown;
  }

  return noContent();
}

// ── Reacting ────────────────────────────────────────────────────────────────

/**
 * `POST /api/comments/{id}/reaction` `{ emoji }` — set or change the caller's
 * reaction. `DELETE` on the same path removes it.
 *
 * One reaction per user per comment, changeable, which is why the PK is
 * `(comment_id, user_id)` and a change overwrites the row rather than adding a
 * second one. Counts are not stored — they are derived on read from these rows
 * (see [loadReactionCounts]), so a reaction is a single row write and nothing more.
 *
 * You may only react to a comment you may read — otherwise reacting becomes an
 * oracle for the existence and id of friends-only comments.
 */
export async function handleReactToComment(
  id: string,
  req: Request,
  env: CommentsEnv,
  ctx?: ExecutionContext,
  notify?: CommentNotifier,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  // Adding a reaction is posting: it puts your name on someone else's comment and
  // can notify its author. Removing one is not gated — withdrawing is always
  // allowed, and refusing it would strand a reaction a suspended user regrets.
  if (req.method !== "DELETE") {
    const suspendedUntil = await postingSuspendedUntil(env.DB, session.userId);
    if (suspendedUntil > 0) return json(suspendedBody(suspendedUntil), 403);
  }

  const removing = req.method === "DELETE";
  let emoji = "";
  if (!removing) {
    let payload: Record<string, unknown>;
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    emoji = typeof payload.emoji === "string" ? payload.emoji : "";
    if (!REACTIONS.has(emoji)) return json({ error: "invalid_payload" }, 400);
  }

  const comment = await env.DB.prepare(
    "SELECT id, author_id, visibility, hidden_at, deleted_at FROM comments WHERE id = ?",
  )
    .bind(id)
    .first<CommentRow>();
  // Identical answer for "does not exist" and "you may not see it": any other
  // behaviour makes this endpoint a probe for which comments exist.
  if (!comment || !(await mayReadComment(env, session.userId, comment))) return notFound();

  const mine = await env.DB.prepare("SELECT emoji FROM comment_reactions WHERE comment_id = ? AND user_id = ?")
    .bind(id, session.userId)
    .first<{ emoji: string }>();
  if (mine?.emoji === emoji) return noContent(); // idempotent re-tap

  const statements: D1PreparedStatement[] = [];
  if (removing) {
    statements.push(
      env.DB.prepare("DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ?").bind(id, session.userId),
    );
  } else {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(comment_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
        )
        .bind(id, session.userId, emoji, Date.now()),
    );
  }
  await env.DB.batch(statements);

  // Removing a reaction never notifies: "someone un-reacted" is not news, and it
  // would double the volume of the noisiest event in the app.
  if (!removing) ctx?.waitUntil(notifyReaction(env, comment, session.userId, notify));
  return noContent();
}

/**
 * Tell the author that people are reacting — **bundled, cooled down, and anonymous**.
 *
 * This is the one notification a *stranger* can trigger, so its volume is
 * attacker-controllable by definition and every guard below is load-bearing:
 *
 * - **never notify yourself** — reacting to your own comment is not news;
 * - **never notify across a block**, checked in both directions;
 * - **one push per [REACTION_NOTIFY_COOLDOWN_MS]**, carrying the *current total*
 *   rather than one push per reaction. A comment that does well can draw hundreds;
 * - **the reactors are not named.** Reaction display is counts-only, so naming them
 *   would be inconsistent *and* would expose non-friend identities that stay hidden
 *   everywhere else in the app;
 * - the payload carries the count, so the client composes the notification with **no
 *   sync round trip**. Otherwise every reaction would cost the *recipient* a Worker
 *   request, which is the exact cost model this whole feature is shaped around.
 *
 * `last_notified_at` is claimed with a **conditional UPDATE**, never a read-then-write:
 * two reactions landing together would both see a stale timestamp and both notify.
 * `meta.changes === 0` means another request won the race, and this one stays quiet.
 */
/**
 * Tell the person who was answered that someone replied.
 *
 * ⚠️ **Reuses the reaction machinery deliberately, never a fresh mechanism**: the
 * 15-minute cooldown, and above all the **conditional UPDATE** that claims
 * `last_notified_at` — read-then-write would let two concurrent replies both see a
 * stale timestamp and both notify. `meta.changes` is the claim; losing it means
 * another request already sent one.
 *
 * The target is `in_reply_to_id` — who the user actually answered — not
 * `parent_id`, which is merely where the row is placed. On a flattened depth-2
 * reply those differ, and notifying the thread's parent instead of the person
 * addressed is the whole reason both columns exist.
 *
 * Never to yourself, and never across a block, exactly as reactions.
 */
async function notifyReply(
  env: CommentsEnv,
  authorId: string,
  replyId: string,
  targetCommentId: string,
  s: Subject,
  notify?: CommentNotifier,
): Promise<void> {
  if (!notify) return;

  const target = await env.DB.prepare(
    `SELECT id, author_id, last_notified_at FROM comments WHERE id = ?`,
  )
    .bind(targetCommentId)
    .first<{ id: string; author_id: string; last_notified_at: number }>();
  if (!target) return;
  if (target.author_id === authorId) return;
  if (await isBlockedEitherWay(env as any, authorId, target.author_id)) return;

  const now = Date.now();
  const claimed = await env.DB.prepare(
    "UPDATE comments SET last_notified_at = ? WHERE id = ? AND last_notified_at < ?",
  )
    .bind(now, target.id, now - REACTION_NOTIFY_COOLDOWN_MS)
    .run();
  if (!claimed.meta?.changes) return;

  const profile = await env.DB.prepare("SELECT display_name FROM profiles WHERE user_id = ?")
    .bind(authorId)
    .first<{ display_name: string | null }>();

  notify(target.author_id, {
    kind: "comment_reply",
    commentId: replyId,
    parentCommentId: target.id,
    // The client cannot render "Alex replied" from an opaque id, and making the
    // recipient look it up would turn one push into a second request.
    authorName: profile?.display_name ?? "",
    tmdbId: String(s.tmdbId),
    mediaType: s.mediaType,
    season: String(s.season),
    episode: String(s.episode),
  });
}

async function notifyReaction(
  env: CommentsEnv,
  comment: CommentRow,
  reactorId: string,
  notify?: CommentNotifier,
): Promise<void> {
  if (!notify) return;
  if (comment.author_id === reactorId) return;
  if (await isBlockedEitherWay(env as any, reactorId, comment.author_id)) return;

  const now = Date.now();
  const claimed = await env.DB.prepare(
    "UPDATE comments SET last_notified_at = ? WHERE id = ? AND last_notified_at < ?",
  )
    .bind(now, comment.id, now - REACTION_NOTIFY_COOLDOWN_MS)
    .run();
  if (!claimed.meta?.changes) return;

  const tally = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM comment_reactions WHERE comment_id = ?",
  )
    .bind(comment.id)
    .first<{ n: number }>();

  notify(comment.author_id, {
    kind: "comment_reaction",
    commentId: comment.id,
    tmdbId: String(comment.tmdb_id),
    mediaType: comment.media_type,
    season: String(comment.season),
    episode: String(comment.episode),
    count: String(tally?.n ?? 1),
  });
}

// ── Reporting ───────────────────────────────────────────────────────────────

/**
 * The two report kinds a comment can attract, and the reason they are two.
 *
 * ⚠️ **Spoiler reports must NOT count toward `REPORT_AUTOHIDE`.** If they did,
 * "report as spoiler" becomes a censorship lever: three people who dislike an
 * opinion tag it and it vanishes. So the counts are kept entirely separate by
 * `kind` — abuse reports hide, spoiler reports blur.
 */
const KIND_ABUSE = "comment";
const KIND_SPOILER = "comment_spoiler";

/**
 * **Threshold 2, not 3.** A spoiler is a mislabelling rather than a rules
 * violation: the comment is fine, its state is wrong. The consequence is mild and
 * reversible, so acting sooner is cheap.
 */
const SPOILER_AUTOFLAG = 2;
const DEFAULT_REPORT_AUTOHIDE = 3;
const MAX_REPORT_CONTEXT = 1000;
const REPORT_REASONS = new Set(["spoiler", "abuse", "harassment", "hate", "sexual", "spam", "other"]);

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

/**
 * `POST /api/comments/{id}/report` `{ reason, context? }`.
 *
 * `reason: "spoiler"` blurs at [SPOILER_AUTOFLAG] distinct open reports; every
 * other reason hides at `REPORT_AUTOHIDE`. The two never mix — see above.
 *
 * ⚠️ **The body is snapshotted into the report row.** Editing is allowed forever,
 * so an author can rewrite a comment after it is flagged; without the snapshot the
 * admin decides on text that is no longer what was reported. The live row is kept
 * too: when the two diverge, that divergence is itself a signal, because editing
 * straight after a report is usually damage control.
 *
 * **Auto-hide is provisional, never terminal.** It hides *pending review* and an
 * admin can restore. Without that the threshold is a brigading tool — three
 * coordinated accounts could silently delete anyone's comment permanently.
 */
export async function handleReportComment(
  id: string,
  req: Request,
  env: CommentsEnv & { REPORT_AUTOHIDE?: string },
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  // ⚠️ **A suspended user may still REPORT.** This used to return 403, reasoning that
  // leaving reporting open made suspension "a promotion" — you lose your voice but keep
  // the censorship lever. §10 of the partner guide overrules that, and its reasoning is
  // the better one: "if that user can still view comments, they must still be able to
  // report abuse". Reporting is not publishing. Someone who can see abuse and is barred
  // from flagging it is a safety hole, and the suspension already stops them writing.
  //
  // The brigading worry the old code had is answered elsewhere: REPORT_AUTOHIDE needs
  // distinct reporters, one report per reporter per target is enforced below, and an
  // auto-hide is provisional and reversible by a moderator.

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  if (!REPORT_REASONS.has(reason)) return json({ error: "invalid_payload" }, 400);
  const note = typeof payload.context === "string" ? payload.context.trim().slice(0, MAX_REPORT_CONTEXT) : "";
  const context = note ? `${reason} — ${note}` : reason;
  const kind = reason === "spoiler" ? KIND_SPOILER : KIND_ABUSE;

  const comment = await env.DB.prepare(
    `SELECT id, tmdb_id, media_type, season, episode, author_id, body, visibility,
            spoiler, hidden_at, deleted_at, media_id
       FROM comments WHERE id = ?`,
  )
    .bind(id)
    .first<CommentRow>();
  if (!comment || !(await mayReadComment(env, session.userId, comment))) return notFound();
  // Reporting your own comment is a no-op that would otherwise let an author
  // self-brigade to a hidden state and blame the system.
  if (comment.author_id === session.userId) return noContent();

  // One open report per reporter per target **per kind**: the two thresholds are
  // independent, so someone who flagged a spoiler must still be able to report
  // abuse on the same comment.
  const existing = await env.DB.prepare(
    "SELECT id FROM reports WHERE reporter_id = ? AND target_id = ? AND kind = ? AND state = 'open'",
  )
    .bind(session.userId, id, kind)
    .first<{ id: string }>();
  if (existing) return noContent();

  await env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, target_id, kind, context, state, created_at, body_snapshot)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(newId(), session.userId, id, kind, context, Date.now(), comment.body)
    .run();

  // ⚠️ **Only `open` reports count.** Dismissing marks them `dismissed`, so a
  // restored comment needs a fresh set rather than being re-tripped by the next
  // single report — which would let one person overturn a moderator.
  const tally = await env.DB.prepare(
    "SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_id = ? AND kind = ? AND state = 'open'",
  )
    .bind(id, kind)
    .first<{ n: number }>();
  const n = tally?.n ?? 0;

  if (kind === KIND_SPOILER) {
    // A spoiler report BLURS, it does not hide: the action is `spoiler`, never
    // `hidden_at`. Once community-flagged only an admin can clear it — otherwise
    // the author simply unticks it.
    if (n >= SPOILER_AUTOFLAG && comment.spoiler !== 1) {
      await env.DB.prepare("UPDATE comments SET spoiler = 1 WHERE id = ?").bind(id).run();
    }
    return noContent();
  }

  const threshold = Number(env.REPORT_AUTOHIDE ?? DEFAULT_REPORT_AUTOHIDE);
  if (n >= threshold && comment.hidden_at == null) {
    await setHidden(env, comment, true);
  }
  return noContent();
}

/**
 * Hide or restore a comment.
 *
 * Shared by the auto-hide threshold and the admin action so the two paths cannot
 * diverge.
 */
export async function setHidden(env: CommentsEnv, row: CommentRow, hidden: boolean): Promise<void> {
  await env.DB.prepare("UPDATE comments SET hidden_at = ? WHERE id = ?")
    .bind(hidden ? Date.now() : null, row.id)
    .run();
}

/**
 * Whether [viewerId] may read [authorId]'s friends-only comment.
 *
 * Exported for the notification and permalink paths, which resolve a single
 * comment rather than a page and therefore cannot lean on the `IN` list above.
 * Blocks are checked **first and bidirectionally**, the same rule `canView`
 * already applies to profiles.
 */
export async function mayReadComment(env: CommentsEnv, viewerId: string, row: CommentRow): Promise<boolean> {
  if (row.hidden_at != null || row.deleted_at != null) return false;
  if (row.author_id === viewerId) return true;
  if (await isBlockedEitherWay(env as any, viewerId, row.author_id)) return false;
  if (row.visibility === "public") return true;
  return areFriends(env as any, viewerId, row.author_id);
}

// ⚠️ `countable` was removed from this list, not restored. Commit 00bf213 ("derive
// comment/reaction/poll counts on read, drop counter tables") deleted the function and
// every call site but left it named here, so the module exported a binding that does
// not exist. Nothing imports it.
//
// It survived because `tsc` is permanently red in this worker, so one more error read
// as noise — the same way the moderationQueue target-union mismatch reached production.
// esbuild does not resolve names at bundle time, so an unknown identifier becomes a
// runtime global lookup rather than a build failure; that is exactly how the missing
// `loadArchiveReplies` import threw in production earlier.
export { USER_ID_RE, COMMENT_ID_RE, toWire };
