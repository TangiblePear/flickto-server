/**
 * The archive read path: fetch → dedup → render.
 *
 * Everything here is best-effort. §7: a failed archive call **hides the archive
 * section**, it does not break the screen — the native comments beside it are already
 * in Room and must render regardless.
 */

import {
  actorId,
  commsuniCall,
  commsuniEnabled,
  foreignSlugs,
  loadSources,
  type CommsuniEnv,
  type CommsuniSource,
} from "./commsuni";
import { refPath, resolveReference, type MediaType } from "./commsuniEntities";

/** How long a "nothing archived here" answer is trusted. */
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

/** Matches PAGE_LIMIT so the merged list is not lopsided against the native half. */
export const ARCHIVE_PAGE_LIMIT = 20;

/**
 * One page of archive replies.
 *
 * ⚠️ **10, down from 25, because archive replies are now translated too.** The 25 was
 * justified by their being the one page that cost no AI calls; once a reply can spend a
 * model call the same arithmetic that sizes the native REPLY_PAGE_LIMIT applies here,
 * and this route pays it twice — the partner's replies through `translateArchiveRows`
 * and ours through `loadNativeArchiveReplies`. Leaving it at 25 put a busy thread's
 * first read in a new language at ~38 subrequests against a cap of 50, for pages the
 * cursor fetches on demand anyway.
 */
const ARCHIVE_REPLY_LIMIT = 10;

/**
 * The archive half of a comments response, or null.
 *
 * ⚠️ **null is a first-class answer, not an error.** It means "no archive section" —
 * the title is not archived, upstream is down, the breaker is open, or we hold no
 * TVDB id. The client renders the native half unchanged in every one of those cases,
 * so they deliberately do not need to be distinguishable.
 */
export interface ArchivePage {
  comments: unknown[];
  cursor: string | null;
  complete: boolean;
  /**
   * Branding for the slugs on this page, so the client can render a source badge.
   *
   * ⚠️ Supplied by the server because **the client has no API key** and must never
   * have one — it cannot call `GET /v1/sources` itself. Sending it per response also
   * means a partner that rebrands is reflected within our catalog TTL, which is the
   * whole reason §5 forbids hard-coding icons.
   *
   * Filtered to the slugs actually present, not the whole catalogue: 13 partners and
   * growing, and a page typically carries two or three.
   */
  sources: CommsuniSource[];
  /**
   * The two platform rows, for the mandatory attribution banner.
   *
   * ⚠️ Sent SEPARATELY from [sources] rather than by widening it, because they answer
   * different questions. `sources` is "who wrote on this page" and is correctly empty
   * when nothing here is foreign; the banner must appear on **any** commsuni-backed
   * surface whether or not a partner happens to have commented on this title, so a
   * banner built from `sources` would vanish exactly where attribution is still owed.
   *
   * §9 fixes the identity: the catalog is ordered by `source_id`, and rows 1 and 2 are
   * TV Community Archive and `commsunitv`. Order is preserved from upstream, and the
   * slug check below is the belt to that braces — position alone would silently attribute
   * the wrong brand if the catalog were ever reordered.
   */
  platforms: CommsuniSource[];
}

/**
 * The two platform catalog entries, in `source_id` order.
 *
 * Returns [] when the catalog is unavailable or does not contain `commsunitv`, and the
 * client then renders no banner rather than a half-built one — a banner missing an icon
 * looks broken, and attribution that shows the wrong mark is worse than one that waits
 * for the next request.
 */
export function platformSources(sources: CommsuniSource[]): CommsuniSource[] {
  const first = sources.slice(0, 2);
  return first.some((s) => s.slug?.toLowerCase() === "commsunitv") ? first : [];
}

// ── Negative cache ──────────────────────────────────────────────────────────

/**
 * Has this reference recently answered "not archived"?
 *
 * ⚠️ A hit must return before any upstream call is made. Fetching and then rendering
 * empty produces the same screen and pays the `read_unit` anyway, which is precisely
 * the cost this exists to avoid.
 */
async function isKnownMiss(env: CommsuniEnv, ref: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT expires_at FROM archive_misses WHERE entity_ref = ?")
    .bind(ref)
    .first<{ expires_at: number }>()
    .catch(() => null);
  return !!row && row.expires_at > Date.now();
}

async function rememberMiss(env: CommsuniEnv, ref: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO archive_misses (entity_ref, checked_at, expires_at) VALUES (?,?,?)",
  )
    .bind(ref, now, now + MISS_TTL_MS)
    .run()
    .catch(() => {});
}

