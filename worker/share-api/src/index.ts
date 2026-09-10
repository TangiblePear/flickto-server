interface Env {
  BUCKET: R2Bucket;
  /** Group Watch sessions. One Durable Object per session code — see groupWatch.ts. */
  GROUP_SESSION: DurableObjectNamespace;
  /** Group Watch sessions created per IP per hour. */
  GROUP_WATCH_PER_HOUR?: string;
  SHARE_TTL_SECONDS: string;
  MAX_ITEMS: string;
  RATE_LIMIT_PER_HOUR: string;
  FCM_PROJECT_ID: string;
  FCM_SERVICE_ACCOUNT_EMAIL: string;
  FCM_PRIVATE_KEY: string;
  // Image moderation. When MODERATION_ENABLED !== "true" or the key is absent,
  // uploads skip the paid scan (dev mode) and are accepted.
  MODERATION_ENABLED?: string;
  VISION_API_KEY?: string;
  // Play Developer API service account, used only to verify a Premiere purchase
  // token. All three are SECRETS; unset ⇒ /api/me/premiere/verify 503s and no
  // stored entitlement changes in either direction. See premiere.ts.
  PLAY_SA_CLIENT_EMAIL?: string;
  PLAY_SA_PRIVATE_KEY?: string;
  PLAY_PACKAGE_NAME?: string;
  // Distinct-reporter threshold that auto-hides a picture pending admin review.
  REPORT_AUTOHIDE?: string;
  // Orphan-profile reaper: delete a friendId folder untouched for this long.
  PROFILE_TTL_SECONDS?: string;
  // Retention for `_reports/` records. Nothing else prunes that prefix, so without
  // this it grows forever. Longer than a profile folder: a safety record should
  // outlive an inactive device.
  REPORT_TTL_SECONDS?: string;
  // Max folders the reaper purges per run (keeps each run bounded).
  GC_MAX_PREFIXES_PER_RUN?: string;
  // Opportunistic trigger cadence (no cron budget): run at most once per this.
  REAP_INTERVAL_SECONDS?: string;
  // Per-isolate throttle so we don't read the gate object on every request.
  REAP_GATE_THROTTLE_SECONDS?: string;
  // Google account linking (Part 1). GOOGLE_WEB_CLIENT_ID is the OAuth Web client
  // id the ID token's `aud` must match; ACCOUNT_PEPPER is a 32-byte secret used to
  // wrap the per-account DEK. Both absent → the account endpoints report not_configured.
  GOOGLE_WEB_CLIENT_ID?: string;
  ACCOUNT_PEPPER?: string;
  // Accounts/profiles/friendships/blocks. Bound in wrangler.toml as `DB`.
  DB: D1Database;
  // Workers AI, for inline comment translation. Optional: with no binding every
  // comment comes back flagged untranslated and the client falls back to
  // on-device ML Kit — the same path an exhausted daily allowance takes.
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  // Firebase project **id** (not the project number) — a Firebase ID token's
  // `aud`. Absent → /api/auth/* reports not_configured.
  FIREBASE_PROJECT_ID?: string;
  // Per-author hourly comment cap. Config rather than a constant so it tunes
  // without a deploy, the same shape as RATE_LIMIT_PER_HOUR.
  COMMENTS_PER_HOUR?: string;
  // GIF picker upstream (KLIPY). A SECRET (`wrangler secret put KLIPY_API_KEY`),
  // never a var, and never in the APK: KLIPY puts the key in the URL path, so a
  // direct client would ship it, and an APK key is trivially extractable. The
  // route path stays /api/giphy/* for old-build compatibility. Unset ⇒ 503.
  KLIPY_API_KEY?: string;
  // Shared with the Pages admin panel, which proxies comment moderation here
  // rather than reaching into D1 itself. A SECRET:
  //   wrangler secret put ADMIN_KEY
  // Unset ⇒ /api/admin/* answers 403. Closed rather than open when unconfigured.
  ADMIN_KEY?: string;
  // Per-IP hourly cap on in-app feedback submissions. Lower than share-create by
  // default (5): a person with something to say sends one, not ten.
  FEEDBACK_PER_HOUR?: string;
  // Derived watch-history totals (src/history.ts). A CACHE, never a source of truth —
  // every entry is reproducible from the per-user R2 document, so losing the namespace
  // costs latency and nothing else.
  HISTORY_STATS_KV?: KVNamespace;
  // One data point per TITLE per sync — never per event. At 2 billion events a per-event
  // write would be ~$497/month; per title it is ~18x fewer and stays inside the included
  // allowance. It is also the ONLY thing that can answer a cross-user question, because
  // the history itself is an opaque R2 document.
  HISTORY_ANALYTICS?: AnalyticsEngineDataset;
  // Account id for the Analytics Engine SQL API — reading a dataset is an
  // account-level HTTP call, not a binding. The credential is a SECRET:
  //   wrangler secret put ANALYTICS_API_TOKEN
  // Either missing ⇒ GET /api/stats/global answers 503. Writes are unaffected, so the
  // data accumulates while the token is outstanding.
  CF_ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
}

import { sendFcmMessage, pickFcmTarget } from "./fcm";
import { fcmConfig, notifyAccount } from "./notify";
import { moderateImage } from "./moderation";
import {
  STICKER_ID,
  handleBrowseStickers,
  handleCommunityStickers,
  handleDeleteSticker,
  handleGetSticker,
  handleUploadSticker,
  handleUseSticker,
} from "./stickers";
import { reapOrphanProfiles, reapOldReports, dueForReap } from "./reaper";
import { handleAccountLink, handleAccountResolve, handleAccountUnlink, deleteAccountForFriend } from "./account";
import { handleAuthSession, handleAuthLogout, handleAuthProbe, resolveSession } from "./auth";
import { GroupSession, handleWatchCreate, handleWatchMeta, handleWatchSocket } from "./groupWatch";
import { handleClearFeed, handleGetFeed, handlePublishFeed } from "./feed";
import {
  handleAcceptSharedList,
  handleDeleteSharedList,
  handleGetSharedLists,
  handleShareList,
} from "./lists";
import {
  handleDeleteMatch,
  handleGetMatchPayload,
  handleGetMatches,
  handleMatchAccept,
  handleMatchRequest,
} from "./match";
import {
  handleDeleteComment,
  handleGetReplies,
  handleGetComments,
  handleGetFriendComments,
  handleGetTranslations,
  loadNativeArchiveReplies,
  translateArchiveRows,
  handlePostComment,
  handleReactToComment,
  handleReportComment,
  parseSubject,
} from "./comments";
import {
  addArchiveBlock,
  handleReportArchiveComment,
  loadArchiveBlocks,
  loadArchiveReplies,
  removeArchiveBlock,
} from "./commsuniComments";
import { drainArchiveOutbox, identityChoice, setIdentityChoice } from "./commsuniMirror";
import { handleGetMyEpisodeRatings, handleGetPoll, handlePutVote } from "./poll";
import {
  handleGetDistribution,
  handleGetFriendsDay,
  handleGetLeaderboard,
  handleGetMine,
  handleGetOpen,
  handlePostResult,
} from "./dailyGame";
import {
  handleConfirmPush,
  handleGetIntegrations,
  handleReconcileLease,
  handleUpdateIntegration,
} from "./integrations";
import {
  handleDeleteHistory,
  handleGetGlobalStats,
  handleGetHistory,
  handleGetHistoryStats,
  handleHistorySync,
} from "./history";
import { handleAdminCommentAction, handleAdminCommentReports } from "./commentsAdmin";
import { handleModerationAct, handleModerationQueue } from "./moderationQueue";
import { handleInsights } from "./insights";
import { handleUserDetail, handleUsersAct, handleUsersList } from "./usersAdmin";
import { handleDevicesAct, handleDevicesList } from "./devicesAdmin";
import { handleAdminFeedbackAct, handleAdminFeedbackList, handlePostFeedback } from "./feedback";
import { handleKlipy } from "./klipy";
import { handleVerifyPremiere, isPremiere } from "./premiere";
import { handlePutInstall } from "./install";
import { loadFriendProgress } from "./progress";
import { handleSync, type RelayRequest, type RelayResponse, type SyncEnv } from "./sync";
import { handleWebTelemetry } from "./telemetry";
import {
  handleBlock,
  handleDeleteAccount,
  handleFriendAccept,
  handleFriendRemove,
  handleFriendRequest,
  handleGetBlocks,
  handleGetFriendCards,
  handleGetFriends,
  handleReport as handleUserReport,
  handleUnblock,
} from "./friends";
import type { PublicCard } from "./friends";
import {
  appVersion,
  handleBootstrap,
  handleGetMyProfile,
  handleGetProfile,
  handlePutMyProfile,
  handlePutMyStats,
  minSocialVersion,
} from "./profiles";
import { postingSuspendedUntil, suspendedBody } from "./suspension";
import { handlePutMyPush, readAccountPush } from "./push";
import { handleGetMySettings, handlePutMySettings } from "./settings";
import { handleGetMyAchievements, handlePutMyAchievements } from "./achievements";
import {
  handleCreateList,
  handleDeleteList,
  handleGetMyLists,
  handleListItems,
  handleListsOptions,
  handleUpdateList,
} from "./userLists";
import {
  handleAdhocCreate,
  handleAdhocGet,
  handleAdhocMeta,
  handleAdhocPut,
} from "./matchAdhoc";
import {
  handlePublishList,
  handleUnpublishList,
  handlePublicListsOptions,
  handleFollow,
  handleLike,
  handleBrowse,
  handleTagCatalogue,
  handleMyFollows,
  handleMyPublishedLists,
  handlePublicListDetail,
  handleReportPublicList,
} from "./publicLists";

interface ShareItem {
  tmdbId: number;
  type: string;
}

interface SharePayload {
  // "manual" carries an item snapshot; "smart" carries a filter blob the
  // recipient's app rebuilds into a dynamic smart list. Defaults to "manual"
  // so anything stored before this field existed still reads correctly.
  kind?: string;
  title: string;
  items?: ShareItem[];
  filters?: unknown;
}

interface StoredShare {
  kind: string;
  title: string;
  items: ShareItem[];
  filters: unknown | null;
  createdAt: string;
  expiresAt: string;
  /**
   * Taken down — by an admin, or automatically once enough distinct signed-in
   * reporters flagged it. Both read paths then answer **exactly** what an expired
   * link answers. That identity is the point: a takedown a user can distinguish
   * from an expiry is itself a signal, and tells an abuser their link was actioned.
   */
  hidden?: boolean;
  /**
   * The signed-in account that created this link, when there was one. `POST
   * /api/share` stays unauthenticated — that is the whole point of the path — so
   * this is null for anonymous shares and populated only when the caller happened
   * to send a session. It buys the admin a repeat offender to act on rather than
   * whack-a-mole with individual codes; it gates nothing.
   */
  creatorId?: string | null;
  /**
   * **Inert — never incremented, and nothing reads it.** Kept only so objects
   * written before 2026-07-27 still parse and the wire shape stays stable.
   *
   * `handleGet` used to read-modify-write this on every fetch: an R2 write on the
   * public path, and a lost update whenever two people opened the same link at once,
   * for a number no surface has ever displayed. **Do not reinstate the increment.**
   * If view counts are ever actually wanted, they belong in D1 as an atomic
   * `UPDATE … SET views = views + 1`, not as a read-modify-write against an object.
   */
  views: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, If-Match, X-Feed-Secret, X-Read-Token, X-Revoke-Session",
};

// ── Limits (the relay stores ciphertext only; these just cap abuse) ──
const MAX_BLOB_BYTES = 256 * 1024; // a profile / opinion ciphertext object
const MAX_ACCESS_BYTES = 512 * 1024; // wrapped-keys bundle (grows with friend count)
const MAX_BATCH_ITEMS = 200; // friends queried per opinion-batch call
const MAX_CARD_BYTES = 8 * 1024;
const MAX_FILTERS_BYTES = 4096;
const MAX_BACKUP_BYTES = 64 * 1024; // zero-knowledge identity bundle ciphertext
const MAX_SELF_BYTES = 512 * 1024; // live friends+block record ciphertext (grows with friend count)

const FRIENDCODE_TTL = 60 * 60 * 24 * 90; // 90 days
const FRIEND_ID = "[A-Z0-9]{12,40}";
// A D1 `users.id` — Crockford base32, 26 chars. Deliberately NOT reusing FRIEND_ID,
// which it happens to satisfy: matching a friendId on an account-keyed route would
// look up an id in the wrong id space and quietly answer 404.
const USER_ID = "[0-9A-HJKMNP-TV-Z]{26}";
const FRIEND_CODE = "[A-Z0-9]{6,12}";
const HASH = "[a-f0-9]{32,160}"; // hex blind index (HMAC-SHA256 + Tink prefix)
const LOOKUP_KEY = "[A-Za-z0-9_-]{22,128}"; // HKDF/HMAC blind index (hex or base64url)

