-- Playlist nameKey column (finding #11), stage 1 of 2.
--
-- Authoritative nameKey policy is JavaScript trim()+toLowerCase()
-- (see normalizePlaylistNameKey). Do NOT backfill with SQLite lower() —
-- it is not Unicode-equivalent to JS.
--
-- After this migration on an existing database:
--   1. Run application backfillPlaylistNameKeys() (JS normalisation).
--   2. Run findAllPlaylistNameConflicts(); must be empty.
--   3. Run applyPlaylistNameKeyConstraints() (partial unique indexes +
--      cross-namespace triggers).
--
-- This file does not rename, merge, or delete playlists.
-- Unique indexes / triggers are intentionally omitted here so a conflicting
-- database is not left half-constrained if migrate stops mid-flight.

ALTER TABLE "Playlist" ADD COLUMN "nameKey" TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "Playlist_nameKey_idx" ON "Playlist"("nameKey");
