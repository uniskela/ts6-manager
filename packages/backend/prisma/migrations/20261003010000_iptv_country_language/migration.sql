-- Existing playlists acquire metadata on their next refresh; no backfill.
ALTER TABLE "IptvChannel" ADD COLUMN "tvgCountry" TEXT;
ALTER TABLE "IptvChannel" ADD COLUMN "tvgLanguage" TEXT;
