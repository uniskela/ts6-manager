-- Existing playlists stay hidden from the listener remote until an admin changes them.
ALTER TABLE "Playlist" ADD COLUMN "remoteAccess" TEXT NOT NULL DEFAULT 'hidden';