const APP_PACKAGE = "com.flickto.app";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.flickto.app";
const APP_STORE_URL = "https://apps.apple.com/app/id0000000000";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS, ...(init.headers ?? {}) },
  });

const rawJson = (raw: string) =>
  new Response(raw, { headers: { "Content-Type": "application/json", ...CORS } });

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });

const forbidden = () => json({ error: "forbidden" }, { status: 403 });
const notFound = () => json({ error: "not_found" }, { status: 404 });
const tooLarge = () => json({ error: "too_large" }, { status: 413 });
const invalidJson = () => json({ error: "invalid_json" }, { status: 400 });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Opportunistic orphan-profile reaper: no cron budget on this account, so we
    // let ambient request traffic tick the clock. Fire-and-forget — never blocks
    // the response, self-throttles, and runs the reap at most once per interval.
    ctx.waitUntil(maybeReap(env));

    const url = new URL(req.url);
    const p = url.pathname;

    // ── Share links (legacy feature, now R2-backed) ──
    if (p === "/api/share" && req.method === "POST") return handleCreate(req, env);

    const apiShare = p.match(/^\/api\/share\/([A-Z0-9]{6,12})$/);
    if (apiShare && req.method === "GET") return handleGet(apiShare[1], env);

    // Report a public share link. Needs no new route pattern — `/api/share/*` is
    // already bound in wrangler.toml. Unauthenticated by design; see the handler.
    const shareReport = p.match(/^\/api\/share\/([A-Z0-9]{6,12})\/report$/);
    if (shareReport && req.method === "POST") return handleShareReport(shareReport[1], req, env);

    const landing = p.match(/^\/share\/([A-Z0-9]{6,12})$/);
    if (landing && req.method === "GET") return handleLanding(landing[1], env);

    // ── Group Watch (Durable Object per session) ──
    //
    // ⚠️ Each of these needs its own zone-route pattern in wrangler.toml. A pattern matches
    // the FULL url including query string, and `/api/watch/*` does not match a bare
    // `/api/watch` — so the create route is listed separately from the code routes.
    if (p === "/api/watch" && req.method === "POST") {
      const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
      return handleWatchCreate(req, env, (scope, limit) => rateLimited(env, scope, ip, limit));
    }

    const watchSocket = p.match(/^\/api\/watch\/([0-9A-HJKMNP-TV-Z]{6})\/ws$/);
    if (watchSocket && req.method === "GET") return handleWatchSocket(watchSocket[1], req, env);

    const watchMeta = p.match(/^\/api\/watch\/([0-9A-HJKMNP-TV-Z]{6})$/);
    if (watchMeta && req.method === "GET") return handleWatchMeta(watchMeta[1], env);

    // ── Opinion batch (blind-indexed, on-demand reads) ──
    if (p === "/api/opinions/batch" && req.method === "POST") {
      return handleOpinionsBatch(req, env);
    }

    // ── User-scoped objects: access keys, profile, per-title opinions, push ──
    // `push` (was `fcm-token`) carries the owner's topic names for O(1) fan-out;
    // both are accepted during rollout and neither is client-readable (GET refused).
    // `access` and `profile` are GONE (step 7) — see the note above handleGetUserObject.
    // ⚠️ The route PATTERN stays: `push` serves through it, as do `picture` and
    // `opinions/*` below. Removing a pattern that still has traffic is a silent 405, and
    // `wrangler deploy --dry-run` cannot see it.
    // ── Profile picture (server-visible, moderated) ──
    // ⚠️ READ ONLY, and deliberately still here. PUT/DELETE are gone with the client
    // that called them (9a), but one ACTIVE account's `profiles.picture_url` still
    // points at this route, so removing GET would put a broken avatar on every screen
    // that shows them. 8adbcbb5 heals that URL on the owner's next profile publish;
    // this goes one release after it has, not before. Verified 2026-07-30, and by
    // measurement rather than assumption — the plan claimed the data was already
    // migrated and it was not.
    const userPicture = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/picture$`));
    if (userPicture) {
      const [, friendId] = userPicture;
      if (req.method === "GET") return handleGetPicture(friendId, env);
    }

    // ── Profile picture, account-keyed (step 3 of the friendId retirement) ──
    // Writes move under `/api/me/` and authenticate on the session; the READ stays
    // public and unauthenticated at `/api/profile/{userId}/picture` because Coil
    // loads it with no custom headers. `users.id` becomes the capability the
    // friendId was — both are opaque, but note this promotes `users.id` from an
    // identity into a URL anyone holding the URL can fetch.
    //
    // The old `/api/user/{friendId}/picture` trio above is untouched and keeps
    // serving for one release: pictures uploaded by builds that predate this, and
    // the `profiles.picture_url` values pointing at them, are still live.
    if (p === "/api/me/picture") {
      if (req.method === "PUT") return handlePutMyPicture(req, env, ctx);
      if (req.method === "DELETE") return handleDeleteMyPicture(req, env, ctx);
    }

    const accountPicture = p.match(new RegExp(`^/api/profile/(${USER_ID})/picture$`));
    if (accountPicture && req.method === "GET") return handleGetAccountPicture(accountPicture[1], env);

    // ── Sticker cut-outs (src/stickers.ts) ──
    // Same split as the pictures above and for the same reasons: writes are
    // session-authed under `/api/me/`, the read is public at its own prefix because Coil
    // fetches it with no headers.
    //
    // ⚠️ `/api/me/stickers` and `/api/me/stickers/{id}` are matched SEPARATELY. A bare
    // path is not matched by a `/{id}` pattern, and this file has been bitten by exactly
    // that six times over — with both vitest and `wrangler deploy --dry-run` green.
    if (p === "/api/me/stickers" && req.method === "POST") {
      return handleUploadSticker(req, env, ctx);
    }
    const mySticker = p.match(new RegExp(`^/api/me/stickers/(${STICKER_ID})$`));
    if (mySticker && req.method === "DELETE") return handleDeleteSticker(req, mySticker[1], env, ctx);

    // Community market for a title. Matched BEFORE the `{id}` pattern below — "community"
    // is not 32 hex so it could not collide, but relying on that is relying on the id
    // alphabet never widening.
    if (p === "/api/stickers/community" && req.method === "GET") {
      return handleCommunityStickers(url, env);
    }
    if (p === "/api/stickers/browse" && req.method === "GET") {
      return handleBrowseStickers(url, env);
    }
    // Matched BEFORE the bare `{id}` read below — `/api/stickers/{id}/use` would
    // otherwise fall through to a pattern that does not expect a trailing segment.
    const stickerUse = p.match(new RegExp(`^/api/stickers/(${STICKER_ID})/use$`));
    if (stickerUse && req.method === "POST") return handleUseSticker(req, stickerUse[1], env, ctx);

    // No user id in this path, deliberately — a sticker outlives the account that made
    // it, and a URL carrying `users.id` would keep a deleted account's identifier
    // resolvable forever. See the header of src/stickers.ts.
    const publicSticker = p.match(new RegExp(`^/api/stickers/(${STICKER_ID})$`));
    if (publicSticker && req.method === "GET") return handleGetSticker(publicSticker[1], env);

    // Report ingestion moved to `POST /api/report` (D1, session-authenticated). The
    // relay endpoint that lived here keyed on the device friendId and authenticated
    // on a bound read token; its picture auto-hide now runs in friends.ts, against
    // the same tombstone and the same REPORT_AUTOHIDE threshold.

    // `POST /api/social/freshness` is retired (step 7). No client calls it, and the objects
    // it reported on — `profile.json`, `access.json` — are no longer written or read.

    // ── Friend code → public friend card ──
    if (p === "/api/friendcode" && req.method === "POST") {
      return handlePublishFriendCode(req, env, ctx);
    }
    const friendCode = p.match(new RegExp(`^/api/friendcode/(${FRIEND_CODE})$`));
    if (friendCode && req.method === "GET") return handleGetFriendCode(friendCode[1], env);

    // Legal pages (/privacy, /delete) are now static HTML served by the
    // flickto-content worker — no route handlers needed here.

    // ── Portable identity backup (zero-knowledge ciphertext) ──
    if (p === "/api/social/backup" && req.method === "PUT") return handlePutBackup(req, env);
    const backupObj = p.match(new RegExp(`^/api/social/backup/(${LOOKUP_KEY})$`));
    if (backupObj) {
      if (req.method === "GET") return handleGetBackup(backupObj[1], env);
      if (req.method === "DELETE") return handleDeleteBackup(backupObj[1], env);
    }

    // ── Live friends+block record (optimistic concurrency) ──
    const selfObj = p.match(new RegExp(`^/api/social/self/(${LOOKUP_KEY})$`));
    if (selfObj) {
      if (req.method === "GET") return handleGetSelf(selfObj[1], env);
      if (req.method === "PUT") return handlePutSelf(selfObj[1], req, env);
      if (req.method === "DELETE") return handleDeleteSelf(selfObj[1], env);
    }

    // ── Google account linking (Part 1) ──
    if (p === "/api/account/link" && req.method === "POST") {
      return handleAccountLink(req, env, url, (friendId) => purgeFriendScoped(env, friendId));
    }
    if (p === "/api/account/resolve" && req.method === "GET") return handleAccountResolve(req, env);
    if (p === "/api/account/unlink" && req.method === "POST") return handleAccountUnlink(req, env);

    // ── Firebase Auth sessions (Phase 1) ──
    if (p === "/api/auth/session" && req.method === "POST") return handleAuthSession(req, env);
    if (p === "/api/auth/logout" && req.method === "POST") return handleAuthLogout(req, env);
    // Read-only, and asked BEFORE /session so the client can decide whether creating an
    // account is the right thing to do. Covered by the existing `flickto.app/api/auth/*`
    // route pattern — a new pattern is not needed, but a new path outside it would be
    // invisible in production while every test and --dry-run passed.
    if (p === "/api/auth/probe" && req.method === "POST") return handleAuthProbe(req, env);

    // ── Server-authoritative profiles (Phase 2). Session-authenticated. ──
    // NOT the same as /api/user/{friendId}/profile above, which is the E2EE
    // ciphertext blob and is staying — different auth, different data.
    if (p === "/api/me/bootstrap" && req.method === "GET") return handleBootstrap(req, env, ctx);
    if (p === "/api/me/profile") {
      if (req.method === "GET") return handleGetMyProfile(req, env, ctx);
      if (req.method === "PUT") return handlePutMyProfile(req, env, ctx);
    }
    if (p === "/api/me/stats" && req.method === "PUT") return handlePutMyStats(req, env, ctx);
    // Portable preferences and achievements (migration 0024). Owner-only by
    // construction — there is no foreign read route for either, and none should be
    // added: `user_settings` carries the person's gender.
    if (p === "/api/me/settings") {
      if (req.method === "GET") return handleGetMySettings(req, env, ctx);
      if (req.method === "PUT") return handlePutMySettings(req, env, ctx);
    }
    if (p === "/api/me/achievements") {
      if (req.method === "GET") return handleGetMyAchievements(req, env, ctx);
      if (req.method === "PUT") return handlePutMyAchievements(req, env, ctx);
    }
    // Personal lists and the watchlist (migration 0026). Owner-only. NOTE the
    // path: `/api/lists/*` is friend-to-friend SHARING and is a different
    // module entirely — see userLists.ts's header.
    if (p === "/api/me/lists") {
      if (req.method === "GET") return handleGetMyLists(req, env, ctx);
      if (req.method === "POST") return handleCreateList(req, env, ctx);
      if (req.method === "OPTIONS") return handleListsOptions();
    }
    const listItems = p.match(/^\/api\/me\/lists\/([A-Za-z0-9._:-]{1,64})\/items$/);
    if (listItems && (req.method === "POST" || req.method === "DELETE")) {
      return handleListItems(listItems[1], req, env, ctx);
    }
    // ⚠️ Registered BEFORE `oneList` below: that regex's id character class
    // ([A-Za-z0-9._:-]{1,64}) matches the literal string "published", so this exact
    // path must be checked first or it gets read as `/api/me/lists/{id}` with
    // id = "published".
    if (p === "/api/me/lists/published" && req.method === "GET") {
      return handleMyPublishedLists(req, env, ctx);
    }
    const oneList = p.match(/^\/api\/me\/lists\/([A-Za-z0-9._:-]{1,64})$/);
    if (oneList) {
      if (req.method === "PUT") return handleUpdateList(oneList[1], req, env, ctx);
      if (req.method === "DELETE") return handleDeleteList(oneList[1], req, env, ctx);
    }
    // Publishing a list into the public directory (migration 0039). Hangs off
    // `/api/me/lists/{id}` because it is an act by the OWNER on a list they own;
    // reading the directory lives under `/api/public/lists*`.
    const publishList = p.match(/^\/api\/me\/lists\/([A-Za-z0-9._:-]{1,64})\/publish$/);
    if (publishList) {
      if (req.method === "POST") return handlePublishList(publishList[1], req, env, ctx);
      if (req.method === "DELETE") return handleUnpublishList(publishList[1], req, env, ctx);
      if (req.method === "OPTIONS") return handlePublicListsOptions();
    }
    // Push topics on the account. Replaces `PUT /api/user/{friendId}/push`, which
    // authenticated on a relay-issued owner secret — so the friendId WAS the auth
    // scope. Both paths are served for one release; see push.ts.
    if (p === "/api/me/push" && req.method === "PUT") return handlePutMyPush(req, env, ctx);

    const foreignProfile = p.match(/^\/api\/profile\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (foreignProfile && req.method === "GET") return handleGetProfile(foreignProfile[1], req, env, ctx);

    // Browsing the directory. `/tags` is registered before the owner/id matchers
    // below so a later loosening of that ULID character class cannot swallow it.
    if (p === "/api/public/lists") {
      if (req.method === "GET") return handleBrowse(req, env, ctx);
      if (req.method === "OPTIONS") return handlePublicListsOptions();
    }
    if (p === "/api/public/lists/tags" && req.method === "GET") {
      return handleTagCatalogue(req, env, ctx);
    }

    // The directory's engagement verbs. `{owner}` is a users.id (26-char ULID
    // alphabet, matching the foreignProfile route above); `{id}` is a client-minted
    // list id, same character class as the /api/me/lists routes.
    const listEngage = p.match(
      /^\/api\/public\/lists\/([0-9A-HJKMNP-TV-Z]{26})\/([A-Za-z0-9._:-]{1,64})\/(follow|like)$/,
    );
    if (listEngage) {
      if (req.method === "OPTIONS") return handlePublicListsOptions();
      if (req.method === "POST" || req.method === "DELETE") {
        return listEngage[3] === "follow"
          ? handleFollow(listEngage[1], listEngage[2], req, env, ctx)
          : handleLike(listEngage[1], listEngage[2], req, env, ctx);
      }
    }

    if (p === "/api/me/follows" && req.method === "GET") return handleMyFollows(req, env, ctx);

    const listReport = p.match(
      /^\/api\/public\/lists\/([0-9A-HJKMNP-TV-Z]{26})\/([A-Za-z0-9._:-]{1,64})\/report$/,
    );
    if (listReport && req.method === "POST") {
      return handleReportPublicList(listReport[1], listReport[2], req, env, ctx);
    }

    // ⚠️ LAST of the /api/public/lists/* routes — its second segment would otherwise
    // swallow `/follow`, `/like` and `/report`.
    const listDetail = p.match(
      /^\/api\/public\/lists\/([0-9A-HJKMNP-TV-Z]{26})\/([A-Za-z0-9._:-]{1,64})$/,
    );
    if (listDetail && req.method === "GET") {
      return handlePublicListDetail(listDetail[1], listDetail[2], req, env, ctx);
    }

    // `wake` is fire-and-forget: ctx.waitUntil keeps the push alive past the response
    // without ever delaying or failing it.
    //
    // Declared HERE, above every consumer, not beside the lists/match routes it was
    // written for. `const` is not hoisted, so the friend-removal routes below --
    // added later and further up -- hit the temporal dead zone and threw
    // ReferenceError, which the catch-all turned into a 500. Every unfriend failed
    // server-side for ~40 minutes on 2026-07-28 while the client dutifully reported
    // "server delete failed: HTTP 500" into its own health log.
    const wake = (userId: string) => ctx.waitUntil(notifyAccount(env, userId));

    // ── Friendships, blocks, reports (Phase 3/4). Session-authenticated. ──
    if (p === "/api/me/account" && req.method === "DELETE") return handleDeleteAccount(req, env, ctx);
    // FlickTo Premiere. The ONLY writer of `users.premiere_until` — there is
    // deliberately no way to set it through the profile PUT, which is a
    // client-declared merge (see migration 0028).
    if (p === "/api/me/premiere/verify" && req.method === "POST") return handleVerifyPremiere(req, env, ctx);
    // First-install date. The device is the only thing that knows it; this is where it
    // reaches the account so it survives a reinstall. See migration 0030.
    if (p === "/api/me/install" && req.method === "POST") return handlePutInstall(req, env, ctx);
    if (p === "/api/friends" && req.method === "GET") return handleGetFriends(req, env, ctx);
    if (p === "/api/friends/request" && req.method === "POST") return handleFriendRequest(req, env, ctx, wake);
    if (p === "/api/friends/accept" && req.method === "POST") return handleFriendAccept(req, env, ctx, wake);
    if (p === "/api/friends/cards" && req.method === "POST") {
      return handleGetFriendCards(req, env, (code) => loadPublicCard(env, code), ctx);
    }

    const friendTarget = p.match(/^\/api\/friends\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (friendTarget && req.method === "DELETE") return handleFriendRemove(friendTarget[1], req, env, ctx, wake);
    if (p === "/api/blocks" && req.method === "GET") return handleGetBlocks(req, env, ctx);
    const blockTarget = p.match(/^\/api\/blocks\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (blockTarget) {
      if (req.method === "POST") return handleBlock(blockTarget[1], req, env, ctx);
      if (req.method === "DELETE") return handleUnblock(blockTarget[1], req, env, ctx);
    }

    if (p === "/api/report" && req.method === "POST") return handleUserReport(req, env, ctx);

    // ── Shared lists + Friend Match (D1). Session-authenticated. ──
    // These replace the last two directed-message types on the E2EE inbox. Both
    // live in the D1 half deliberately — folding them into the relay would keep
    // alive the thing this work exists to retire.

    if (p === "/api/lists/share" && req.method === "POST") return handleShareList(req, env, ctx, wake);
    if (p === "/api/lists/shared" && req.method === "GET") return handleGetSharedLists(req, env, ctx);

    const listAccept = p.match(/^\/api\/lists\/shared\/([0-9A-HJKMNP-TV-Z]{8,40})\/accept$/);
    if (listAccept && req.method === "POST") return handleAcceptSharedList(listAccept[1], req, env, ctx);

    const listTarget = p.match(/^\/api\/lists\/shared\/([0-9A-HJKMNP-TV-Z]{8,40})$/);
    if (listTarget && req.method === "DELETE") return handleDeleteSharedList(listTarget[1], req, env, ctx);

    // ── Account-free Friend Match, by QR, in person ──
    // Deliberately UNAUTHENTICATED: the whole point is that neither side needs an account.
    // Unlike `/api/social/backup`, whose lookup key is client-chosen, the token here is
    // SERVER-minted, so the namespace cannot be sprayed. See matchAdhoc.ts.
    if (p === "/api/match/adhoc" && req.method === "POST") return handleAdhocCreate(req, env);
    const adhocHalf = p.match(/^\/api\/match\/adhoc\/([0-9A-HJKMNP-TV-Z]{26})\/([ab])$/);
    if (adhocHalf) {
      if (req.method === "PUT") return handleAdhocPut(adhocHalf[1], adhocHalf[2], req, env);
      if (req.method === "GET") return handleAdhocGet(adhocHalf[1], adhocHalf[2], env);
    }
    const adhocMeta = p.match(/^\/api\/match\/adhoc\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (adhocMeta && req.method === "GET") return handleAdhocMeta(adhocMeta[1], env);

    if (p === "/api/match" && req.method === "GET") return handleGetMatches(req, env, ctx);
    if (p === "/api/match/request" && req.method === "POST") {
      // The card resolver is injected because the friend card lives in R2 and
      // `match.ts` is deliberately D1-only — same reason `sync.ts` takes a RelayLoader.
      return handleMatchRequest(req, env, ctx, (code) => resolveCardOwner(env, code), wake);
    }

    const matchPayload = p.match(/^\/api\/match\/([0-9A-HJKMNP-TV-Z]{26})\/payload$/);
    if (matchPayload && req.method === "GET") return handleGetMatchPayload(matchPayload[1], req, env, ctx);

    const matchAccept = p.match(/^\/api\/match\/([0-9A-HJKMNP-TV-Z]{26})\/accept$/);
    if (matchAccept && req.method === "POST") return handleMatchAccept(matchAccept[1], req, env, ctx, wake);

    const matchTarget = p.match(/^\/api\/match\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (matchTarget && req.method === "DELETE") return handleDeleteMatch(matchTarget[1], req, env, ctx, wake);

    // ── One chargeable request per refresh (see src/sync.ts). ──
    // The relay half is injected here because the R2 object layout and its crypto
    // helpers live in this file; `sync.ts` stays D1-only and therefore testable.
    if (p === "/api/sync" && req.method === "POST") {
      return handleSync(
        req,
        env as unknown as SyncEnv,
        ctx,
        (_e, _uid, relayReq) => loadRelay(env, relayReq),
        // R2-backed, so it is injected here rather than imported by sync.ts — that module
        // stays D1-only and therefore testable without a bucket binding.
        (_e, uid, queries) => loadFriendProgress(env, uid, queries),
      );
    }

    // The web's equivalent of the telemetry that rides `/api/sync` on Android. The
    // browser has no sync to ride, so it gets the one row and nothing else.
    if (p === "/api/telemetry" && req.method === "POST") return handleWebTelemetry(req, env, ctx);

    // ── Activity feed (Phase 6). Replaces the E2EE feed blob; opinions stay E2EE. ──
    if (p === "/api/feed" && req.method === "GET") return handleGetFeed(req, env, ctx);
    if (p === "/api/me/feed") {
      if (req.method === "POST") return handlePublishFeed(req, env, ctx);
      if (req.method === "DELETE") return handleClearFeed(req, env, ctx);
    }

    // ── Watch history (D1 + KV + Analytics Engine). Session-authenticated. ──
    // The server is an ADDITIVE sync layer: the device's Room database is always the
    // primary copy, and the client gates every one of these on holding a session, so
    // an account-free install never reaches them at all.
    if (p === "/api/history/sync" && req.method === "POST") return handleHistorySync(req, env, ctx);
    if (p === "/api/history/stats" && req.method === "GET") return handleGetHistoryStats(req, env, ctx);
    if (p === "/api/history" && req.method === "GET") return handleGetHistory(req, env, ctx);

    // The id is the client's canonical watch-event id (`watch-EPISODE-1396-s2e5-…`),
    // so the charset is what `HistoryRepository.buildWatchedItemId` emits. Matched
    // AFTER the two fixed subpaths above, which it would otherwise swallow.
    // Phase 3: server-coordinated Trakt/SIMKL push. Matched BEFORE the `{id}` pattern
    // below, which would otherwise swallow both of these as event ids.
    if (p === "/api/history/confirm-push" && req.method === "POST") return handleConfirmPush(req, env, ctx);
    if (p === "/api/history/reconcile-lease" && req.method === "POST") return handleReconcileLease(req, env, ctx);
    if (p === "/api/history/integrations") {
      if (req.method === "GET") return handleGetIntegrations(req, env, ctx);
      if (req.method === "PUT") return handleUpdateIntegration(req, env, ctx);
    }

    const historyEvent = p.match(/^\/api\/history\/([A-Za-z0-9._:-]{1,200})$/);
    if (historyEvent && req.method === "DELETE") return handleDeleteHistory(historyEvent[1], req, env, ctx);

    // Platform-wide totals. Public and unauthenticated by design — one aggregate
    // number for everybody, identifying nobody, and therefore edge-cacheable.
    if (p === "/api/stats/global" && req.method === "GET") return handleGetGlobalStats(req, env, ctx);

    // ── Comments (D1). Two read paths, deliberately not one query. ──
    // Path 1 is unauthenticated and edge-cached; path 2 is authenticated and must
    // NEVER be cached, because `caches.default` keys on URL and would hand one
    // user's friends-only comments to the next reader of the same URL.
    const commentsSubject = p.match(/^\/api\/titles\/([a-z]+)\/(\d+)\/comments(\/friends)?$/);
    if (commentsSubject && req.method === "GET") {
      const subject = parseSubject(commentsSubject[1], commentsSubject[2], url.searchParams);
      if (!subject) return json({ error: "invalid_subject" }, { status: 400 });
      return commentsSubject[3]
        ? handleGetFriendComments(req, env, subject, ctx)
        : handleGetComments(req, env, subject, ctx);
    }

    // The episode poll rides the same `/api/titles/{type}/{id}/…` shape as comments so
    // both features agree on what a subject is — `parseSubject` is shared, not copied.
    // GET is unauthenticated and edge-cached; PUT is session-authed and writes.
    const pollSubject = p.match(/^\/api\/titles\/([a-z]+)\/(\d+)\/(poll|vote)$/);
    if (pollSubject) {
      const subject = parseSubject(pollSubject[1], pollSubject[2], url.searchParams);
      if (!subject) return json({ error: "invalid_subject" }, { status: 400 });
      if (pollSubject[3] === "poll" && req.method === "GET") return handleGetPoll(req, env, subject, ctx);
      if (pollSubject[3] === "vote" && req.method === "PUT") return handlePutVote(req, env, subject, ctx);
    }

    // The per-reader half of the poll. It cannot ride the `/api/titles/…` shape above:
    // that read is unauthenticated and edge-cached precisely because one response is
    // correct for every reader, and this one is correct for exactly one.
    if (p === "/api/me/episode-ratings" && req.method === "GET") return handleGetMyEpisodeRatings(req, env, ctx);

    // ── One Take, the daily puzzle ──
    //
    // ⚠️ Two of these four do NOT gate on a session, against the house style, and both
    // are deliberate. The game is fully playable signed out and most web players never
    // sign in, so a signed-out player must be able to read the distribution AND count
    // towards it. `/result` verifies every submission against the archived answer whether
    // or not a session is present; the session only decides how much gets written.
    // One call to open the game: mine + stats + distribution + friends + all four
    // leaderboard windows + the caller's own name and face. Works signed out, returning
    // just the public distribution. The endpoints below stay for shipped app builds.
    if (p === "/api/daily-game/open" && req.method === "GET") return handleGetOpen(req, env, ctx);
    if (p === "/api/daily-game/result" && req.method === "POST") return handlePostResult(req, env, ctx);
    if (p === "/api/daily-game/mine" && req.method === "GET") return handleGetMine(req, env, ctx);
    if (p === "/api/daily-game/friends" && req.method === "GET") return handleGetFriendsDay(req, env, ctx);
    if (p === "/api/daily-game/leaderboard" && req.method === "GET") return handleGetLeaderboard(req, env, ctx);
    if (p === "/api/daily-game/distribution" && req.method === "GET") return handleGetDistribution(req, env);

    // One notifier for both comment paths. The collapse key is derived from the
    // KIND as well as the comment, so a "friend commented" notification and a
    // "people reacted" one about the same comment replace their own predecessors
    // rather than each other.
    const notifyComment = (userId: string, data: Record<string, string>) =>
      ctx.waitUntil(notifyAccount(env, userId, data, `${data.kind}:${data.commentId}`));

    if (p === "/api/comments" && req.method === "POST") return handlePostComment(req, env, ctx, notifyComment);

    /**
     * "Did the slow translations land yet?" — a cache-only read, polled by the sheet a
     * couple of seconds after it opens so a comment the deadline gave up on fills itself
     * in without a refresh.
     *
     * ⚠️ Registered BEFORE `commentTarget` below. That pattern is uppercase-only
     * (`[0-9A-Z:]`) so "translations" cannot match it today — but the two would collide
     * the moment anyone relaxed the id alphabet, and the failure would be a 404 on a
     * route that exists.
     */
    if (p === "/api/comments/translations" && req.method === "GET") {
      return handleGetTranslations(req, env, ctx);
    }

    const commentTarget = p.match(/^\/api\/comments\/([0-9A-Z:]{8,80})$/);
    if (commentTarget && req.method === "DELETE") return handleDeleteComment(commentTarget[1], req, env, ctx);

    /**
     * Archive replies. A SEPARATE route, not a widened one: archive ids are UUIDs and
     * match neither COMMENT_ID_RE nor anything in our comments table.
     *
     * ⚠️ Needs the `flickto.app/api/archive*` pattern in wrangler.toml — the BARE form.
     * `/api/archive/*` does not match `/api/archive`, the trap that table records six
     * times over. Verify with a live curl: 405 means the Worker was never reached.
     */
    const archiveReplies = p.match(/^\/api\/archive\/comments\/([0-9a-fA-F-]{36})\/replies$/);
    if (archiveReplies && req.method === "GET") {
      const session = await resolveSession(req, env as any, ctx);
      // ⚠️ `{ status: 401 }`, NOT `401`. This file's `json` helper takes a
      // **ResponseInit**, unlike the one in comments.ts which takes a status number.
      // Passing the bare number spreads to nothing and the response goes out as
      // **200 OK with an error body** — which a client checking `response.ok` reads as
      // success. Caught by a live curl; tsc is permanently red here so it did not.
      if (!session) return json({ error: "unauthorized" }, { status: 401 });
      const url = new URL(req.url);
      /**
       * Two shapes in one thread.
       *
       * `comments` is the partner's own replies, in the archive shape. `native` is
       * OURS — replies we hold against this archive parent, in the native wire shape,
       * kept separate so they keep their source badge, their edit and their delete.
       * Merging them into the array above would render an author's own words as a
       * foreign row they could only report.
       *
       * ⚠️ Loaded even when the archive half returns null. Upstream being down must
       * not hide a reply that lives in our own database.
       */
      const lang = (url.searchParams.get("lang") ?? "").slice(0, 8);
      const [page, native] = await Promise.all([
        loadArchiveReplies(env as any, archiveReplies[1], session.userId, url.searchParams.get("cursor")),
        loadNativeArchiveReplies(env as any, archiveReplies[1], lang, ctx).catch(() => []),
      ]);
      return json({
        ...(page ?? { comments: [], cursor: null, complete: true }),
        // ⚠️ Both halves of the thread translate, and they must: a reader who can read
        // the partner's top-level comment because we translated it, then expands and
        // finds its replies in the original language, has been handed half a
        // conversation. `native` already came back translated from the call above.
        comments: page ? await translateArchiveRows(env as any, page.comments, lang, ctx) : [],
        native,
      });
    }

    /**
     * Cross-app blocking (requirement 2).
     *
     * ⚠️ FOREIGN authors only. One of our own users is blocked through the friend graph
     * so that blocking them in Flickto also hides their mirrored comments everywhere —
     * one block store per person. The client routes by source; this route does not
     * accept our own slug.
     */
    /**
     * How this account appears to other apps.
     *
     * `shares: null` means never asked, which is what the client needs to know whether
     * to show the one-time prompt — distinct from `false`, which means asked and
     * declined and must not be asked again.
     */
    if (p === "/api/archive/identity" && req.method === "GET") {
      const session = await resolveSession(req, env as any, ctx);
      if (!session) return json({ error: "unauthorized" }, { status: 401 });
      return json({ shares: await identityChoice(env as any, session.userId) });
    }

    if (p === "/api/archive/identity" && req.method === "PUT") {
      const session = await resolveSession(req, env as any, ctx);
      if (!session) return json({ error: "unauthorized" }, { status: 401 });
      const body = (await req.json().catch(() => null)) as { shares?: unknown } | null;
      // ⚠️ Strict boolean. A missing or malformed field must not read as consent —
      // `!!body?.shares` would turn the string "false", and any truthy junk, into an
      // opt-in to publishing this person's name in other apps.
      if (typeof body?.shares !== "boolean") {
        return json({ error: "shares_required" }, { status: 400 });
      }
      await setIdentityChoice(env as any, session.userId, body.shares);
      return json({ shares: body.shares });
    }

    if (p === "/api/archive/blocks" && req.method === "GET") {
      const session = await resolveSession(req, env as any, ctx);
      if (!session) return json({ error: "unauthorized" }, { status: 401 });
      return json({ blocks: await loadArchiveBlocks(env as any, session.userId) });
    }

    const archiveBlock = p.match(/^\/api\/archive\/blocks\/([A-Za-z0-9._-]{1,64})\/(.{1,128})$/);
    if (archiveBlock && (req.method === "PUT" || req.method === "DELETE")) {
      const session = await resolveSession(req, env as any, ctx);
      if (!session) return json({ error: "unauthorized" }, { status: 401 });

      const slug = archiveBlock[1];
      const authorId = decodeURIComponent(archiveBlock[2]);

      // ⚠️ Refuse our own slug. Routing one of our users here would create a second
      // block store for the same person: they would stay blocked in comments while
      // remaining a friend everywhere else, and the user would have to block them twice.
      if (slug === (env as any).COMMSUNI_SLUG) {
        return json({ error: "use_account_block" }, { status: 400 });
      }

      if (req.method === "DELETE") {
        await removeArchiveBlock(env as any, session.userId, slug, authorId);
        return new Response(null, { status: 204, headers: CORS });
      }

      // The snapshot: there is no profile route for a foreign author, so a block that
      // cannot name itself is one the user cannot recognise or lift.
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // A block with no snapshot is still a block. Losing the name is worse than
        // losing the block, but refusing the block outright is worse than both.
      }
      await addArchiveBlock(
        env as any,
        session.userId,
        slug,
        authorId,
        typeof body.displayName === "string" ? body.displayName.slice(0, 128) : null,
        typeof body.authorColor === "string" ? body.authorColor.slice(0, 16) : null,
      );
      return new Response(null, { status: 204, headers: CORS });
    }

    /**
     * Report an archive comment — into OUR queue AND upstream (requirement 1).
     *
     * Separate from the native report route: archive ids are UUIDs and match neither
     * COMMENT_ID_RE nor anything in our comments table.
     */
    const archiveReport = p.match(/^\/api\/archive\/comments\/([0-9a-fA-F-]{36})\/report$/);
    if (archiveReport && req.method === "POST") {
      const session = await resolveSession(req, env as any, ctx);
      if (!session) return json({ error: "unauthorized" }, { status: 401 });

      // ⚠️ **No suspension gate — a suspended user may still report.** See the note on
      // handleReportComment: §10 requires that anyone who can still see a comment can
      // still report it, because reporting is not publishing.

      let payload: Record<string, unknown>;
      try {
        payload = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid_json" }, { status: 400 });
      }
      const result = await handleReportArchiveComment(
        archiveReport[1],
        typeof payload.reason === "string" ? payload.reason : "",
        typeof payload.context === "string" ? payload.context : "",
        session.userId,
        env as any,
        ctx,
      );
      return result.status === 204
        ? new Response(null, { status: 204, headers: CORS })
        : json(result.body, { status: result.status });
    }

    // Lazy, on expand only — never while rendering a list. The inline preview the
    // parent carries is what keeps short threads from reaching this at all.
    const commentReplies = p.match(/^\/api\/comments\/([0-9A-Z:]{8,80})\/replies$/);
    if (commentReplies && req.method === "GET") return handleGetReplies(commentReplies[1], req, env, ctx);

    const commentReaction = p.match(/^\/api\/comments\/([0-9A-Z:]{8,80})\/reaction$/);
    if (commentReaction && (req.method === "POST" || req.method === "DELETE")) {
      // The collapse key is the COMMENT, not the event: a later "12 people reacted"
      // must replace the earlier "8 people reacted" in the tray rather than sit
      // beside it saying a different number about the same thing.
      return handleReactToComment(commentReaction[1], req, env, ctx, notifyComment);
    }

    const commentReport = p.match(/^\/api\/comments\/([0-9A-Z:]{8,80})\/report$/);
    if (commentReport && req.method === "POST") return handleReportComment(commentReport[1], req, env, ctx);

    // ── GIF picker, proxied so the key never ships in the APK ──
    // Legacy path names, KLIPY behind them — builds already installed call these.
    if (p === "/api/giphy/trending" && req.method === "GET") return handleKlipy("trending", req, env, ctx);
    if (p === "/api/giphy/search" && req.method === "GET") return handleKlipy("search", req, env, ctx);

    // Comment moderation, proxied here by the admin panel rather than reading D1
    // itself: `n_public` moves with `hidden_at`, and that invariant has exactly one
    // implementation. Authorized by a shared key, never a user session.
    if (p === "/api/moderation/comment-reports" && req.method === "GET") return handleAdminCommentReports(req, env);

    const adminComment = p.match(/^\/api\/moderation\/comments\/([0-9A-Z:]{8,80})\/([a-z]+)$/);
    if (adminComment && req.method === "POST") {
      return handleAdminCommentAction(adminComment[1], adminComment[2], req, env);
    }

    // The unified queue: every report kind, both backends, one shape. Replaces the
    // two stopgap person-report endpoints that shipped with the report consolidation
    // — those were the temporary reader, not a second surface to keep alive.
    if (p === "/api/moderation/reports" && req.method === "GET") return handleModerationQueue(req, env);
    if (p === "/api/moderation/act" && req.method === "POST") return handleModerationAct(req, env);

    // In-app feedback. The submit path takes an OPTIONAL session — someone stuck at
    // sign-in is exactly who needs to be able to write to us — so `resolveSession`
    // returning null is a normal anonymous submission, not a 401.
    if (p === "/api/feedback" && req.method === "POST") {
      const session = await resolveSession(req, env, ctx);
      return handlePostFeedback(req, env, session?.userId ?? null);
    }
    if (p === "/api/feedback/admin" && req.method === "GET") return handleAdminFeedbackList(req, env);
    if (p === "/api/feedback/admin/act" && req.method === "POST") return handleAdminFeedbackAct(req, env);

    // Fleet insights for the admin panel. Read-only, ADMIN_KEY-gated like moderation.
    //
    // ⚠️ Its own route pattern (`flickto.app/api/insights*`), NOT under `/api/admin/*` —
    // that prefix belongs to flickto-scoring-api, and Cloudflare gives a route to exactly
    // one worker, so reusing it REJECTS the whole deploy rather than merging.
    if (p === "/api/insights" && req.method === "GET") return handleInsights(req, env);

    // ── The admin Users panel ──
    //
    // Own patterns (`/api/users*`, `/api/devices*`) for the same reason as insights above:
    // `/api/admin/*` belongs to flickto-scoring-api. `/api/users` is also distinct from the
    // existing PUBLIC `/api/user/*` (singular) — a different subtree, not a widening of it.
    //
    // ⚠️ `/api/users/act` is matched BEFORE the `{id}` route. `act` is a valid-looking id
    // to any pattern loose enough to accept one, so an id-first order would send every
    // action to the detail handler and 404 it.
    if (p === "/api/users" && req.method === "GET") return handleUsersList(req, env);
    if (p === "/api/users/act" && req.method === "POST") return handleUsersAct(req, env);
    if (p === "/api/devices" && req.method === "GET") return handleDevicesList(req, env);
    if (p === "/api/devices/act" && req.method === "POST") return handleDevicesAct(req, env);

    const userDetail = p.match(/^\/api\/users\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (userDetail && req.method === "GET") return handleUserDetail(req, env, userDetail[1]);

    // ── Account / data deletion (Google Play deletion policy) ──
    if (p === "/api/social/delete" && req.method === "POST") return handleSocialDelete(req, env);
    if (p === "/api/social/delete-request" && req.method === "POST") return handleDeleteRequest(req, env);

    return notFound();
  },

  /**
   * Drain the archive outbox on a schedule.
   *
   * ⚠️ **This exists because the "no cron budget" comment above was WRONG.** The account
   * had 4 of its 5 cron triggers used, not 5, so the opportunistic drain was designed
   * around a constraint that did not exist. Verified by counting `crons` across every
   * wrangler config on the account: cloudflare-backend 1, cloudflare-proxy 2, daily-ai 1.
   *
   * An opportunistic drain is fundamentally traffic-dependent, and the traffic it needed
   * never came: the natural flow is post-then-look, the client renders the new comment
   * optimistically from Room, so no read request follows a post. Comments sat queued and
   * due with `attempts = 0` twice in a row, and the second time was after a fix that
   * only widened which READS drain — still the wrong axis.
   *
   * The read-path drains stay. They make publishing near-instant while someone is
   * browsing; this makes it happen at all when nobody is.
   *
   * Bound is higher than the request-borne drain's 5 because nothing is waiting on this
   * response, but still well inside the 50-subrequest cap: each item is one upstream
   * call, times up to 3 retry attempts.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(drainArchiveOutbox(env as any, 10).catch(() => 0));
  },
};

// ── Opportunistic orphan-profile reaper ──────────────────────────────────────
// This account is at its 5-cron limit, so instead of a scheduled() cron the
// reaper piggybacks on ambient request traffic: any request past the interval
// fires one bounded reap in the background. A wiped/uninstalled device stops
// re-publishing (a live install re-PUTs fcm-token every ≤3 days), so its data
// ages out; recovery blobs (backup/, self/) are excluded by prefix shape.

interface GcState {
  cursor?: string;
  lastRunAt?: number;
}
const GC_CURSOR_KEY = "_gc/cursor.json";

// Best-effort per-isolate throttle so we hit R2 for the gate object at most once
// per window regardless of request volume (ephemeral; a recycled isolate just
// re-reads sooner — correctness rides on the persisted lastRunAt, not this).
let lastGateCheckMs = 0;

async function maybeReap(env: Env): Promise<void> {
  try {
    const now = Date.now();
    const throttleMs = Number(env.REAP_GATE_THROTTLE_SECONDS ?? "600") * 1000;
    if (now - lastGateCheckMs < throttleMs) return;
    lastGateCheckMs = now;

    const state = (await getJson<GcState>(env, GC_CURSOR_KEY)) ?? {};
    const intervalMs = Number(env.REAP_INTERVAL_SECONDS ?? "86400") * 1000; // default 24h
    if (!dueForReap(state.lastRunAt, now, intervalMs)) return;

    // Claim the run first so concurrent requests don't double-fire.
    await putJson(env, GC_CURSOR_KEY, { cursor: state.cursor, lastRunAt: now });
    await runReaper(env, state.cursor, now);
  } catch (e) {
    console.error("reaper: maybeReap failed", e);
  }
}

async function runReaper(env: Env, cursor: string | undefined, claimedAt: number): Promise<void> {
  const ttlMs = Number(env.PROFILE_TTL_SECONDS ?? "31536000") * 1000; // default 365d
  const cap = Number(env.GC_MAX_PREFIXES_PER_RUN ?? "500");
  const result = await reapOrphanProfiles(
    env.BUCKET,
    (friendId) => purgeFriendScoped(env, friendId),
    { nowMs: Date.now(), ttlMs, cap, cursor },
  );
  // Preserve the claim timestamp; advance the cursor for the next run.
  await putJson(env, GC_CURSOR_KEY, { cursor: result.nextCursor, lastRunAt: claimedAt });
  console.log(`reaper: purged ${result.reaped.length} orphan profile(s)`);

  // Retention hygiene for the moderation queue, which nothing else prunes. Its own
  // TTL, because a safety record should outlive an inactive profile folder.
  const reportTtlMs = Number(env.REPORT_TTL_SECONDS ?? "31536000") * 1000; // default 365d
  const dropped = await reapOldReports(
    env.BUCKET,
    (keys) => env.BUCKET.delete(keys),
    { nowMs: Date.now(), ttlMs: reportTtlMs, cap },
  );
  if (dropped.length) console.log(`reaper: pruned ${dropped.length} expired report(s)`);
}

// ── R2 helpers ─────────────────────────────────────────────────────────────

async function getText(env: Env, key: string): Promise<string | null> {
  const obj = await env.BUCKET.get(key);
  return obj ? await obj.text() : null;
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}

async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function putRaw(env: Env, key: string, body: string): Promise<void> {
  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });
}

// Lightweight per-IP hourly rate limit backed by R2 (one tiny object per
// ip+hour bucket; `rl/` should carry a 1-day lifecycle rule to self-clean).
async function rateLimited(env: Env, scope: string, ip: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const key = `rl/${scope}/${ip}/${currentHour()}.json`;
  const rec = await getJson<{ n: number }>(env, key);
  const count = rec?.n ?? 0;
  if (count >= limit) return true;
  await putJson(env, key, { n: count + 1 });
  return false;
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13);
}

// ── Auth: trust-on-first-use owner binding + read token ──────────────────────

/**
 * Owner binding for a friendId. `h` = sha256(writeSecret).
 * Read tokens are split (0a-3) so un-friending can revoke without a bootstrap
 * deadlock: `ta` is stable and gates `access.json` only; `tc` is rotatable and
 * gates `profile.json` + `opinions/*`. `t` is the legacy single token (pre-0a-3),
 * read as both when `ta`/`tc` are absent.
 */
