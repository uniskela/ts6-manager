-- Discord guild → music bot bindings (Phase 2C Step 2).
-- Additive only; does not touch Playlist / nameKey rows.
-- Deploy path remains `prisma db push` (see apply-schema.sh); this file is the
-- checked-in SQL reference (force-add under gitignored migrations/).

CREATE TABLE "DiscordGuildBinding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "serverConfigId" INTEGER NOT NULL,
    "musicBotId" INTEGER NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordGuildBinding_serverConfigId_fkey" FOREIGN KEY ("serverConfigId") REFERENCES "TsServerConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscordGuildBinding_musicBotId_fkey" FOREIGN KEY ("musicBotId") REFERENCES "MusicBot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DiscordGuildBinding_guildId_key" ON "DiscordGuildBinding"("guildId");
CREATE INDEX "DiscordGuildBinding_serverConfigId_idx" ON "DiscordGuildBinding"("serverConfigId");
CREATE INDEX "DiscordGuildBinding_musicBotId_idx" ON "DiscordGuildBinding"("musicBotId");
