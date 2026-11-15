-- Stage 2: apply only after JS backfillPlaylistNameKeys() and a clean
-- findAllPlaylistNameConflicts() report. Kept next to migration.sql for VCS
-- (force-add under gitignored migrations/). Mirrored in playlist-name.ts.

CREATE TRIGGER IF NOT EXISTS "Playlist_nameKey_require_insert"
BEFORE INSERT ON "Playlist"
FOR EACH ROW
WHEN NEW."nameKey" IS NULL OR NEW."nameKey" = ''
BEGIN
  SELECT RAISE(ABORT, 'playlist_namekey_required');
END;

CREATE TRIGGER IF NOT EXISTS "Playlist_nameKey_require_update"
BEFORE UPDATE OF "nameKey" ON "Playlist"
FOR EACH ROW
WHEN NEW."nameKey" IS NULL OR NEW."nameKey" = ''
BEGIN
  SELECT RAISE(ABORT, 'playlist_namekey_required');
END;

CREATE UNIQUE INDEX IF NOT EXISTS "Playlist_server_nameKey_unique" ON "Playlist" ("serverConfigId", "nameKey") WHERE "serverConfigId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Playlist_shared_nameKey_unique" ON "Playlist" ("nameKey") WHERE "serverConfigId" IS NULL;

CREATE TRIGGER IF NOT EXISTS "Playlist_nameKey_block_cross_insert"
BEFORE INSERT ON "Playlist"
FOR EACH ROW
WHEN NEW."nameKey" IS NOT NULL AND NEW."nameKey" != ''
BEGIN
  SELECT RAISE(ABORT, 'playlist_name_conflict')
  WHERE EXISTS (
    SELECT 1 FROM "Playlist" AS p
    WHERE p."nameKey" = NEW."nameKey"
      AND (
        (NEW."serverConfigId" IS NULL AND p."serverConfigId" IS NOT NULL)
        OR (NEW."serverConfigId" IS NOT NULL AND p."serverConfigId" IS NULL)
      )
  );
END;

CREATE TRIGGER IF NOT EXISTS "Playlist_nameKey_block_cross_update"
BEFORE UPDATE OF "nameKey", "serverConfigId" ON "Playlist"
FOR EACH ROW
WHEN NEW."nameKey" IS NOT NULL AND NEW."nameKey" != ''
BEGIN
  SELECT RAISE(ABORT, 'playlist_name_conflict')
  WHERE EXISTS (
    SELECT 1 FROM "Playlist" AS p
    WHERE p."id" != NEW."id"
      AND p."nameKey" = NEW."nameKey"
      AND (
        (NEW."serverConfigId" IS NULL AND p."serverConfigId" IS NOT NULL)
        OR (NEW."serverConfigId" IS NOT NULL AND p."serverConfigId" IS NULL)
      )
  );
END;