interface OwnerRecord {
  h: string;
  t?: string;
  ta?: string;
  tc?: string;
}

/** Effective stable (access) read token, honouring the legacy single token. */
const effTa = (rec: OwnerRecord): string | undefined => rec.ta ?? rec.t;
/**
 * Effective rotatable (profile/opinions) read token. Falls back to the legacy
 * single token, then to `ta`, so an author who bound only `ta` (a pre-0a-3 client
 * against this worker) is still readable during rollout. A real 0a-3 author always
 * binds `tc`, so this fallback never weakens their rotation-based revocation.
 */
const effTc = (rec: OwnerRecord): string | undefined => rec.tc ?? rec.t ?? rec.ta;

const ownerKey = (friendId: string) => `${friendId}/owner.json`;

/**
 * Owner-auth result. `created` is true when this call had to freshly create
 * `owner.json` (trust-on-first-use) — the signal that the relay had lost this
 * identity's data (e.g. reaped after inactivity), so the client should re-publish.
 */
interface OwnerAuth {
  ok: boolean;
  created: boolean;
}

/** Owner-authenticate a write. Binds the secret on first use; verifies after. */
async function verifyOwner(env: Env, friendId: string, secret: string | null): Promise<OwnerAuth> {
  if (!secret) return { ok: false, created: false };
  const hash = await sha256hex(secret);
  const existing = await getJson<OwnerRecord>(env, ownerKey(friendId));
  if (!existing) {
    await putJson(env, ownerKey(friendId), { h: hash });
    return { ok: true, created: true };
  }
  return { ok: existing.h === hash, created: false };
}