/**
 * Drop the miss for a reference.
 *
 * Phase 2 calls this the moment one of our users writes there: the entity now exists,
 * and leaving the miss cached would hide the user's own comment from the archive
 * section for up to [MISS_TTL_MS].
 */
export async function clearMiss(env: CommsuniEnv, ref: string): Promise<void> {
  await env.DB.prepare("DELETE FROM archive_misses WHERE entity_ref = ?").bind(ref).run().catch(() => {});
}

/**
 * One page of replies under an archive comment.
 *
 * ⚠️ **A separate route from the native one, not a widened one.** Archive ids are
 * UUIDs and match neither `COMMENT_ID_RE` (`[0-9A-Z:]{8,80}`) nor anything in our
 * `comments` table, so `/api/comments/{id}/replies` cannot serve them — it looks the
 * parent up locally and finds nothing. That is exactly what made expanding an archive
 * thread do nothing at all.
 *
 * Session-gated like every other archive read (§1), which is also what makes the actor
 * header available so the page comes back viewer-aware.
 */
export async function loadArchiveReplies(
  env: CommsuniEnv,
  commentId: string,
  userId: string,
  cursor?: string | null,
): Promise<{ comments: unknown[]; cursor: string | null; complete: boolean } | null> {
  if (!commsuniEnabled(env)) return null;

  const actor = await actorId(env, userId);
  const params = new URLSearchParams({ limit: String(ARCHIVE_REPLY_LIMIT) });
  if (cursor) params.set("cursor", cursor);

  const res = await commsuniCall<{
    replies?: unknown[];
    nextCursor?: string | null;
    complete?: boolean;
  }>(env, `/comments/${encodeURIComponent(commentId)}/replies?${params.toString()}`, { actor });

  console.log(
    JSON.stringify({
      msg: "commsuni archive replies",
      id: commentId,
      ok: res.ok,
      status: res.status ?? null,
      code: res.code ?? null,
      replies: Array.isArray(res.data?.replies) ? res.data!.replies!.length : null,
    }),
  );

  if (!res.ok) return null;
  const replies = Array.isArray(res.data?.replies) ? res.data!.replies! : [];
  return {
    // ⚠️ **Our own mirrored replies stripped.** The page read excludes our slug upstream
    // (`source=` on the entity call) precisely so a mirrored row does not come back and
    // render twice; this call has no such filter, and until replies could be mirrored
    // there was nothing for it to catch. The moment one was published, the author saw
    // their reply twice — once as the native row they can edit and delete, and once as
    // a foreign row under the PARTNER's badge that they could only report.
    //
    // Filtered here against our own ledger rather than by asking upstream, because
    // `archive_comment_refs` is authoritative about what we published and needs no
    // support from the partner's reply endpoint.
    comments: await withoutOurs(env, replies),
    // ⚠️ `nextCursor`, not `cursor` — the reply payload names it differently from the
    // comment list, and reading the wrong field silently ends pagination at page one.
    cursor: res.data?.nextCursor ?? null,
    complete: res.data?.complete ?? true,
  };
}

/**
 * Drop rows we published ourselves.
 *
 * `archive_comment_refs` maps our comment id to the archive id it was mirrored as, with
 * a unique index on the archive id — so this is one indexed lookup for the page. An
 * empty ledger (mirror never enabled) short-circuits to no query at all.
 */
async function withoutOurs(env: CommsuniEnv, rows: unknown[]): Promise<unknown[]> {
  const ids = rows.map((r) => (r as { id?: string })?.id ?? "").filter(Boolean);
  if (ids.length === 0) return rows;

  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT archive_id FROM archive_comment_refs WHERE archive_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ archive_id: string }>()
    .catch(() => ({ results: [] as Array<{ archive_id: string }> }));

  const ours = new Set((results ?? []).map((r) => r.archive_id));
  if (ours.size === 0) return rows;
  return rows.filter((r) => !ours.has((r as { id?: string })?.id ?? ""));
}

/**
 * Remember how many comments an entity had, for the collapsed-header signal.
 *
 * ⚠️ `DO UPDATE ... WHERE count IS DISTINCT` — the write is skipped when nothing
 * changed. Every sheet open reaches this, and the value is stable for most entities, so
 * an unconditional upsert would bill a row written per open to store what was already
 * there. `seen_at` moves only when the count does; it records when the value last
 * CHANGED, which is the more useful fact and the reason this is not `DO UPDATE SET
 * seen_at = ...` unconditionally.
 */
