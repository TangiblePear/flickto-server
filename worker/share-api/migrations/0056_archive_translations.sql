-- Server-side translations of PARTNER comments.
--
-- Phase 1 shipped without this on purpose ("archive rows get no Workers AI
-- translation in v1"): the 10,000 Neurons/day free allowance was sized for our own
-- corpus, and the archive is one we do not own. What made it affordable is the same
-- thing that makes the native tier affordable — the cache below. The model runs once
-- per comment per language across every reader; every read after that is one indexed
-- `WHERE archive_id IN (…)` batch, which is a subrequest inside a request already paid
-- for, not an AI call. Steady-state spend is therefore proportional to comments newly
-- SEEN, not to reads.
--
-- ⚠️ **A separate table from `comment_translations`, deliberately.** Ids could not
-- collide — partner ids are lowercase UUIDs, ours are `[0-9A-Z:]` — so one table would
-- work mechanically. It is split because §8 forbids persisting other partners'
-- comments, and a translation is derived from one: keeping it here means the partner
-- content we hold can be found, aged out and purged in one place, without touching our
-- own users' rows. The `created_at` sweep below is what that costs.
--
-- ⚠️ `src_hash`, where the native table has `src_updated_at`. Archive rows carry no
-- `updatedAt` — the wire shape has `createdAt` alone — so there is no timestamp to key
-- staleness on. The hash of the source text answers the same question ("is this still
-- the text we translated?") without one. A collision would serve a stale translation of
-- a comment that was edited; it is a 32-bit hash compared only against other versions
-- of the SAME comment, so that is not a risk worth a wider column.
CREATE TABLE IF NOT EXISTS archive_translations (
  archive_id TEXT NOT NULL,           -- the partner's bare UUID, never our prefixed id
  lang       TEXT NOT NULL,           -- target language, base code ('pt', not 'pt-BR')
  text       TEXT NOT NULL,
  src_hash   INTEGER NOT NULL,        -- FNV-1a 32 of the source text
  created_at INTEGER NOT NULL,
  PRIMARY KEY (archive_id, lang)
);

-- For the retention sweep. Nothing reads by age on the hot path — the page read is a
-- primary-key lookup — so this index exists solely so purging does not scan the table.
CREATE INDEX IF NOT EXISTS idx_archive_translations_created
  ON archive_translations(created_at);