/**
 * Read-gate: the presented token must match the author's bound read token for the
 * given slot — `"a"` for access.json (stable `ta`), `"c"` for profile/opinions
 * (rotatable `tc`). A rotated `tc` therefore 403s a stale reader immediately.
 */
async function verifyReadToken(
  env: Env,
  friendId: string,
  token: string | null,
  which: "a" | "c",
): Promise<boolean> {
  if (!token) return false;
  const rec = await getJson<OwnerRecord>(env, ownerKey(friendId));
  if (!rec) return false;
  const bound = which === "a" ? effTa(rec) : effTc(rec);
  return !!bound && bound === token;
}

// ── Social handlers ──────────────────────────────────────────────────────────

/**
 * The etag a client read back from a GET, in the form `onlyIf.etagMatches` wants:
 * bare hex, no `W/` prefix and no quotes.
 *
 * Both wrappers have to go, and for different reasons. Cloudflare rewrites strong
 * etags to weak ones (`W/"…"`) on the way out through the CDN, so the value a
 * client echoes back never equals the strong etag R2 compares against. And R2
 * *throws* on a quoted value rather than simply not matching it — even though the
 * quoted form is exactly what `httpEtag` hands back. Passing the header through
 * verbatim therefore fails 100% of the time: it 409'd on the weak form, and
 * 500'd once the prefix alone was stripped.
 *
 * Clients in the field send the weak quoted form and cannot be fixed
 * retroactively, so the normalisation belongs here.
 */