async function rememberCount(
  env: CommsuniEnv,
  entityRef: string,
  count: number,
  complete: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO archive_counts (entity_ref, count, complete, seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_ref) DO UPDATE
       SET count = excluded.count, complete = excluded.complete, seen_at = excluded.seen_at
     WHERE archive_counts.count <> excluded.count OR archive_counts.complete <> excluded.complete`,
  )
    .bind(entityRef, count, complete ? 1 : 0, Date.now())
    .run()
    .catch(() => {});
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** Our reasons. Kept verbatim in `reports.context` so the admin sees what was picked. */
const OUR_REASONS = new Set(["spoiler", "abuse", "harassment", "hate", "sexual", "spam", "other"]);

/**
 * Ours → the archive's smaller set.
 *
 * ⚠️ Lossy on purpose, and the loss is recorded rather than discarded: `harassment` and
 * `hate` both become `abuse` upstream because the archive has no finer bucket, but the
 * user's ORIGINAL choice is stored in `reports.context` so our moderator sees what they
 * actually reported. Mapping without keeping the original would silently coarsen every
 * report in our own queue too.
 */
const REASON_UPSTREAM: Record<string, string> = {
  spoiler: "spoiler",
  abuse: "abuse",
  harassment: "abuse",
  hate: "abuse",
  sexual: "sexual",
  spam: "spam",
  other: "other",
};

export const KIND_ARCHIVE_ABUSE = "archive_comment";
export const KIND_ARCHIVE_SPOILER = "archive_comment_spoiler";

const MAX_REPORT_CONTEXT = 1000;
const DEFAULT_REPORT_AUTOHIDE = 3;

/** Is this archive comment hidden product-wide? Read on every archive page. */
export async function loadSuppressed(env: CommsuniEnv, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT archive_id FROM archive_suppressed WHERE archive_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ archive_id: string }>()
    .catch(() => ({ results: [] as { archive_id: string }[] }));
  return new Set((results ?? []).map((r) => r.archive_id));
}

/**
 * Report an archive comment: into OUR queue, and forwarded upstream.
 *
 * ⚠️ **Both, not either.** We cannot hide a comment inside another partner's app, and
 * the operator cannot know our auto-hide threshold — so a report that only went one way
 * would leave one of those jobs undone. Requirement 1 of the integration.
 *
 * ⚠️ A separate route from the native one. Archive ids are UUIDs and match neither
 * `COMMENT_ID_RE` (`[0-9A-Z:]{8,80}`) nor anything in our `comments` table.
 */
export async function handleReportArchiveComment(
  archiveId: string,
  reason: string,
  note: string,
  userId: string,
  env: CommsuniEnv & { REPORT_AUTOHIDE?: string },
  ctx?: ExecutionContext,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!OUR_REASONS.has(reason)) return { status: 400, body: { error: "invalid_payload" } };

  const kind = reason === "spoiler" ? KIND_ARCHIVE_SPOILER : KIND_ARCHIVE_ABUSE;
  const context = note ? `${reason} — ${note.slice(0, MAX_REPORT_CONTEXT)}` : reason;

  // One OPEN report per reporter per target per kind, exactly as the native path. The
  // two thresholds are independent, so a spoiler flag must not consume the abuse one.
  const existing = await env.DB.prepare(
    "SELECT id FROM reports WHERE reporter_id = ? AND target_id = ? AND kind = ? AND state = 'open'",
  )
    .bind(userId, archiveId, kind)
    .first<{ id: string }>();
  if (existing) return { status: 204, body: {} };

  /**
   * ⚠️ **Snapshot the body SERVER-side, never from the client.**
   *
   * A reporter must not control what the moderator reads — otherwise the report itself
   * becomes an injection vector into our admin panel. §10 endorses taking it from our
   * own short-lived cache, which is both free and *more* correct: it is the text the
   * reporter actually saw, not whatever the comment says by the time we look.
   *
   * The single-comment read is the fallback and costs one `read_unit`.
   */
  const snapshot = await commsuniCall<{
    text?: string;
    userId?: string;
    userName?: string;
    origin?: { slug?: string; displayName?: string };
  }>(env, `/comments/${encodeURIComponent(archiveId)}`, { actor: await actorId(env, userId) });

  const body = snapshot.data?.text ?? "";
  const origin = snapshot.data?.origin?.slug ?? "";

  await env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, target_id, kind, context, state, created_at, body_snapshot)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      archiveId,
      kind,
      // The origin rides the context so the admin panel can tell whose comment this is
      // without a join it cannot make — `LEFT JOIN comments` matches nothing for a UUID.
      origin ? `${context} [${origin}]` : context,
      Date.now(),
      body,
    )
    .run();

  // Forward upstream. Fire-and-forget against the response, but never dropped: a
  // transient failure lands in the outbox with the SAME key.
  const forward = forwardReport(env, archiveId, reason, userId);
  if (ctx) ctx.waitUntil(forward);
  else await forward;

  // ⚠️ Only OPEN reports count. Dismissing marks them `dismissed`, so a restored
  // comment needs a fresh set rather than being re-tripped by the next single report —
  // which would let one person overturn a moderator.
  const tally = await env.DB.prepare(
    "SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_id = ? AND kind = ? AND state = 'open'",
  )
    .bind(archiveId, kind)
    .first<{ n: number }>();
  const n = tally?.n ?? 0;

  // ⚠️ Abuse only. A spoiler report BLURS upstream content we cannot edit, so there is
  // nothing local to do beyond the per-reader hide the client already applies —
  // suppressing the whole row for everyone would be a censorship lever dressed as a
  // spoiler flag.
  if (kind === KIND_ARCHIVE_ABUSE) {
    const threshold = Number(env.REPORT_AUTOHIDE ?? DEFAULT_REPORT_AUTOHIDE);
    if (n >= threshold) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO archive_suppressed (archive_id, hidden_at, reason) VALUES (?,?,?)",
      )
        .bind(archiveId, Date.now(), "auto:reports")
        .run()
        .catch(() => {});
    }
  }

  return { status: 204, body: {} };
}

/**
 * `POST /v1/comments/{id}/reports`, with the outbox behind it.
 *
 * ⚠️ **Read `Report-Duplicate`.** A bare 202 is not proof the report landed — the
 * operator may have dropped it as a duplicate of one this user filed months ago. The
 * verdict is stored on the report row so a user can be told, rather than silently
 * believing a claim was queued.
 *
 * ⚠️ The idempotency key is derived from (reporter, target, reason) so a retry REPLAYS
 * rather than filing again. A duplicate still costs a `write_unit` — quota is charged on
 * the request, not the outcome.
 */
async function forwardReport(
  env: CommsuniEnv,
  archiveId: string,
  reason: string,
  userId: string,
): Promise<void> {
  const upstreamReason = REASON_UPSTREAM[reason] ?? "other";
  const key = `report:${userId}:${archiveId}:${reason}`;
  const actor = await actorId(env, userId);

  const res = await commsuniCall(env, `/comments/${encodeURIComponent(archiveId)}/reports`, {
    method: "POST",
    body: { reason: upstreamReason },
    idempotencyKey: key,
    actor,
  });

  console.log(
    JSON.stringify({
      msg: "commsuni report forwarded",
      id: archiveId,
      ok: res.ok,
      status: res.status ?? null,
      code: res.code ?? null,
      duplicate: res.reportDuplicate ?? false,
    }),
  );

  if (res.ok) {
    if (res.reportDuplicate) {
      // Recorded so the user can be told their claim was not queued. An ownership
      // claim silently dropped because of an unrelated flag months earlier is exactly
      // the case the guide calls out.
      await env.DB.prepare(
        "UPDATE reports SET context = context || ' [upstream:duplicate]' WHERE target_id = ? AND reporter_id = ? AND state = 'open'",
      )
        .bind(archiveId, userId)
        .run()
        .catch(() => {});
    }
    return;
  }

  // ⚠️ Only TRANSIENT failures queue. A 4xx is a statement about the request and will
  // say the same thing forever, so retrying it burns write_units for nothing.
  const transient = res.code === "network" || res.code === "breaker_open" || (res.status ?? 0) >= 500 ||
    res.status === 429;
  if (!transient) return;

  await env.DB.prepare(
    `INSERT INTO archive_outbox (id, kind, idempotency_key, actor_user_id, payload, attempts, next_at, created_at)
     VALUES (?, 'report', ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      key,
      userId,
      JSON.stringify({ archiveId, reason: upstreamReason }),
      Date.now() + 60_000,
      Date.now(),
    )
    .run()
    .catch(() => {});
}

