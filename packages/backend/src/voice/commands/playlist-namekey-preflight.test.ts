/**
 * F1: pre-upgrade playlist-name compatibility — disposable SQLite fixtures only.
 * Never touches real application volumes.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, existsSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import {
  allocateUniquePlaylistDisplayName,
  classifySqlitePreflightTarget,
  finalizePlaylistNameKeyMigration,
  normalizePlaylistNameKey,
  playlistNameKeyConstraintsReady,
  preflightPlaylistNameKeyCompatibility,
  previewPlaylistNameKeyMigration,
  resolvePrismaSqliteDatabasePath,
} from './playlist-name.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../../../generated/prisma/index.js') as typeof import('../../../generated/prisma/index.js');
const prismaCli = fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));
const schemaDir = fileURLToPath(new URL('../../../prisma', import.meta.url));
const applySchemaSh = fileURLToPath(new URL('../../../../../docker-commands/apply-schema.sh', import.meta.url));
const backendDir = fileURLToPath(new URL('../../..', import.meta.url));
const cliTs = fileURLToPath(new URL('./playlist-namekey-finalize-cli.ts', import.meta.url));
const cliJs = fileURLToPath(new URL('../../../dist/voice/commands/playlist-namekey-finalize-cli.js', import.meta.url));

async function sha256File(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function playlistColumns(dbPath: string): Promise<string[]> {
  const url = `file:${dbPath}`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const cols = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("Playlist")`);
    return cols.map((c) => c.name).sort();
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Build a disposable pre-nameKey (legacy) SQLite DB with raw DDL only.
 * Avoids prisma db push + RENAME races (T-1): one connection, no schema strip.
 * Columns include required fields so a later db push can add nameKey safely.
 */