function strongEtag(value: string | null): string | null {
  const v = value?.trim().replace(/^W\//, "").replace(/"/g, "");
  return v ? v : null;
}


// Ambient profile fan-out. With push topics this is O(1): publish one message to
// the owner's friend-topic and Google delivers it to every subscribed friend on
// every device. Only a pre-topics owner (no `friendTopic` yet) falls back to the
// legacy per-friend token loop, which self-resolves once the owner republishes
// `push.json` within the client's ~3-day heartbeat.
// GET access.json / profile.json — read-token-gated; returns stored ciphertext.
// PUT one encrypted opinion, located by its blind index hash. Owner-auth.
// DELETE one opinion (true removal on tombstone). Owner-auth.
// ── Profile pictures + reports ──────────────────────────────────────────────
// All picture-domain objects live in the social bucket alongside E2EE user data
// so the flickto-web admin panel can bind the same bucket for review/takedown:
//   pics/{friendId}/picture.jpg           — the image bytes
//   pics/{friendId}/meta.json             — { version, contentType, sha256, verdict }
//   _moderation/{friendId}.json           — takedown tombstone (auto or admin)
//   _reports/{targetId}/{ts}-{reporter}.json — one report record
const MAX_PICTURE_BYTES = 512 * 1024;

/**
 * The cap for an animated avatar, which is a Premiere feature.
 *
 * Four times the still cap because animation is many frames of the same picture and
 * 512 KB buys about a second of anything watchable. It is an ALLOWANCE, not a
 * replacement: a still image is held to [MAX_PICTURE_BYTES] exactly as before, so
 * nothing about the existing path changes.
 */
const MAX_ANIMATED_PICTURE_BYTES = 2 * 1024 * 1024;
const picKey = (friendId: string) => `${friendId}/pics/picture.jpg`;
const picMetaKey = (friendId: string) => `${friendId}/pics/meta.json`;
const tombstoneKey = (friendId: string) => `_moderation/${friendId}.json`;
/**
 * Report kind for a public `share/{code}` link.
 *
 * Stays here rather than moving to D1 with the other kinds: a share link can be
 * opened, and reported, by someone with no account at all, so there is no session to
 * file it under and no `users.id` to key it on. It keeps its own route and its own
 * target namespace under the `_reports/` prefix — which it is now the only writer of.
 */
const KIND_SHARED_LIST = "shared_list";

interface PictureMeta {
  version: number;
  contentType: string;
  sha256: string;
  verdict: string;
  updatedAt: number;
}

/** Sniff the leading bytes for a supported raster type. Returns a MIME or null. */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) return "image/webp";
  // "GIF87a" / "GIF89a". Added for Premiere animated avatars; still magic-byte sniffed
  // like every other type, because Content-Type is never trusted here.
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && // "GIF"
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) return "image/gif";
  return null;
}

