import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { applyProdGuildBinding, previewProdGuildBinding } from './prod-guild-bind.js';
import {
  appendProdGuildBindAudit,
  preflightProdGuildBindAuditLog,
} from './prod-guild-bind-audit.js';
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
    dbFile,
    realpath: realpathSync(dbFile),
    async close() {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('production guild-bind', () => {
  it('previews, binds with confirm realpath, and revokes with audit fields', async () => {
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
      assert.equal(preview.databaseRealpath, opened.realpath);

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
        confirmRealpath: opened.realpath,
      });
      assert.equal(bound.row.guildId, GUILD);
      assert.equal(bound.audit.operator, 'operator-a');
      assert.equal(bound.audit.applicationId, APP);
      assert.equal(bound.audit.databaseRealpath, opened.realpath);

      const revoked = await applyProdGuildBinding(opened.prisma as any, {
        action: 'revoke',
        databaseUrl: opened.url,
        operator: 'operator-a',
        applicationId: APP,
        guildId: GUILD,
        confirmWrite: true,
        confirmRealpath: opened.realpath,
      });
      assert.equal(revoked.row.revoked, true);
    } finally {
      await opened.close();
    }
  });

  it('refuses writes when confirmRealpath points at a different ts6webui.db', async () => {
    const opened = await openProdNamedDb();
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'ts6-prod-bind-other-'));
    const otherDb = path.join(otherRoot, 'ts6webui.db');
    await writeFile(otherDb, '');
    try {
      await assert.rejects(
        () => applyProdGuildBinding(opened.prisma as any, {
          action: 'bind',
          databaseUrl: opened.url,
          operator: 'op',
          applicationId: APP,
          guildId: GUILD,
          instanceId: 'x',
          serverConfigId: 1,
          musicBotId: 10,
          confirmWrite: true,
          confirmRealpath: realpathSync(otherDb),
        }),
        /confirmRealpath mismatch|Refusing write/i,
      );
    } finally {
      await opened.close();
      await rm(otherRoot, { recursive: true, force: true });
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
          confirmRealpath: realpathSync(dbFile),
        }),
        /ts6webui\.db|allowlisted|basename/i,
      );
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('audit preflight fails closed before mutation; append records after success', async () => {
    const opened = await openProdNamedDb();
    const auditDir = await mkdtemp(path.join(tmpdir(), 'ts6-prod-audit-'));
    const auditPath = path.join(auditDir, 'guild-bind.jsonl');
    try {
      const ready = preflightProdGuildBindAuditLog(auditPath);
      assert.equal(ready, path.resolve(auditPath));

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
        confirmRealpath: opened.realpath,
      });
      appendProdGuildBindAudit(auditPath, bound.audit);
      const body = await readFile(auditPath, 'utf8');
      assert.match(body, /"action":"bind"/);
      assert.match(body, /operator-a/);

      // Read-only audit path: later append must fail closed (CLI would exit 1).
      await chmod(auditPath, 0o400);
      let appendErr: unknown;
      try {
        appendProdGuildBindAudit(auditPath, { should: 'fail' });
      } catch (err) {
        appendErr = err;
      }
      assert.ok(appendErr, 'expected append to fail on read-only audit log');
      assert.match(String(appendErr), /EACCES|permission denied/i);
    } finally {
      await chmod(auditPath, 0o600).catch(() => undefined);
      await opened.close();
      await rm(auditDir, { recursive: true, force: true });
    }
  });
});