// ── Cross-app blocking (requirement 2) ──────────────────────────────────────

export interface ArchiveBlock {
  source_slug: string;
  author_id: string;
  display_name: string | null;
  author_color: string | null;
  created_at: number;
}

/**
 * One reader's blocked foreign authors.
 *
 * Loaded **once per request** and applied in memory. Bounded by how many people one
 * user has blocked, and indexed on `blocker_id`, so this is a single indexed read
 * rather than a per-row check.
 */
export async function loadArchiveBlocks(env: CommsuniEnv, userId: string): Promise<ArchiveBlock[]> {
  const { results } = await env.DB.prepare(
    `SELECT source_slug, author_id, display_name, author_color, created_at
       FROM archive_blocks WHERE blocker_id = ?`,
  )
    .bind(userId)
    .all<ArchiveBlock>()
    .catch(() => ({ results: [] as ArchiveBlock[] }));
  return results ?? [];
}

/** `{slug}\u0000{authorId}` — the key a comment is matched on. */
const blockKey = (slug: string, authorId: string): string => `${slug}\u0000${authorId}`;

/**
 * Drop comments (and their inline replies) written by a blocked author.
 *
 * ⚠️ Matched on `(origin.slug, userId)`, never on `userId` alone. The archive's author
 * ids are opaque and scoped to their source — the same string from two partners is two
 * different people — so an unscoped match would block a stranger in another app.
 *
 * ⚠️ Replies are filtered too. A blocked author whose top-level comment vanished while
 * their replies stayed visible under someone else's is exactly the "I blocked them and
 * they are still here" failure the feature exists to prevent.
 */