/**
 * Whether these bytes can animate.
 *
 * **All GIFs count**, including single-frame ones. Telling them apart means walking the
 * block structure, and the only cheap approximations over-count — which would gate a
 * still image behind a subscription, the wrong way to be wrong. GIF is a format people
 * choose *for* animation; a user with a still image has PNG and JPEG.
 *
 * WebP is exact: the VP8X extended header carries an animation flag, and a WebP without
 * VP8X cannot animate at all.
 *
 * ⚠️ Animated WebP passed the sniff long before GIF did, so this gate CLOSES a hole
 * rather than opening one — until now a free account could upload one and get an
 * animated avatar. Existing uploads are untouched; only new ones are checked.
 */
export function isAnimatedImage(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "image/gif") return true;
  if (contentType !== "image/webp") return false;
  return (
    bytes.length >= 21 &&
    bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58 && // "VP8X"
    (bytes[20] & 0x02) !== 0 // animation bit
  );
}

// PUT the owner's profile picture. Owner-auth (same secret + read token that
// gates profile.json). Scans the bytes before storing; a flagged image is never
// persisted or shared. A fresh upload clears any prior takedown tombstone.
// GET a profile picture. Public — the opaque friendId is the capability, so Coil
// loads it with no custom headers. A takedown tombstone yields 410.
async function handleGetPicture(friendId: string, env: Env): Promise<Response> {
  const tomb = await env.BUCKET.get(tombstoneKey(friendId));
  if (tomb) return new Response("gone", { status: 410, headers: { ...CORS } });
  const obj = await env.BUCKET.get(picKey(friendId));
  if (!obj) return new Response("not found", { status: 404, headers: { ...CORS } });
  const contentType = obj.httpMetadata?.contentType ?? "image/jpeg";
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...CORS,
    },
  });
}

// DELETE the owner's own picture. Owner-auth.
// ── Account-keyed profile pictures (step 3 of the friendId retirement) ───────
// Same bytes, same scan, same tombstone semantics as the relay trio above — but
// keyed on `users.id` and written under a session instead of a relay-issued owner
// secret. The secret WAS the auth scope, which is why this is a new mechanism
// rather than a renamed path parameter.
//
// Stored under an explicit `accounts/` prefix, NOT at the bucket root. Root folders
// there are friendId-shaped and the orphan reaper walks them looking for stale relay
// profiles; a `users.id` folder sitting alongside them is indistinguishable from one,
// and would eventually be reaped out from under a live account.
const accountPicKey = (userId: string) => `accounts/${userId}/picture.jpg`;
const accountPicMetaKey = (userId: string) => `accounts/${userId}/picture-meta.json`;

/**
 * Takedown tombstone, account-keyed.
 *
 * ⚠️ Both hide paths must write this **and** the legacy `_moderation/{friendId}.json`
 * for as long as `handleGetPicture` still serves reads. They are two doors to the same
 * image: a hide that wrote only one would leave the other serving it, which is an abuse
 * control silently removed rather than a cosmetic inconsistency. The legacy write goes
 * when the legacy route goes, not before.
 */
const accountTombstoneKey = (userId: string) => `_moderation/u/${userId}.json`;

/**
 * PUT /api/me/picture — session-authed upload of the raw image bytes.
 *
 * Deliberately identical to [handlePutPicture] in everything but auth and key: the
 * size cap, the type sniff, the SafeSearch scan and the "a fresh upload clears any
 * prior takedown" rule are all abuse controls, and a second upload path that enforced
 * a subset of them would be a way around them.
 */
async function handlePutMyPicture(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, { status: 401 });

  // No friendId hop: the session already names the account the suspension is on.
  const suspended = await postingSuspendedUntil(env.DB, session.userId);
  if (suspended > 0) return json(suspendedBody(suspended), { status: 403 });

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0) return invalidJson();

  const contentType = sniffImageType(buf);
  if (!contentType) return json({ error: "unsupported_type" }, { status: 400 });

  // ── Animated avatars are a Premiere feature, enforced HERE and not on the client ──
  //
  // The client gates its own picker too, but that is a courtesy to the user, not a
  // control: anyone can post bytes to this route with a session. This is the check that
  // decides, and it reads `users.premiere_until`, which no request body can reach.
  const animated = isAnimatedImage(contentType, buf);
  if (animated) {
    const row = await env.DB
      .prepare("SELECT premiere_until, premiere_comp_until FROM users WHERE id = ?")
      .bind(session.userId)
      .first<{ premiere_until: number | null; premiere_comp_until: number | null }>();
    if (!isPremiere(row)) return json({ error: "premiere_required" }, { status: 402 });
  }
  if (buf.byteLength > (animated ? MAX_ANIMATED_PICTURE_BYTES : MAX_PICTURE_BYTES)) return tooLarge();

  // ⚠️ SafeSearch sees the FIRST FRAME ONLY. Google's API documents that for animated
  // GIF, and a Worker has no image decoder to hand it anything else — reconstructing a
  // later frame means an LZW decode against a 10 ms CPU budget.
  //
  // Accepted rather than solved, because the exposure is narrow and the compensations
  // are real: animated upload requires a subscription, so the uploader has a payment
  // identity and something to lose; the first frame is still scanned, which catches the
  // careless case; and the report → auto-hide path (`maybeAutoHidePicture`) is what
  // actually covers deliberate abuse, as it already does for stills.
  const result = await moderateImage(buf, env);
  if (!result.allowed) {
    return json({ error: "rejected", categories: result.categories }, { status: 422 });
  }

  const version = Date.now();
  await env.BUCKET.put(accountPicKey(session.userId), buf, { httpMetadata: { contentType } });
  const meta: PictureMeta = {
    version,
    contentType,
    sha256: await sha256hexBytes(buf),
    verdict: result.verdict,
    updatedAt: version,
  };
  await env.BUCKET.put(accountPicMetaKey(session.userId), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
  // A new image supersedes any earlier auto/admin takedown — both spellings of it,
  // since either hide path may have written either key.
  await env.BUCKET.delete(accountTombstoneKey(session.userId));

  // Records what this picture IS, so a lapse can stop serving it. Set on every upload,
  // not just animated ones — replacing a GIF with a JPEG has to clear the flag, or the
  // still would go on being suppressed after the subscription ended.
  await env.DB.prepare("UPDATE users SET picture_animated = ? WHERE id = ?")
    .bind(animated ? 1 : 0, session.userId)
    .run();

  ctx.waitUntil(fanOutAccountProfileUpdate(env, session.userId));

  const url = `https://flickto.app/api/profile/${session.userId}/picture?v=${version}`;
  return json({ ok: true, url, version });
}

/**
 * GET /api/profile/{userId}/picture. Public and unauthenticated **by design** — Coil
 * loads it with no custom headers, so requiring one would break every avatar in the
 * app rather than degrade it. A takedown tombstone yields 410, same as the relay route.
 *
 * There is no fallback to the relay key. Bytes uploaded by an older build live under
 * `{friendId}/pics/`, and the `picture_url` stored for them still points at the relay
 * route, which still serves — so nothing reaches this handler expecting them.
 */
async function handleGetAccountPicture(userId: string, env: Env): Promise<Response> {
  const tomb = await env.BUCKET.get(accountTombstoneKey(userId));
  if (tomb) return new Response("gone", { status: 410, headers: { ...CORS } });
  const obj = await env.BUCKET.get(accountPicKey(userId));
  if (!obj) return new Response("not found", { status: 404, headers: { ...CORS } });
  const contentType = obj.httpMetadata?.contentType ?? "image/jpeg";
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...CORS,
    },
  });
}

/** DELETE /api/me/picture — session-authed removal of my own picture. */
async function handleDeleteMyPicture(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, { status: 401 });
  await env.BUCKET.delete(accountPicKey(session.userId));
  await env.BUCKET.delete(accountPicMetaKey(session.userId));
  await env.DB.prepare("UPDATE users SET picture_animated = 0 WHERE id = ?").bind(session.userId).run();
  return json({ ok: true });
}

/**
 * One FCM message to the owner's
 * friend topic so friends refetch the profile and pick up the new picture URL.
 *
 * Falls back to the relay push record for the same reason [notifyAccount] does: every
 * install predating `PUT /api/me/push` published only `{friendId}/push.json`, and
 * treating "no topics on the account" as "unreachable" would silently stop friends
 * being told anything changed.
 */
async function fanOutAccountProfileUpdate(env: Env, userId: string): Promise<void> {
  try {
    const config = fcmConfig(env);
    if (!config) return;
    const account = await readAccountPush(env.DB, userId);
    if (!account) return;
    const target = pickFcmTarget(account, "friend");
    if (!target) return;
    // The friendId while one exists: it is the tag the client correlates on, not an
    // addressing decision. Same rule as notifyAccount.
    await sendFcmMessage(config, target, userId, "social_update");
  } catch (e) {
    console.error("Failed to fan out account profile update", e);
  }
}

// The relay report handler that lived here is gone — reports are D1 now
// (`handleReport` in friends.ts, reached via `POST /api/report`), where they are
// session-authenticated, keyed on `users.id`, and readable by the admin panel.
//
// Its picture auto-hide moved with it, unchanged in behaviour: distinct open
// `picture` reports counted against REPORT_AUTOHIDE, writing the same
// `_moderation/{friendId}.json` tombstone that `handleGetPicture` checks for a 410.
//
// The `_reports/` R2 prefix is now written only by share-link reports
// (`handleShareReport`), which are anonymous by design and have no account to key on.

/**
 * Resolve a session **without requiring one**. Returns the account id, or null for
 * an absent, malformed or expired token — never throws and never 401s.
 *
 * Used by the two share-link paths that are open to the whole internet: creating a
 * link (which stamps `creatorId` when it can) and reporting one (where a session
 * upgrades the report from "queue for review" to "counts toward autohide").
 */
async function runOptionalSession(req: Request, env: Env): Promise<string | null> {
  if (!req.headers.get("Authorization")) return null;
  try {
    const session = await resolveSession(req, env as any);
    return session?.userId ?? null;
  } catch {
    return null;
  }
}

/** Marker reporter id for a report filed with no session. Never counted (see below). */
const ANON_REPORTER = "anon";

/**
 * `POST /api/share/{code}/report` — report a public share link.
 *
 * **Deliberately open to anonymous callers.** The landing page is served to anyone,
 * and the people most likely to see an abusive link were sent it in a group chat and
 * have no account at all. Gating on sign-in would leave the main audience with no
 * route, so this answers 204 (or 429) and never 401.
 *
 * That makes it a spam target, so an anonymous report **cannot hide anything**:
 *
 * - every report lands in the admin queue (`_reports/`, the same prefix and record
 *   shape the picture reports use, so the existing admin listing shows it unchanged);
 * - only **distinct signed-in reporters** count toward [Env.REPORT_AUTOHIDE], so an
 *   anonymous flood summons a human rather than performing a takedown;
 * - anonymous callers are rate-limited per IP by the same helper `handleCreate` uses.
 *
 * A report against an unknown or already-expired code is a silent no-op, not a 404:
 * answering differently would turn this into a probe for which codes exist.
 */
