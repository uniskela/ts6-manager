import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  applyGuildBinding,
  formatBindingPreview,
  previewGuildBinding,
} from './guild-bind.js';
import { bootstrapIsolatedDiscordDb, openIsolatedPrisma } from './isolated-db.js';

const GUILD = '111000000000000001';

describe('Discord guild-bind operator workflow (Step 4B)', () => {
  it('preview / bind / status / revoke on temp SQLite; refuses non-isolated writes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-4b-bind-'));
    const databaseUrl = `file:${path.join(root, 'discord-int-test.db')}`;
    try {
      await bootstrapIsolatedDiscordDb({ databaseUrl });
      const { prisma, disconnect } = await openIsolatedPrisma(databaseUrl);
      try {
        const preview = await previewGuildBinding(prisma, {
          action: 'bind',
          databaseUrl,
          guildId: GUILD,
          instanceId: 'discord-int-test',
          serverConfigId: 1,
          musicBotId: 10,
        });
        assert.equal(preview.dryRun, true);
        assert.equal(preview.errors.length, 0);
        assert.equal(preview.botOnServer, true);
        assert.match(formatBindingPreview(preview), /DRY RUN/);

        await assert.rejects(
          () => applyGuildBinding(prisma, {
            action: 'bind',
            databaseUrl: 'file:./data/ts6webui.db',
            confirmWrite: true,
            input: {
              guildId: GUILD,
              instanceId: 'discord-int-test',
              serverConfigId: 1,
              musicBotId: 10,
            },
          }),
          /forbidden|basename|Refusing write/i,
        );

        await assert.rejects(
          () => applyGuildBinding(prisma, {
            action: 'bind',
            databaseUrl: 'file:./data/evil-discord-int-test.db',
            confirmWrite: true,
            input: {
              guildId: GUILD,
              instanceId: 'discord-int-test',
              serverConfigId: 1,
              musicBotId: 10,
            },
          }),
          /basename must be exactly/i,
        );

        const bound = await applyGuildBinding(prisma, {
          action: 'bind',
          databaseUrl,
          confirmWrite: true,
          input: {
            guildId: GUILD,
            instanceId: 'discord-int-test',
            serverConfigId: 1,
            musicBotId: 10,
          },
        });
        assert.equal(bound.row.revoked, false);
        assert.equal(bound.row.musicBotId, 10);

        const status = await previewGuildBinding(prisma, {
          action: 'status',
          databaseUrl,
          guildId: GUILD,
        });
        assert.ok(status.existing && !status.existing.revoked);
        assert.ok(status.lookup && !status.lookup.revoked);

        const badBot = await previewGuildBinding(prisma, {
          action: 'bind',
          databaseUrl,
          guildId: GUILD,
          instanceId: 'discord-int-test',
          serverConfigId: 1,
          musicBotId: 999,
        });
        assert.ok(badBot.errors.some((e) => /not found/i.test(e)));

        const revoked = await applyGuildBinding(prisma, {
          action: 'revoke',
          databaseUrl,
          confirmWrite: true,
          guildId: GUILD,
        });
        assert.equal(revoked.row.revoked, true);

        const after = await previewGuildBinding(prisma, {
          action: 'status',
          databaseUrl,
          guildId: GUILD,
        });
        assert.equal(after.lookup?.revoked, true);
      } finally {
        await disconnect();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