async function buildLegacyFixture(
  dbPath: string,
  playlists: Array<{ name: string; serverConfigId: number | null }>,
): Promise<void> {
  await mkdir(path.dirname(dbPath), { recursive: true });
  // Unique file per call; connection_limit=1 avoids multi-handle DDL races.
  const url = `file:${dbPath}?connection_limit=1`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$executeRawUnsafe(`PRAGMA foreign_keys=OFF`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "TsServerConfig" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "name" TEXT NOT NULL,
        "host" TEXT NOT NULL,
        "webqueryPort" INTEGER NOT NULL DEFAULT 10080,
        "apiKey" TEXT NOT NULL,
        "useHttps" BOOLEAN NOT NULL DEFAULT false,
        "sshPort" INTEGER NOT NULL DEFAULT 10022,
        "sshUsername" TEXT,
        "sshPassword" TEXT,
        "sshHostKeyFingerprint" TEXT,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "isDemo" BOOLEAN NOT NULL DEFAULT false,
        "metricsEnabled" BOOLEAN NOT NULL DEFAULT false,
        "metricsPort" INTEGER NOT NULL DEFAULT 9187,
        "metricsHost" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "MusicBot" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "name" TEXT NOT NULL,
        "serverConfigId" INTEGER NOT NULL,
        "nickname" TEXT NOT NULL DEFAULT 'MusicBot',
        "serverPassword" TEXT,
        "defaultChannel" TEXT,
        "channelPassword" TEXT,
        "commandChannelIds" TEXT,
        "virtualServerId" INTEGER NOT NULL DEFAULT 1,
        "voicePort" INTEGER NOT NULL DEFAULT 9987,
        "volume" INTEGER NOT NULL DEFAULT 50,
        "identityData" TEXT,
        "avatarMode" TEXT NOT NULL DEFAULT 'none',
        "avatarFile" TEXT,
        "avatarMd5" TEXT,
        "autoStart" BOOLEAN NOT NULL DEFAULT false,
        "automationSettings" TEXT,
        "automationState" TEXT,
        "streamPreset" TEXT NOT NULL DEFAULT '720p',
        "sidecarPort" INTEGER NOT NULL DEFAULT 9800,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "Song" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "title" TEXT NOT NULL,
        "artist" TEXT,
        "duration" REAL,
        "filePath" TEXT NOT NULL,
        "source" TEXT NOT NULL DEFAULT 'local',
        "sourceUrl" TEXT,
        "fileSize" INTEGER,
        "serverConfigId" INTEGER NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Legacy Playlist: no nameKey column (and no uniqueness indexes/triggers).
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "Playlist" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "name" TEXT NOT NULL,
        "mode" TEXT NOT NULL DEFAULT 'local',
        "remoteAccess" TEXT NOT NULL DEFAULT 'hidden',
        "musicBotId" INTEGER,
        "youtubePlaylistId" TEXT,
        "serverConfigId" INTEGER,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "PlaylistSong" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "playlistId" INTEGER NOT NULL,
        "songId" INTEGER NOT NULL,
        "position" INTEGER NOT NULL DEFAULT 0
      )
    `);

    await prisma.$executeRawUnsafe(
      `INSERT INTO "TsServerConfig" ("id", "name", "host", "apiKey") VALUES
        (1, 'Alpha', 'alpha.test', 'k1'),
        (2, 'Beta', 'beta.test', 'k2')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MusicBot" ("id", "serverConfigId", "name") VALUES
        (10, 1, 'BotA'),
        (20, 2, 'BotB')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Song" ("id", "title", "filePath", "source", "serverConfigId")
       VALUES (1, 'Track One', '/tmp/track-one', 'local', 1)`,
    );
    for (const p of playlists) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "mode", "remoteAccess", "serverConfigId", "musicBotId") VALUES (?, 'stream', 'hidden', ?, ?)`,
        p.name,
        p.serverConfigId,
        p.serverConfigId == null ? null : (p.serverConfigId === 1 ? 10 : 20),
      );
    }
    if (playlists.length) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "PlaylistSong" ("playlistId", "songId", "position") VALUES (1, 1, 0)`,
      );
    }
    await prisma.$executeRawUnsafe(`PRAGMA foreign_keys=ON`);
  } finally {
    await prisma.$disconnect();
  }
}

function runApplySchema(
  dataDir: string,
  dbFile: string,
  opts: { databaseUrl?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BACKEND_DIR: backendDir,
    DATA_DIR: dataDir,
    DB_FILE: dbFile,
    DATABASE_URL: opts.databaseUrl ?? `file:${dbFile}`,
    CHECKPOINT_DISABLE: '1',
  };
  const result = spawnSync('sh', [applySchemaSh], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runCli(
  flags: string | string[],
  databaseUrl: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const args = Array.isArray(flags) ? flags : [flags];
  const env = { ...process.env, DATABASE_URL: databaseUrl, ...extraEnv };
  // Prefer compiled CLI when present (published-image path); else tsx source.
  try {
    accessSync(cliJs);
    return spawnSync(process.execPath, [cliJs, ...args], { env, encoding: 'utf8' });
  } catch {
    return spawnSync(process.execPath, ['--import', 'tsx', cliTs, ...args], { env, encoding: 'utf8' });
  }
}

describe('F1 playlist nameKey preflight (legacy fixtures)', () => {
  it('clean legacy database: apply-schema upgrade succeeds and enforces constraints', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-clean-'));
    const dataDir = path.join(root, 'data');
    const dbFile = path.join(dataDir, 'ts6webui.db');
    await mkdir(dataDir, { recursive: true });
    try {
      await buildLegacyFixture(dbFile, [
        { name: 'Morning', serverConfigId: 1 },
        { name: 'Evening', serverConfigId: 2 },
        { name: 'Shared Hits', serverConfigId: null },
      ]);
      const colsBefore = await playlistColumns(dbFile);
      assert.equal(colsBefore.includes('nameKey'), false);

      const applied = runApplySchema(dataDir, dbFile);
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
      assert.equal((await playlistColumns(dbFile)).includes('nameKey'), true);

      const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
      try {
        assert.equal(await playlistNameKeyConstraintsReady(prisma as any), true);
        const rows = await prisma.playlist.findMany({ orderBy: { id: 'asc' } });
        assert.deepEqual(
          rows.map((r) => [r.name, r.nameKey]),
          [
            ['Morning', 'morning'],
            ['Evening', 'evening'],
            ['Shared Hits', 'shared hits'],
          ],
        );
        // Constraints actually enforced
        await assert.rejects(
          () => prisma.playlist.create({
            data: { name: 'morning', nameKey: 'morning', mode: 'stream', serverConfigId: 1 },
          }),
          /playlist_name|Unique|P2002|constraint/i,
        );
        // Ordinary ops after migration
        const allocated = await allocateUniquePlaylistDisplayName(prisma as any, 'Morning', 1);
        assert.equal(allocated.nameKey, 'morning (2)');
        await prisma.playlist.create({
          data: {
            name: allocated.displayName,
            nameKey: allocated.nameKey,
            mode: 'stream',
            serverConfigId: 1,
          },
        });
        // Repeated startup / finalize idempotent
        const second = await finalizePlaylistNameKeyMigration(prisma as any);
        assert.equal(second.backfilled, 0);
        assert.equal(await prisma.playlist.count({ where: { nameKey: 'morning' } }), 1);
      } finally {
        await prisma.$disconnect();
      }

      // Repeated apply-schema remains safe
      const again = runApplySchema(dataDir, dbFile);
      assert.equal(again.status, 0, again.stderr || again.stdout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Chill / chill in same scope: refused before schema changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-case-'));
    const dbFile = path.join(root, 'legacy.db');
    try {
      await buildLegacyFixture(dbFile, [
        { name: 'Chill', serverConfigId: 1 },
        { name: 'chill', serverConfigId: 1 },
      ]);
      const hashBefore = await sha256File(dbFile);
      const colsBefore = await playlistColumns(dbFile);

      const pre = await (async () => {
        const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
        try {
          return await preflightPlaylistNameKeyCompatibility(prisma as any);
        } finally {
          await prisma.$disconnect();
        }
      })();
      assert.equal(pre.compatible, false);
      assert.ok(pre.conflicts.some((c) => c.nameKey === 'chill' && c.kind === 'same_scope'));

      const applied = runApplySchema(root, dbFile);
      assert.notEqual(applied.status, 0);
      assert.deepEqual(await playlistColumns(dbFile), colsBefore);
      assert.equal(await sha256File(dbFile), hashBefore);
      assert.equal((await playlistColumns(dbFile)).includes('nameKey'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('duplicate imported playlist titles: refused before schema changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-import-'));
    const dbFile = path.join(root, 'legacy.db');
    try {
      await buildLegacyFixture(dbFile, [
        { name: 'Imported Playlist', serverConfigId: 1 },
        { name: 'Imported Playlist', serverConfigId: 1 },
      ]);
      const hashBefore = await sha256File(dbFile);
      const prePrisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
      try {
        const preview = await previewPlaylistNameKeyMigration(prePrisma as any);
        assert.equal(preview.compatible, false);
        assert.ok(preview.conflicts.some((c) => c.nameKey === 'imported playlist'));
      } finally {
        await prePrisma.$disconnect();
      }
      const applied = runApplySchema(root, dbFile);
      assert.notEqual(applied.status, 0);
      assert.equal(await sha256File(dbFile), hashBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shared and server playlist collision: refused before schema changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-cross-'));
    const dbFile = path.join(root, 'legacy.db');
    try {
      await buildLegacyFixture(dbFile, [
        { name: 'Rock', serverConfigId: null },
        { name: 'rock', serverConfigId: 1 },
      ]);
      const hashBefore = await sha256File(dbFile);
      const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
      try {
        const pre = await preflightPlaylistNameKeyCompatibility(prisma as any);
        assert.equal(pre.compatible, false);
        assert.ok(pre.conflicts.some((c) => c.kind === 'shared_server' && c.nameKey === 'rock'));
      } finally {
        await prisma.$disconnect();
      }
      assert.notEqual(runApplySchema(root, dbFile).status, 0);
      assert.equal(await sha256File(dbFile), hashBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('whitespace-only playlist name: preview and preflight both refuse', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-ws-'));
    const dbFile = path.join(root, 'legacy.db');
    try {
      await buildLegacyFixture(dbFile, [
        { name: '   ', serverConfigId: 1 },
        { name: 'Ok', serverConfigId: 1 },
      ]);
      assert.equal(normalizePlaylistNameKey('   '), '');
      const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
      try {
        const preview = await previewPlaylistNameKeyMigration(prisma as any);
        const preflight = await preflightPlaylistNameKeyCompatibility(prisma as any);
        assert.equal(preview.compatible, false);
        assert.equal(preflight.compatible, false);
        assert.ok(preview.emptyNormalized.some((r) => r.name === '   '));
        assert.ok(preflight.emptyNormalized.some((r) => r.name === '   '));
        // Preview must not report success when finalisation would refuse
        assert.equal(preview.conflicts.length === 0 && preview.emptyNormalized.length === 0, false);
      } finally {
        await prisma.$disconnect();
      }
      const cli = runCli('--preview', `file:${dbFile}`);
      assert.notEqual(cli.status, 0);
      assert.match(cli.stdout + cli.stderr, /empty_normalized|compatible=false/);
      const hashBefore = await sha256File(dbFile);
      assert.notEqual(runApplySchema(root, dbFile).status, 0);
      assert.equal(await sha256File(dbFile), hashBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('normal names in independent scopes are allowed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-scopes-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, 'ts6webui.db');
    try {
      await buildLegacyFixture(dbFile, [
        { name: 'Chill', serverConfigId: 1 },
        { name: 'Chill', serverConfigId: 2 },
      ]);
      const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
      try {
        const pre = await preflightPlaylistNameKeyCompatibility(prisma as any);
        assert.equal(pre.compatible, true);
        assert.equal(pre.conflicts.length, 0);
      } finally {
        await prisma.$disconnect();
      }
      assert.equal(runApplySchema(dataDir, dbFile).status, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('empty/fresh database: initialisation succeeds', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-fresh-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, 'ts6webui.db');
    try {
      const applied = runApplySchema(dataDir, dbFile);
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
      const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
      try {
        assert.equal(await playlistNameKeyConstraintsReady(prisma as any), true);
        assert.equal(await prisma.playlist.count(), 0);
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('previously upgraded valid database: startup remains idempotent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-upgraded-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, 'ts6webui.db');
    try {
      await buildLegacyFixture(dbFile, [{ name: 'Stable', serverConfigId: 1 }]);
      assert.equal(runApplySchema(dataDir, dbFile).status, 0);
      const version1 = await readFile(path.join(dataDir, '.schema-version'), 'utf8');
      const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
      let countBefore: number;
      try {
        countBefore = await prisma.playlist.count();
        const namesBefore = await prisma.playlist.findMany({ select: { id: true, name: true, nameKey: true } });
        assert.equal(runApplySchema(dataDir, dbFile).status, 0);
        assert.equal(await readFile(path.join(dataDir, '.schema-version'), 'utf8'), version1);
        assert.equal(await prisma.playlist.count(), countBefore);
        assert.deepEqual(
          await prisma.playlist.findMany({ select: { id: true, name: true, nameKey: true } }),
          namesBefore,
        );
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('failed preflight: previous-version shaped DB remains usable (untouched schema)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-rollback-'));
    const dbFile = path.join(root, 'legacy.db');
    const backup = path.join(root, 'backup.db');
    try {
      await buildLegacyFixture(dbFile, [
        { name: 'Dup', serverConfigId: 1 },
        { name: 'dup', serverConfigId: 1 },
      ]);
      await copyFile(dbFile, backup);
      const hash = await sha256File(dbFile);
      assert.notEqual(runApplySchema(root, dbFile).status, 0);
      assert.equal(await sha256File(dbFile), hash);
      // Simulate rollback: restore backup copy semantics (file unchanged already)
      await copyFile(backup, dbFile);
      assert.equal((await playlistColumns(dbFile)).includes('nameKey'), false);
      const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
      try {
        const rows = await prisma.$queryRawUnsafe<Array<{ id: number; name: string }>>(
          `SELECT "id" AS id, "name" AS name FROM "Playlist" ORDER BY "id"`,
        );
        assert.deepEqual(rows.map((r) => r.name), ['Dup', 'dup']);
        // Legacy-shaped writes still work without nameKey column
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Playlist" ("name", "mode", "serverConfigId") VALUES ('New Legacy', 'stream', 1)`,
        );
        assert.equal(
          Number((await prisma.$queryRawUnsafe<Array<{ c: number | bigint }>>(`SELECT COUNT(*) AS c FROM "Playlist"`))[0].c),
          3,
        );
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLI --preflight matches preview refusal on legacy DB without using Prisma nameKey select', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-cli-'));
    const dbFile = path.join(root, 'legacy.db');
    try {
      await buildLegacyFixture(dbFile, [
        { name: 'A', serverConfigId: 1 },
        { name: 'a', serverConfigId: 1 },
      ]);
      const preview = runCli('--preview', `file:${dbFile}`);
      const preflight = runCli('--preflight', `file:${dbFile}`);
      assert.notEqual(preview.status, 0);
      assert.notEqual(preflight.status, 0);
      assert.match(preview.stdout, /compatible=false/);
      assert.match(preflight.stdout, /compatible=false/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('F1 R1 DATABASE_URL preflight targeting', () => {
  it('resolves relative file: URLs against the Prisma schema directory', () => {
    const abs = resolvePrismaSqliteDatabasePath('file:./custom/legacy.db', schemaDir);
    assert.equal(abs.ok, true);
    if (abs.ok) {
      assert.equal(abs.absolutePath, path.resolve(schemaDir, './custom/legacy.db'));
    }
    const plain = resolvePrismaSqliteDatabasePath('file:legacy.db', schemaDir);
    assert.equal(plain.ok, true);
    if (plain.ok) {
      assert.equal(plain.absolutePath, path.resolve(schemaDir, 'legacy.db'));
    }
  });

  it('absent DATABASE_URL is fresh; mismatched existing DB_FILE fails closed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-mismatch-'));
    const marker = path.join(root, 'marker.db');
    const missing = path.join(root, 'missing-custom.db');
    try {
      await buildLegacyFixture(marker, [{ name: 'Solo', serverConfigId: 1 }]);
      const fresh = classifySqlitePreflightTarget({
        databaseUrl: `file:${missing}`,
        schemaDir,
      });
      assert.equal(fresh.kind, 'absent_fresh');

      const mismatch = classifySqlitePreflightTarget({
        databaseUrl: `file:${missing}`,
        schemaDir,
        markerDbFile: marker,
      });
      assert.equal(mismatch.kind, 'error');
      if (mismatch.kind === 'error') {
        assert.match(mismatch.message, /refusing to initialise a replacement/i);
      }

      const cli = runCli('--preflight', `file:${missing}`, {
        TS6_SCHEMA_DB_FILE: marker,
        DB_FILE: marker,
      });
      assert.notEqual(cli.status, 0);
      assert.match(cli.stderr + cli.stdout, /refusing to initialise a replacement/i);
      assert.equal((await playlistColumns(marker)).includes('nameKey'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('legacy database at custom absolute DATABASE_URL upgrades when compatible', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-abs-url-'));
    const dataDir = path.join(root, 'data');
    const markerUnused = path.join(dataDir, 'ts6webui.db');
    const customDb = path.join(root, 'custom', 'app.db');
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.dirname(customDb), { recursive: true });
    try {
      await buildLegacyFixture(customDb, [
        { name: 'Morning', serverConfigId: 1 },
        { name: 'Night', serverConfigId: 2 },
      ]);
      // DB_FILE path does not exist — must still preflight DATABASE_URL.
      const applied = runApplySchema(dataDir, markerUnused, { databaseUrl: `file:${customDb}` });
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
      assert.match(applied.stdout, /Preflight: playlist nameKey compatibility/);
      assert.equal((await playlistColumns(customDb)).includes('nameKey'), true);
      assert.equal((await playlistColumns(customDb)).includes('nameKey'), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('legacy database at relative DATABASE_URL (schema-dir semantics) is checked', async () => {
    // Unique dir under prisma/ so relative file: URLs resolve here without colliding (T-2).
    const relDir = await mkdtemp(path.join(schemaDir, 'f1-rel-'));
    const relName = path.basename(relDir);
    const relDb = path.join(relDir, 'legacy.db');
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-rel-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    try {
      await buildLegacyFixture(relDb, [{ name: 'RelOk', serverConfigId: 1 }]);
      const relUrl = `file:./${relName}/legacy.db`;
      const resolved = resolvePrismaSqliteDatabasePath(relUrl, schemaDir);
      assert.equal(resolved.ok, true);
      if (resolved.ok) assert.equal(resolved.absolutePath, relDb);

      const applied = runApplySchema(dataDir, path.join(dataDir, 'ts6webui.db'), {
        databaseUrl: relUrl,
      });
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
      assert.equal((await playlistColumns(relDb)).includes('nameKey'), true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(relDir, { recursive: true, force: true });
    }
  });

  it('DATABASE_URL and DB_FILE differing: preflight uses DATABASE_URL and refuses duplicates before mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-split-paths-'));
    const dataDir = path.join(root, 'data');
    const marker = path.join(dataDir, 'ts6webui.db');
    const customDb = path.join(root, 'elsewhere', 'live.db');
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.dirname(customDb), { recursive: true });
    try {
      // Marker path empty / absent; real legacy data only at custom DATABASE_URL.
      await buildLegacyFixture(customDb, [
        { name: 'Chill', serverConfigId: 1 },
        { name: 'chill', serverConfigId: 1 },
      ]);
      const hashBefore = await sha256File(customDb);
      const colsBefore = await playlistColumns(customDb);
      const applied = runApplySchema(dataDir, marker, { databaseUrl: `file:${customDb}` });
      assert.notEqual(applied.status, 0);
      assert.match(applied.stdout + applied.stderr, /Preflight|compatible=false|same_scope/i);
      assert.equal(await sha256File(customDb), hashBefore);
      assert.deepEqual(await playlistColumns(customDb), colsBefore);
      assert.equal(colsBefore.includes('nameKey'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('whitespace-only names on custom-path DB refuse before schema mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-ws-custom-'));
    const dataDir = path.join(root, 'data');
    const marker = path.join(dataDir, 'ts6webui.db');
    const customDb = path.join(root, 'ws.db');
    await mkdir(dataDir, { recursive: true });
    try {
      await buildLegacyFixture(customDb, [
        { name: '   ', serverConfigId: 1 },
        { name: 'Ok', serverConfigId: 1 },
      ]);
      const hashBefore = await sha256File(customDb);
      assert.notEqual(runApplySchema(dataDir, marker, { databaseUrl: `file:${customDb}` }).status, 0);
      assert.equal(await sha256File(customDb), hashBefore);
      assert.equal((await playlistColumns(customDb)).includes('nameKey'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fresh install with no database still initialises after unconditional preflight', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-fresh2-'));
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, 'ts6webui.db');
    try {
      // Manual check without --allow-absent must fail (R2-a).
      const manual = runCli('--preflight', `file:${dbFile}`, { TS6_SCHEMA_DB_FILE: dbFile });
      assert.notEqual(manual.status, 0);
      assert.match(manual.stderr + manual.stdout, /not found|not checked/i);
      assert.equal(manual.stdout.includes('compatible=true'), false);
      // Startup path uses --allow-absent.
      const pre = runCli(['--preflight', '--allow-absent'], `file:${dbFile}`, { TS6_SCHEMA_DB_FILE: dbFile });
      assert.equal(pre.status, 0, pre.stderr || pre.stdout);
      assert.match(pre.stdout, /fresh install|compatible=true/i);
      assert.equal(
        existsSync(dbFile),
        false,
        'absent preflight must not create the database file',
      );
      const applied = runApplySchema(dataDir, dbFile);
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('F1 R2-a absent-file operator checks', () => {
  it('manual --preflight / --preview on missing file exit non-zero without creating files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-absent-'));
    const missing = path.join(root, 'nope.db');
    try {
      for (const flag of ['--preflight', '--preview'] as const) {
        const result = runCli(flag, `file:${missing}`);
        assert.notEqual(result.status, 0, flag);
        assert.match(result.stderr + result.stdout, /not found|not checked/i);
        assert.equal((result.stdout + result.stderr).includes('compatible=true'), false);
      }
      const { readdirSync } = await import('node:fs');
      assert.deepEqual(readdirSync(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('manual --preflight on a valid legacy database reports the real result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-manual-ok-'));
    const dbFile = path.join(root, 'ok.db');
    try {
      await buildLegacyFixture(dbFile, [{ name: 'Solo', serverConfigId: 1 }]);
      const ok = runCli('--preflight', `file:${dbFile}`);
      assert.equal(ok.status, 0, ok.stderr || ok.stdout);
      assert.match(ok.stdout, /compatible=true/);

      await buildLegacyFixture(path.join(root, 'bad.db'), [
        { name: 'X', serverConfigId: 1 },
        { name: 'x', serverConfigId: 1 },
      ]);
      const bad = runCli('--preflight', `file:${path.join(root, 'bad.db')}`);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stdout, /compatible=false/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('F1 R4-1 empty / unrelated database refusal', () => {
  it('manual checks refuse missing, empty, bare SQLite, unrelated, and corrupt targets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-r41-'));
    try {
      const missing = path.join(root, 'missing.db');
      for (const flag of ['--preflight', '--preview'] as const) {
        const r = runCli(flag, `file:${missing}`);
        assert.notEqual(r.status, 0, flag);
        assert.match(r.stderr + r.stdout, /not found|not checked/i);
        assert.equal((r.stdout + r.stderr).includes('compatible=true'), false);
      }
      assert.equal(existsSync(missing), false);

      const zero = path.join(root, 'zero.db');
      writeFileSync(zero, '');
      const zeroPre = runCli('--preflight', `file:${zero}`);
      assert.notEqual(zeroPre.status, 0);
      assert.match(zeroPre.stderr + zeroPre.stdout, /empty file|not a readable SQLite/i);
      assert.equal((zeroPre.stdout + zeroPre.stderr).includes('compatible=true'), false);
      assert.equal(existsSync(zero), true);
      assert.equal((await readFile(zero)).length, 0);

      const bare = path.join(root, 'bare.db');
      // Valid empty SQLite with no application tables.
      execFileSync('sqlite3', [bare, 'VACUUM;'], { encoding: 'utf8' });
      const barePre = runCli('--preflight', `file:${bare}`);
      assert.notEqual(barePre.status, 0);
      assert.match(barePre.stderr + barePre.stdout, /Not a TS6 Manager database/i);
      assert.equal((barePre.stdout + barePre.stderr).includes('compatible=true'), false);

      const unrelated = path.join(root, 'other.db');
      execFileSync('sqlite3', [unrelated, 'CREATE TABLE widgets(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO widgets(name) VALUES (\'x\');'], { encoding: 'utf8' });
      const unrelatedPre = runCli('--preflight', `file:${unrelated}`);
      assert.notEqual(unrelatedPre.status, 0);
      assert.match(unrelatedPre.stderr + unrelatedPre.stdout, /Not a TS6 Manager database/i);
      assert.equal((unrelatedPre.stdout + unrelatedPre.stderr).includes('compatible=true'), false);

      const fakePlaylist = path.join(root, 'fake-playlist.db');
      execFileSync('sqlite3', [fakePlaylist, 'CREATE TABLE Playlist(id INTEGER PRIMARY KEY, title TEXT);'], { encoding: 'utf8' });
      const fakePre = runCli('--preflight', `file:${fakePlaylist}`);
      assert.notEqual(fakePre.status, 0);
      assert.match(fakePre.stderr + fakePre.stdout, /Not a TS6 Manager database/i);

      const corrupt = path.join(root, 'corrupt.db');
      await writeFile(corrupt, 'this is not sqlite\n');
      const corruptPre = runCli('--preflight', `file:${corrupt}`);
      assert.notEqual(corruptPre.status, 0);
      assert.equal((corruptPre.stdout + corruptPre.stderr).includes('compatible=true'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('TS6 DB with zero playlists is compatible; conflicts still refuse; empty Playlist table is not “not TS6”', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-r41-ok-'));
    try {
      const emptyPl = path.join(root, 'empty-playlists.db');
      await buildLegacyFixture(emptyPl, []);
      const emptyPre = runCli('--preflight', `file:${emptyPl}`);
      assert.equal(emptyPre.status, 0, emptyPre.stderr || emptyPre.stdout);
      assert.match(emptyPre.stdout, /compatible=true/);
      assert.match(emptyPre.stdout, /playlists=0/);

      const ok = path.join(root, 'ok.db');
      await buildLegacyFixture(ok, [{ name: 'Solo', serverConfigId: 1 }]);
      assert.equal(runCli('--preflight', `file:${ok}`).status, 0);

      const bad = path.join(root, 'bad.db');
      await buildLegacyFixture(bad, [
        { name: 'Chill', serverConfigId: 1 },
        { name: 'chill', serverConfigId: 1 },
      ]);
      const badPre = runCli('--preflight', `file:${bad}`);
      assert.notEqual(badPre.status, 0);
      assert.match(badPre.stdout, /compatible=false/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('--allow-absent does not bypass refusal of an existing empty/unrelated database', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-r41-allow-'));
    try {
      const bare = path.join(root, 'bare.db');
      execFileSync('sqlite3', [bare, 'VACUUM;'], { encoding: 'utf8' });
      const r = runCli(['--preflight', '--allow-absent'], `file:${bare}`);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr + r.stdout, /Not a TS6 Manager database/i);
      assert.equal((r.stdout + r.stderr).includes('compatible=true'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('F1 T-1 concurrent legacy fixtures', () => {
  it('repeated and concurrent fixture creation succeeds without rename races', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-concurrent-'));
    try {
      const paths = Array.from({ length: 6 }, (_, i) => path.join(root, `fix-${i}.db`));
      await Promise.all(paths.map((p, i) => buildLegacyFixture(p, [
        { name: `P${i}`, serverConfigId: 1 },
        { name: `Q${i}`, serverConfigId: 2 },
      ])));
      for (const p of paths) {
        assert.equal((await playlistColumns(p)).includes('nameKey'), false);
        const prisma = new PrismaClient({ datasources: { db: { url: `file:${p}` } } });
        try {
          const n = Number((await prisma.$queryRawUnsafe<Array<{ c: number | bigint }>>(
            `SELECT COUNT(*) AS c FROM "Playlist"`,
          ))[0].c);
          assert.equal(n, 2);
        } finally {
          await prisma.$disconnect();
        }
      }
      // Second wave against new unique paths (repeatability).
      const more = Array.from({ length: 4 }, (_, i) => path.join(root, `again-${i}.db`));
      await Promise.all(more.map((p) => buildLegacyFixture(p, [{ name: 'Solo', serverConfigId: 1 }])));
      for (const p of more) {
        assert.equal((await playlistColumns(p)).includes('nameKey'), false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('F1 preview parity with finalisation refusal', () => {
  it('preview refuses empty normalised keys that finalisation would reject after db push', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-f1-preview-empty-'));
    const url = `file:${path.join(root, 'test.db')}`;
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.tsServerConfig.create({
        data: { id: 1, name: 'One', host: 'one.test', apiKey: 'x' },
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt")
         VALUES ('', '', 'stream', 1, CURRENT_TIMESTAMP)`,
      );
      const preview = await previewPlaylistNameKeyMigration(prisma as any);
      assert.equal(preview.compatible, false);
      assert.ok(preview.emptyNormalized.length >= 1);
      await assert.rejects(() => finalizePlaylistNameKeyMigration(prisma as any));
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });
});