async function handleShareReport(code: string, req: Request, env: Env): Promise<Response> {
  const reporter = await runOptionalSession(req, env);
  if (!reporter) {
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
    if (await rateLimited(env, "sharereport", ip, limit)) {
      return json({ error: "rate_limited" }, { status: 429 });
    }
  }

  let body: { reason?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // A bodyless report is fine — the reason is optional.
  }

  const stored = await getJson<StoredShare>(env, `share/${code}.json`);
  if (!stored) return new Response(null, { status: 204, headers: CORS });

  const at = Date.now();
  const reporterId = reporter ?? ANON_REPORTER;
  await putJson(env, `_reports/${code}/${at}-${reporterId}.json`, {
    kind: KIND_SHARED_LIST,
    targetFriendId: code,
    reporterId,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 2000) : "",
    context: stored.title,
    at,
    resolved: false,
  });

  // Only a signed-in reporter can move the counter. An unauthenticated POST that
  // could hide a link would let anyone take down any link by volume — this is the
  // property that stops the open endpoint becoming a takedown weapon.
  if (reporter && !stored.hidden) {
    const threshold = Number(env.REPORT_AUTOHIDE ?? "3");
    if ((await distinctAuthenticatedReporters(env, code)) >= threshold) {
      await putJson(env, `share/${code}.json`, { ...stored, hidden: true });
    }
  }

  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Distinct signed-in reporters against one target, from the `_reports/` filenames —
 * the same `{at}-{reporter}` layout and the same parse the picture autohide uses.
 * [ANON_REPORTER] is excluded, which is what keeps anonymous reports advisory.
 */
async function distinctAuthenticatedReporters(env: Env, target: string): Promise<number> {
  const listed = await env.BUCKET.list({ prefix: `_reports/${target}/` });
  const reporters = new Set<string>();
  for (const o of listed.objects) {
    const name = o.key.split("/").pop() ?? "";
    const who = name.replace(/\.json$/, "").split("-").slice(1).join("-");
    if (who && who !== ANON_REPORTER) reporters.add(who);
  }
  return reporters.size;
}

/** sha256 hex over raw bytes (the string variant hashes UTF-8 text). */
async function sha256hexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface BatchQuery {
  friendId?: unknown;
  hash?: unknown;
  readToken?: unknown;
}
interface OpinionFile {
  ciphertext?: unknown;
}

// Fetch many friends' opinions for one title in a single call. Each entry is
// read-token-gated; the blind hash differs per author, so callers send one per
// friend. The relay never learns the tmdbId (only opaque hashes).
async function handleOpinionsBatch(req: Request, env: Env): Promise<Response> {
  let body: { items?: unknown };
  try {
    body = (await req.json()) as { items?: unknown };
  } catch {
    return invalidJson();
  }
  const items = Array.isArray(body.items) ? (body.items as BatchQuery[]) : null;
  if (!items) return json({ error: "invalid_payload" }, { status: 400 });

  const out: Array<{ friendId: string; hash: string; ciphertext: string }> = [];
  for (const it of items.slice(0, MAX_BATCH_ITEMS)) {
    const friendId = typeof it.friendId === "string" ? it.friendId : "";
    const hash = typeof it.hash === "string" ? it.hash : "";
    const readToken = typeof it.readToken === "string" ? it.readToken : "";
    if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) continue;
    if (!new RegExp(`^${HASH}$`).test(hash)) continue;
    // Opinions are gated by the live rotatable `tc` (owner.json), NOT the token
    // stamped on the object: opinion objects are not re-PUT on rotation, so their
    // customMetadata goes stale — a removed friend's revoked tc must still 403 here
    // (0a-3). That is one owner.json read + one object read per friend; the client
    // chunks the batch so a request never approaches the 50-subrequest cap.
    if (!(await verifyReadToken(env, friendId, readToken, "c"))) continue;
    const obj = await env.BUCKET.get(`${friendId}/opinions/${hash}.json`);
    if (!obj) continue;
    try {
      const file = (await obj.json()) as OpinionFile;
      if (file && typeof file.ciphertext === "string") {
        out.push({ friendId, hash, ciphertext: file.ciphertext });
      }
    } catch {
      // skip malformed
    }
  }
  return json({ items: out });
}




// Keep an acked item this long so a device offline for a few days still learns the
// ack (and dismisses its own copy) rather than re-showing a resolved request.
// Unacked items expire here — nobody ever actioned them.







interface FreshnessQuery {
  friendId?: unknown;
  readToken?: unknown;
  since?: unknown;
  keyEpoch?: unknown;
}

/**
 * The R2 half of `POST /api/sync`: the batched freshness scan plus this device's
 * inbox, in the same inbound request as the D1 reads.
 *
 * Authorization is unchanged and still per-object — the freshness scan checks each
 * author's rotatable read token, and the inbox needs the owner's own secret. Holding
 * a session grants nothing here; a caller who omits `feedSecret` simply gets no
 * inbox back rather than an error, because the relay half is optional by design.
 */
async function loadRelay(env: Env, relay: RelayRequest): Promise<RelayResponse> {
  const requesterId =
    typeof relay.requesterId === "string" && new RegExp(`^${FRIEND_ID}$`).test(relay.requesterId)
      ? relay.requesterId
      : "";
  // The freshness scan is gone (step 7). It reported which friends' `profile.json` had
  // changed and handed back a sealed key-rotation slot; nothing publishes or reads those
  // objects now, and the slot's last live payload — the friend push topic — rides the
  // friend card. What remains is the live friends+block record, which is unrelated to it.
  void requesterId;
  const self =
    relay.selfLookupKey && new RegExp(`^${LOOKUP_KEY}$`).test(relay.selfLookupKey)
      ? await getJson<SelfRecord>(env, `self/${relay.selfLookupKey}.json`).then((r) =>
          r ? { ciphertext: r.ciphertext, version: r.version } : null,
        )
      : null;
  return { self };
}


/** Blind index of a friendId for access.json slots — matches the client's derivation. */
async function accessSlotHash(friendId: string): Promise<string> {
  return sha256hex(`access-slot:${friendId}`);
}

// `handleFreshness` and `freshnessItems` are gone (step 7), with the objects they read.
// The scan reported which friends' profile.json had changed and returned a sealed
// key-rotation slot. Nothing publishes or reads a relay profile now, and the slot's last
// live payload -- the friend push topic -- rides the friend card instead.
//
// The `/api/social/*` route pattern stays: `self`, `backup` and `delete` still serve
// through it.

interface FcOwnerRecord {
  c: string;
}

/**
 * Publish my public friend card under a short, stable code. Session-authenticated
 * (step 4 of the friendId retirement) — the owner secret it replaced meant the
 * friendId WAS the auth scope.
 *
 * The card holds only public pairing info — no secrets — and is stored under the
 * CODE, which does not move: printed QR codes, shared links and codes people have
 * written down all resolve through `fc/{code}.json`. Only the reverse pointer moves.
 */
async function handlePublishFriendCode(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, { status: 401 });

  const raw = await req.text();
  if (raw.length > MAX_CARD_BYTES) return tooLarge();
  let card: Record<string, unknown>;
  try {
    card = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return invalidJson();
  }
  const friendId = typeof card.friendId === "string" ? card.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return json({ error: "invalid_card" }, { status: 400 });

  // Stamped from the session, never taken from the body. `resolveCardOwner` trusts this
  // field to address a match request, and the card is client-written — so a body that
  // named someone else's account would have pointed everyone who scanned this code at
  // them. The auth swap is what makes stamping it possible.
  card.serverUserId = session.userId;
  const body = JSON.stringify(card);

  const owner = await env.DB.prepare("SELECT friend_code FROM users WHERE id = ?")
    .bind(session.userId)
    .first<{ friend_code: string | null }>();

  // ⚠️ PRESERVES an existing code. An account that already has one keeps it; only a
  // genuinely new account mints. Minting over an existing code silently breaks every
  // link and QR the user has already shared, which is why this reads before it writes.
  //
  // The `{friendId}/friendcode.json` legacy pointer that sat between these two is gone
  // with `users.friend_code`'s predecessor (8c-3). It was already resolving to nothing:
  // measured 2026-07-30, the two accounts that would have used it had no such object —
  // step 7's purge had taken them. They mint a fresh code on their next publish.
  const code = owner?.friend_code ?? (await generateUniqueFriendCode(env));

  const existingCard = await getText(env, `fc/${code}.json`);
  if (existingCard !== body) await putRaw(env, `fc/${code}.json`, body);
  if (owner?.friend_code !== code) {
    await env.DB.prepare("UPDATE users SET friend_code = ? WHERE id = ?").bind(code, session.userId).run();
  }

  return json({
    code,
    expiresAt: new Date(Date.now() + FRIENDCODE_TTL * 1000).toISOString(),
  });
}

async function handleGetFriendCode(code: string, env: Env): Promise<Response> {
  const raw = await getText(env, `fc/${code}.json`);
  return raw ? rawJson(raw) : notFound();
}

/**
 * The public card a device published — the R2 half of `POST /api/friends/cards`.
 *
 * ONE get when the account's `friend_code` is known, because that arrives in the
 * `users` query the caller already runs; the second get is the legacy path, reading
 * the friendId-keyed pointer for an account that has not republished since the code
 * moved to D1. Subrequests are the binding constraint, so the common case is halved.
 *
 * Returns only the pairing fields. ⚠️ The stored card is CLIENT-WRITTEN and nothing
 * here may be trusted beyond being public. The claim-check against
 * `users.friend_id` that `handleGetFriendCards` used to apply went with that column
 * (8c-3), so a card's self-declared friendId is now unverified — see the note there.
 */
async function loadPublicCard(env: Env, friendCode: string | null): Promise<PublicCard | null> {
  if (!friendCode) return null;
  const code = friendCode;
  const card = await getJson<Record<string, unknown>>(env, `fc/${code}.json`);
  if (!card || typeof card.friendId !== "string" || typeof card.publicKeyset !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    friendId: card.friendId,
    publicKeyset: card.publicKeyset,
    feedReadToken: str(card.feedReadToken),
    displayName: str(card.displayName),
    avatarId: str(card.avatarId),
    borderId: str(card.borderId),
    pictureUrl: str(card.pictureUrl),
  };
}

/**
 * The account that published friend card [code], or null.
 *
 * Injected into `POST /api/match/request` so a stranger match can be gated on
 * having actually seen someone's code. **This is spam control, not a proximity
 * proof** — the same card is published under the shareable friend code that goes
 * in invite links, so holding it says nothing about being in the room. What makes
 * the stranger path safe is the exchange order, not this check.
 */
/**
 * Wake every device belonging to account [userId] so it syncs immediately.
 *
 * The D1 half of this Worker knows accounts (`users.id`); push topics are keyed by
 * the **device friendId** and the record lives in R2. This bridges the two, which is
 * why it lives here and is injected into `lists.ts`/`match.ts` rather than imported
 * by them — those stay D1-only by design.
 *
 * **Sends `inbox_update` deliberately, despite nothing arriving in the inbox.** That
 * is the signal already-shipped clients turn into an immediate
 * `WorkScheduler.scheduleSocialSyncNow` (`SocialMessagingService`), and
 * `SocialSyncWorker` now reads the D1 lists and handshakes in the same pass. Inventing
 * a new `type` would be tidier and would reach **no device in the field** until they
 * updated — the whole point of this fix is that it works on the build people already
 * have. Treat it as "wake up and sync", not as a claim about the inbox.
 *
 * Best-effort throughout: a share that was delivered must not fail because a push did.
 */

async function resolveCardOwner(env: Env, code: string): Promise<string | null> {
  const card = await getJson<{ serverUserId?: unknown }>(env, `fc/${code}.json`);
  const owner = card && typeof card.serverUserId === "string" ? card.serverUserId : "";
  return owner || null;
}

// ── Portable identity backup ──────────────────────────────────────────────────
// Zero-knowledge: the relay stores ciphertext under a blind-index lookup key the
// owner derives from their recovery code (HKDF). The relay can neither read the
// bundle nor link it to a friendId. Possession of the unguessable lookup key is
// the only authorization needed — only the owner can derive it.

async function handlePutBackup(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_BACKUP_BYTES) return tooLarge();
  let parsed: { lookupKey?: unknown; ciphertext?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalidJson();
  }
  const lookupKey = typeof parsed.lookupKey === "string" ? parsed.lookupKey : "";
  const ciphertext = typeof parsed.ciphertext === "string" ? parsed.ciphertext : "";
  if (!new RegExp(`^${LOOKUP_KEY}$`).test(lookupKey) || !ciphertext) {
    return json({ error: "invalid_payload" }, { status: 400 });
  }
  await putJson(env, `backup/${lookupKey}.json`, { ciphertext });
  return json({ ok: true });
}

async function handleGetBackup(lookupKey: string, env: Env): Promise<Response> {
  const rec = await getJson<{ ciphertext: string }>(env, `backup/${lookupKey}.json`);
  return rec ? json({ ciphertext: rec.ciphertext }) : notFound();
}

async function handleDeleteBackup(lookupKey: string, env: Env): Promise<Response> {
  await env.BUCKET.delete(`backup/${lookupKey}.json`);
  return json({ ok: true });
}

