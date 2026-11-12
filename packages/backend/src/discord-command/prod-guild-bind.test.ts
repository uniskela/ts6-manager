import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { applyProdGuildBinding, previewProdGuildBinding } from './prod-guild-bind.js';
import { finalizePlaylistNameKeyMigration } from '../voice/commands/playlist-name.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../../generated/prisma/index.js') as typeof import('../../generated/prisma/index.js');
const prismaCli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

const GUILD = '111000000000000099';
const APP = '222000000000000088';

async function openProdNamedDb() {
  const root = await mkdtemp(path.join(tmpdir(), 'ts6-prod-bind-'));
  const dbFile = path.join(root, 'ts6webui.db');
  await writeFile(dbFile, '');
  const url = `file:${dbFile}`;
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await finalizePlaylistNameKeyMigration(prisma as any);
  await prisma.tsServerConfig.create({
    data: { id: 1, name: 'Prod Test', host: '127.0.0.1', apiKey: 'x' },
  });
  await prisma.musicBot.create({
    data: { id: 10, serverConfigId: 1, name: 'Bot', virtualServerId: 1 },
  });
  return {
    prisma,
    url,
    root,
    async close() {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('production guild-bind', () => {
  it('previews, binds with confirm, and revokes with audit fields', async () => {
    const opened = await openProdNamedDb();
    try {
      const preview = await previewProdGuildBinding(opened.prisma as any, {
        action: 'bind',
        databaseUrl: opened.url,
        operator: 'operator-a',
        applicationId: APP,
        guildId: GUILD,
        instanceId: 'prod-instance',
        serverConfigId: 1,
        musicBotId: 10,
      });
      assert.equal(preview.errors.length, 0);
      assert.equal(preview.databaseUrlSafe, true);

      const bound = await applyProdGuildBinding(opened.prisma as any, {
        action: 'bind',
        databaseUrl: opened.url,
        operator: 'operator-a',
        applicationId: APP,
        guildId: GUILD,
        instanceId: 'prod-instance',
        serverConfigId: 1,
        musicBotId: 10,
        confirmWrite: true,
      });
      assert.equal(bound.row.guildId, GUILD);
      assert.equal(bound.audit.operator, 'operator-a');
      assert.equal(bound.audit.applicationId, APP);

      const revoked = await applyProdGuildBinding(opened.prisma as any, {
        action: 'revoke',
        databaseUrl: opened.url,
        operator: 'operator-a',
        applicationId: APP,
        guildId: GUILD,
        confirmWrite: true,
      });
      assert.equal(revoked.row.revoked, true);
    } finally {
      await opened.close();
    }
  });

  it('refuses non-allowlisted database basenames', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-prod-bind-bad-'));
    const dbFile = path.join(root, 'scratch.db');
    await writeFile(dbFile, '');
    const url = `file:${dbFile}`;
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await assert.rejects(
        () => applyProdGuildBinding(prisma as any, {
          action: 'bind',
          databaseUrl: url,
          operator: 'op',
          applicationId: APP,
          guildId: GUILD,
          instanceId: 'x',
          serverConfigId: 1,
          musicBotId: 10,
          confirmWrite: true,
        }),
        /ts6webui\.db|allowlisted|basename/i,
      );
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });
});