export function filterBlocked<T>(comments: T[], blocks: ArchiveBlock[]): T[] {
  if (blocks.length === 0) return comments;
  const blocked = new Set(blocks.map((b) => blockKey(b.source_slug, b.author_id)));

  const isBlocked = (c: unknown): boolean => {
    const row = c as { origin?: { slug?: string }; userId?: string };
    return blocked.has(blockKey(row?.origin?.slug ?? "", row?.userId ?? ""));
  };

  return comments
    .filter((c) => !isBlocked(c))
    .map((c) => {
      const row = c as { replies?: unknown[] };
      if (!Array.isArray(row.replies) || row.replies.length === 0) return c;
      return { ...(c as object), replies: row.replies.filter((r) => !isBlocked(r)) } as T;
    });
}

/** Block a foreign author, snapshotting how they appeared at the time. */
export async function addArchiveBlock(
  env: CommsuniEnv,
  userId: string,
  slug: string,
  authorId: string,
  displayName: string | null,
  authorColor: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO archive_blocks
       (blocker_id, source_slug, author_id, display_name, author_color, created_at)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(userId, slug, authorId, displayName, authorColor, Date.now())
    .run();
}

export async function removeArchiveBlock(
  env: CommsuniEnv,
  userId: string,
  slug: string,
  authorId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM archive_blocks WHERE blocker_id = ? AND source_slug = ? AND author_id = ?",
  )
    .bind(userId, slug, authorId)
    .run();
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Fetch the archive page for a subject, for one reader.
 *
 * Ordering is deliberate and each step exists to avoid a specific cost:
 *
 *  1. **Configured / enabled** — nothing else runs if the key is absent.
 *  2. **Resolve the reference** — no TVDB id, no archive section, no call.
 *  3. **Negative cache** — the long tail of the catalogue never reaches the network.
 *  4. **Source filter** — every active slug EXCEPT ours, so dedup happens server-side
 *     rather than by fetching our own rows and discarding them.
 *  5. **Fetch**, with the actor header so the response carries viewer state.
 *
 * @param userId our `users.id`. The actor ID is derived from it here and never taken
 *   from anything the device sent.
 */