// ── Live friends+block record ───────────────────────────────────────────────
// Per-user encrypted friend + block list, kept current across the user's own
// devices. The relay stores ciphertext only — it never sees who is friends with
// whom. Optimistic concurrency: the writer presents the version it based its
// edit on; a mismatch returns 409 so the client re-pulls, LWW-merges, retries.

interface SelfRecord {
  ciphertext: string;
  version: number;
}

async function handleGetSelf(lookupKey: string, env: Env): Promise<Response> {
  const rec = await getJson<SelfRecord>(env, `self/${lookupKey}.json`);
  return rec ? json({ ciphertext: rec.ciphertext, version: rec.version }) : notFound();
}

async function handlePutSelf(lookupKey: string, req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_SELF_BYTES) return tooLarge();
  let parsed: { ciphertext?: unknown; baseVersion?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalidJson();
  }
  const ciphertext = typeof parsed.ciphertext === "string" ? parsed.ciphertext : "";
  const baseVersion = typeof parsed.baseVersion === "number" ? parsed.baseVersion : NaN;
  if (!ciphertext || !Number.isFinite(baseVersion)) {
    return json({ error: "invalid_payload" }, { status: 400 });
  }
  const existing = await getJson<SelfRecord>(env, `self/${lookupKey}.json`);
  const currentVersion = existing?.version ?? 0;
  if (baseVersion !== currentVersion) {
    return json({ error: "version_conflict", version: currentVersion }, { status: 409 });
  }
  const next: SelfRecord = { ciphertext, version: currentVersion + 1 };
  await putJson(env, `self/${lookupKey}.json`, next);
  return json({ ok: true, version: next.version });
}

async function handleDeleteSelf(lookupKey: string, env: Env): Promise<Response> {
  await env.BUCKET.delete(`self/${lookupKey}.json`);
  return json({ ok: true });
}

// ── Account / data deletion ───────────────────────────────────────────────────

// Remove every object stored under a friendId prefix, plus the public friend
// card it points at. Returns the number of relay objects removed.
async function purgeFriendScoped(env: Env, friendId: string): Promise<number> {
  const fc = await getJson<FcOwnerRecord>(env, `${friendId}/friendcode.json`);
  let removed = await deletePrefix(env, `${friendId}/`);
  if (fc?.c) {
    await env.BUCKET.delete(`fc/${fc.c}.json`);
    removed += 1;
  }
  return removed;
}

// Owner-authenticated deletion — used by the in-app "Delete my social data"
// action, which holds the write secret. Purges the friendId-scoped relay data
// and, when the caller supplies the blind-index lookup keys it alone can derive,
// the zero-knowledge identity backup and live friends record too.
async function handleSocialDelete(req: Request, env: Env): Promise<Response> {
  let body: { friendId?: unknown; backupLookupKey?: unknown; selfLookupKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return invalidJson();
  }
  const friendId = typeof body.friendId === "string" ? body.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return json({ error: "invalid_request" }, { status: 400 });
  // Deletion endpoint: intentionally does NOT surface ownerRecreated — signaling
  // "republish" while the user is deleting their data would resurrect it.
  if (!(await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"))).ok) return forbidden();

  // Drop the linked-account record (keyed by the reverse pointer under this
  // friendId) before purging the prefix, so the Play data-deletion promise holds.
  await deleteAccountForFriend(env, friendId);
  let removed = await purgeFriendScoped(env, friendId);
  const backupLookupKey = typeof body.backupLookupKey === "string" ? body.backupLookupKey : "";
  const selfLookupKey = typeof body.selfLookupKey === "string" ? body.selfLookupKey : "";
  if (new RegExp(`^${LOOKUP_KEY}$`).test(backupLookupKey)) {
    await env.BUCKET.delete(`backup/${backupLookupKey}.json`);
    removed += 1;
  }
  if (new RegExp(`^${LOOKUP_KEY}$`).test(selfLookupKey)) {
    await env.BUCKET.delete(`self/${selfLookupKey}.json`);
    removed += 1;
  }
  return json({ ok: true, removed });
}

// Web fallback for users who no longer have the app: identify the account by its
// public friend code and purge the friendId-scoped relay data immediately. The
// zero-knowledge backup + friends record are NOT touched here (their blind-index
// keys require the recovery code), so the user's private recovery path stays
// intact and only they — via the in-app reset — can remove it.
async function handleDeleteRequest(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (await rateLimited(env, "delreq", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let body: { code?: unknown };
  try {
    body = (await req.json()) as { code?: unknown };
  } catch {
    return invalidJson();
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!new RegExp(`^${FRIEND_CODE}$`).test(code)) return json({ error: "invalid_code" }, { status: 400 });

  const card = await getJson<{ friendId?: unknown }>(env, `fc/${code}.json`);
  const friendId = card && typeof card.friendId === "string" ? card.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return notFound();

  const removed = await purgeFriendScoped(env, friendId);
  return json({ ok: true, removed });
}

// List + delete every object under a prefix, following the R2 list cursor.
async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix, cursor });
    if (listed.objects.length) {
      await env.BUCKET.delete(listed.objects.map((o) => o.key));
      removed += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return removed;
}

// ── Share links ──────────────────────────────────────────────────────────────

async function handleCreate(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (await rateLimited(env, "share", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let payload: SharePayload;
  try {
    payload = (await req.json()) as SharePayload;
  } catch {
    return invalidJson();
  }
  if (!payload || typeof payload.title !== "string") {
    return json({ error: "invalid_payload" }, { status: 400 });
  }

  const kind = payload.kind === "smart" ? "smart" : "manual";
  const title = payload.title.slice(0, 120);
  const maxItems = Number(env.MAX_ITEMS ?? "100");

  let items: ShareItem[] = [];
  let filters: unknown | null = null;

  if (kind === "smart") {
    if (!payload.filters || typeof payload.filters !== "object") {
      return json({ error: "invalid_filters" }, { status: 400 });
    }
    if (JSON.stringify(payload.filters).length > MAX_FILTERS_BYTES) {
      return json({ error: "filters_too_large" }, { status: 400 });
    }
    filters = payload.filters;
  } else {
    if (!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > maxItems) {
      return json({ error: "invalid_payload" }, { status: 400 });
    }
    items = payload.items
      .slice(0, maxItems)
      .map((it) => ({ tmdbId: Number(it.tmdbId) | 0, type: String(it.type).slice(0, 8) }))
      .filter((it) => it.tmdbId > 0);
    if (items.length === 0) return json({ error: "empty_after_validation" }, { status: 400 });
  }

  const ttl = Number(env.SHARE_TTL_SECONDS ?? "2592000");
  const code = await generateUniqueCode(env);
  const now = new Date();
  // Attribution when it happens to be available. This endpoint is and stays
  // unauthenticated, so a missing/invalid session is the normal case and must not
  // change the outcome — hence the resolve is best-effort and never gates.
  const creator = await runOptionalSession(req, env);
  const stored: StoredShare = {
    kind,
    title,
    items,
    filters,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    views: 0,
    creatorId: creator,
  };
  await putJson(env, `share/${code}.json`, stored);
  return json({ code, expiresAt: stored.expiresAt });
}

async function handleGet(code: string, env: Env): Promise<Response> {
  const stored = await getJson<StoredShare>(env, `share/${code}.json`);
  if (!stored || isExpired(stored) || stored.hidden) return notFound();
  return json(normalizeStored(stored));
}

async function handleLanding(code: string, env: Env): Promise<Response> {
  const stored = await getJson<StoredShare>(env, `share/${code}.json`);
  // A hidden link is indistinguishable from an expired one, deliberately and to
  // the byte — same status, same body. See [StoredShare.hidden].
  if (!stored || isExpired(stored) || stored.hidden) return html(landingNotFound(), { status: 404 });
  // Read-only render: does not increment views (that's the app's /api GET).
  return html(landingPage(code, normalizeStored(stored)));
}

function isExpired(s: { expiresAt?: string }): boolean {
  return !!s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
}

// ── Utilities ────────────────────────────────────────────────────────────────

async function sha256hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Back-fills fields absent on shares stored before the kind/filters split.
function normalizeStored(parsed: any): StoredShare {
  return {
    kind: parsed.kind === "smart" ? "smart" : "manual",
    title: typeof parsed.title === "string" ? parsed.title : "Shared list",
    items: Array.isArray(parsed.items) ? parsed.items : [],
    filters: parsed.filters ?? null,
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    expiresAt: parsed.expiresAt ?? new Date().toISOString(),
    views: Number(parsed.views ?? 0),
  };
}

// Deliberately NOT normalized onto the wire: this builds the *public* shape, and
// `creatorId` would hand the creator's account id to anyone holding the link.
// Both `hidden` and `creatorId` are read straight off the stored object by the
// handlers that need them.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

async function generateUniqueCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    if (!(await env.BUCKET.head(`share/${code}.json`))) return code;
  }
  return randomCode(8);
}

async function generateUniqueFriendCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    if (!(await env.BUCKET.head(`fc/${code}.json`))) return code;
  }
  return randomCode(8);
}

function randomCode(length: number): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

function landingPage(code: string, stored: StoredShare): string {
  const intentUrl =
    `intent://share/${code}#Intent;scheme=flickto;package=${APP_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
  const subtitle =
    stored.kind === "smart"
      ? "Smart list · rebuilds on your device"
      : `${stored.items.length} title${stored.items.length === 1 ? "" : "s"}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${htmlEscape(stored.title)} · FlickTo</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: #0e1014; color: #e8eaf0;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center; padding: 1.5rem;
      }
      .card { max-width: 420px; width: 100%; text-align: center; }
      h1 { font-size: 24px; margin: 0 0 0.25rem; }
      .muted { color: #8a93a6; margin: 0 0 1.75rem; }
      .btn {
        display: block; width: 100%; box-sizing: border-box;
        padding: 0.9rem 1rem; border-radius: 12px; text-decoration: none;
        font-weight: 600; margin-bottom: 0.75rem;
      }
      .primary { background: #ffb547; color: #0e1014; }
      .secondary { background: #1b2030; color: #e8eaf0; }
      .report {
        background: none; border: 0; color: #8a93a6; text-decoration: underline;
        font: inherit; cursor: pointer; margin-top: 1.25rem; padding: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${htmlEscape(stored.title)}</h1>
      <p class="muted">${subtitle}</p>
      <a class="btn primary" id="open" href="${intentUrl}">Open in FlickTo</a>
      <a class="btn secondary" href="${PLAY_STORE_URL}">Get it on Google Play</a>
      <a class="btn secondary" href="${APP_STORE_URL}">Download on the App Store</a>
      <!--
        Whoever is reading this page is the person most likely to have been sent an
        abusive link, and almost never has an account. Requiring one to report would
        leave that audience with no route at all — so this posts anonymously. It
        cannot take the link down on its own; see handleShareReport.
      -->
      <button class="report" id="report">Report this list</button>
    </div>
    <script>
      document.getElementById("report").addEventListener("click", async function () {
        this.disabled = true;
        this.textContent = "Thanks — this has been sent for review";
        try {
          await fetch("/api/share/${code}/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "landing_page" }),
          });
        } catch (e) {
          // The confirmation is deliberately unconditional: a failed POST is not
          // the reporter's problem to solve, and re-enabling the button would only
          // invite a retry loop against a rate limit.
        }
      });
    </script>
    <!--
      No auto-redirect: Chrome blocks gesture-less navigation to an intent://
      URL and falls through to browser_fallback_url (the store). The user taps
      "Open in FlickTo" instead — that gesture is honored and opens the app.
      Links clicked from App-Link-aware apps open the app directly and never
      reach this page.
    -->
  </body>
</html>`;
}

function landingNotFound(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>List not found · FlickTo</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: #0e1014; color: #e8eaf0;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center; padding: 1.5rem; text-align: center;
      }
      a { color: #ffb547; }
    </style>
  </head>
  <body>
    <div>
      <h1>This list expired or doesn't exist</h1>
      <p>Shared lists are kept for 30 days. <a href="${PLAY_STORE_URL}">Get FlickTo</a></p>
    </div>
  </body>
</html>`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Legal / compliance pages (/privacy, /delete) have been moved to static HTML
// files served by the flickto-content worker. The inline templates that were
// here (privacyPage(), deletePage(), LEGAL_CSS) have been extracted to:
//   flickd-content/content/privacy.html
//   flickd-content/content/delete.html

// ⚠️ Re-exported from the worker entry because that is the only place wrangler looks for a
// Durable Object class. A binding whose `class_name` is not exported here fails at DEPLOY
// time with "class not found", never at build or test time.
export { GroupSession };
