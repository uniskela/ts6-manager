-- Existing bots retain no avatar on upgrade. UI-created bots explicitly use default.
ALTER TABLE "MusicBot" ADD COLUMN "avatarMode" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "MusicBot" ADD COLUMN "avatarFile" TEXT;
ALTER TABLE "MusicBot" ADD COLUMN "avatarMd5" TEXT;
