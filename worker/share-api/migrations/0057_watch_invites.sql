-- ── Choose Together invites ─────────────────────────────────────────────────
-- "Come and pick something with us": a directed, friends-only invite carrying a
-- live session code.
--
-- Deliberately NOT `match_requests`. That table is the taste handshake — it
-- carries a sealed profile and a retention term, and its accept means "compare
-- what we have watched". This one carries a six-character room code and its
-- accept means "open that room now". Sharing a table would have forced every
-- reader to branch on which kind of thing a row was.
--
-- Shaped after `shared_lists`, which is the same problem already solved: one
-- sender, one recipient, a state, and nothing that outlives the thing it points
-- at. The session itself lives in a Durable Object and deletes itself after two
-- idle hours; a row here can therefore point at a room that is already gone, and
-- that is expected — the client finds out when it tries to join, exactly as it
-- would from a shared link.
CREATE TABLE IF NOT EXISTS watch_invites (
  id           TEXT PRIMARY KEY,
  sender_id    TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  -- The room. Six characters of the session alphabet; see groupWatch.ts.
  code         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending'   -- pending | accepted | declined
);

-- The only read: "who has asked me to choose something with them", newest first.
CREATE INDEX IF NOT EXISTS idx_watch_invites_recipient
  ON watch_invites(recipient_id, state, created_at DESC);

-- ⚠️ One live invite per pair per room, so a host tapping a friend twice does not
-- put two identical rows in their inbox. A NEW room from the same friend is a new
-- invite and must still arrive, which is why the code is part of the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_invites_pair_code
  ON watch_invites(sender_id, recipient_id, code);