export async function loadArchivePage(
  env: CommsuniEnv,
  mediaType: MediaType,
  tmdbId: number,
  season: number,
  episode: number,
  userId: string,
  clientTvdbId?: number | null,
  cursor?: string | null,
): Promise<ArchivePage | null> {
  if (!commsuniEnabled(env)) return null;

  const ref = await resolveReference(env, mediaType, tmdbId, season, episode, clientTvdbId);
  if (!ref) return null;
  // `show/tvdb-121361` — both segments. The type is not optional; omitting it 404s.
  const path = refPath(ref);

  if (await isKnownMiss(env, path)) return null;

  // ⚠️ No slug list ⇒ do NOT fetch. Unfiltered means our own mirrored comments come
  // back and render twice beside the native rows they duplicate.
  const sources = await loadSources(env);
  const slugs = foreignSlugs(env, sources);
  if (!slugs) return null;

  const actor = await actorId(env, userId);
  const params = new URLSearchParams({
    source: slugs.join(","),
    limit: String(ARCHIVE_PAGE_LIMIT),
  });
  if (cursor) params.set("cursor", cursor);

  const res = await commsuniCall<{ comments?: unknown[]; nextCursor?: string | null; complete?: boolean }>(
    env,
    // ⚠️ Both segments, each encoded separately — encoding the joined path would turn
    // the `/` between type and id into `%2F` and 404 just as surely as omitting it.
    `/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}/comments?${params.toString()}`,
    { actor },
  );

  // ⚠️ Log EVERY outcome, not just the ones carrying RateLimit headers.
  //
  // A 404 has no such header, so the original logging was silent on exactly the case
  // that matters — and "no log line" was indistinguishable from "the read never ran".
  // That ambiguity cost a full debugging cycle: an empty archive, a malformed request
  // and a scope error all present as a blank section.
  console.log(
    JSON.stringify({
      msg: "commsuni archive read",
      ref: path,
      ok: res.ok,
      status: res.status ?? null,
      code: res.code ?? null,
      comments: Array.isArray(res.data?.comments) ? res.data!.comments!.length : null,
      // Whether a next page exists — the question a bare count cannot answer.
      hasCursor: !!res.data?.nextCursor,
    }),
  );

  if (!res.ok) {
    // 404 not_archived / not_found is an EMPTY STATE, not a failure: nothing was ever
    // captured for this entity. Cache it so the long tail stops costing anything.
    if (res.status === 404 || res.code === "not_archived" || res.code === "not_found") {
      await rememberMiss(env, path);
    }
    return null;
  }

  const raw = Array.isArray(res.data?.comments) ? res.data!.comments! : [];

  /**
   * Drop rows we have suppressed product-wide.
   *
   * ⚠️ Applied AFTER the fetch, never as an upstream filter — the archive has no
   * concept of our moderation decisions. And ⚠️ a filtered page comes back SHORT: do
   * not top it up with another fetch. That would spend quota and produce a misleading
   * list; the cursor is still valid, so the next page simply arrives on demand.
   */
  const suppressed = await loadSuppressed(env, raw.map((c) => (c as { id?: string })?.id ?? ""));
  const visible = suppressed.size === 0
    ? raw
    : raw.filter((c) => !suppressed.has((c as { id?: string })?.id ?? ""));

  /**
   * Record what this read found, so a collapsed header elsewhere can say a
   * conversation exists without anyone paying a `read_unit` for it.
   *
   * ⚠️ From `visible` — after product-wide suppression, BEFORE the per-reader block
   * filter below. The row is shared by every reader, and baking one reader's block list
   * into it is exactly the cross-account leak the ordering here exists to prevent.
   *
   * ⚠️ First page only. A cursored read is page 2+, and writing its length would
   * overwrite the total with a fragment.
   *
   * Best effort, like everything else in this file: a failed write costs a signal on a
   * header, and must never take down the read it rode in on.
   */
  if (!cursor) {
    await rememberCount(env, path, visible.length, res.data?.complete ?? false);
  }

  // ⚠️ Per-READER, so it must run after the shared cache is read, never before — baking
  // one reader's block list into a cached page is precisely the cross-account leak
  // `comments.ts` documents at the top of the file.
  const comments = filterBlocked(visible, await loadArchiveBlocks(env, userId));

  // Only the slugs on this page. `origin` is the archive's own field name.
  const present = new Set(
    comments
      .map((c) => (c as { origin?: { slug?: string } })?.origin?.slug)
      .filter((x): x is string => !!x),
  );
  return {
    comments,
    // ⚠️ **`nextCursor`, not `cursor`.** The request parameter is called `cursor` and
    // the RESPONSE field is called `nextCursor` — the spec spells this out ("`cursor`:
    // from the previous page's `nextCursor`"), and reading the wrong one is silent:
    // the cursor is simply always undefined, so `hasMore` is always false and the
    // "load more" control never appears. Measured on House of the Dragon, which
    // returned a full page of 20 with no way to reach page two.
    //
    // The identical trap is annotated in `loadArchiveReplies`; it was written there
    // first and not applied back to here.
    cursor: res.data?.nextCursor ?? null,
    complete: res.data?.complete ?? comments.length < ARCHIVE_PAGE_LIMIT,
    sources: sources.filter((s) => present.has(s.slug)),
    platforms: platformSources(sources),
  };
}
