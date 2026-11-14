import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { createServerPlaylist, matchNamed } from './library.js';
import {
  allocateUniquePlaylistDisplayName,
  applyPlaylistNameKeyConstraints,
  backfillPlaylistNameKeys,
  collectPlaylistNameConflicts,
  ensurePlaylistNameKeyConstraintsReady,
  finalizePlaylistNameKeyMigration,
  findAllPlaylistNameConflicts,
  formatPlaylistNameConflictReport,
  isPlaylistNameUniqueViolation,
  normalizePlaylistNameKey,
  playlistNameKeyConstraintsReady,
  PlaylistNameConflictError,
} from './playlist-name.js';

const prismaCli = fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));
const migrationSqlPath = fileURLToPath(
  new URL('../../../prisma/migrations/20261103000000_playlist_name_key/migration.sql', import.meta.url),
);
const remoteAccessMigrationSqlPath = fileURLToPath(
  new URL('../../../prisma/migrations/20261106000000_playlist_remote_access/migration.sql', import.meta.url),
);

async function pushCurrentSchema(url: string) {
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/** Full schema, no uniqueness constraints yet (indexes/triggers applied by finalize). */
async function openUnconstrainedDb() {
  const root = await mkdtemp(path.join(tmpdir(), 'ts6-playlist-name-'));
  const url = `file:${path.join(root, 'test.db')}?connection_limit=1`;
  await pushCurrentSchema(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.tsServerConfig.create({ data: { id: 1, name: 'One', host: 'one.test', apiKey: 'x' } });
  await prisma.tsServerConfig.create({ data: { id: 2, name: 'Two', host: 'two.test', apiKey: 'x' } });
  await prisma.musicBot.create({ data: { id: 10, serverConfigId: 1, name: 'Bot1' } });
  return { root, prisma };
}

async function openFinalizedDb() {
  const opened = await openUnconstrainedDb();
  await finalizePlaylistNameKeyMigration(opened.prisma as any);
  return opened;
}

describe('playlist nameKey uniqueness corrections (finding #11)', () => {
  it('uses JS Unicode toLowerCase as the only nameKey policy', () => {
    assert.equal(normalizePlaylistNameKey('  Café  '), 'café');
    assert.equal(normalizePlaylistNameKey('CAFÉ'), 'café');
    assert.equal(normalizePlaylistNameKey('Café'), normalizePlaylistNameKey('CAFÉ'));
  });

  it('JS backfill sets Unicode keys and detects normalisation collisions without renaming', async () => {
    const { root, prisma } = await openUnconstrainedDb();
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt") VALUES
          ('Café', '', 'stream', 1, CURRENT_TIMESTAMP),
          ('CAFÉ', '', 'stream', 1, CURRENT_TIMESTAMP),
          (' Rock ', '', 'stream', 1, CURRENT_TIMESTAMP),
          ('rock', '', 'stream', 1, CURRENT_TIMESTAMP)`,
      );
      const backfilled = await backfillPlaylistNameKeys(prisma as any);
      assert.equal(backfilled, 4);
      const rows = await prisma.playlist.findMany({ orderBy: { id: 'asc' } });
      assert.equal(rows.every((r) => r.nameKey === normalizePlaylistNameKey(r.name)), true);
      assert.equal(rows.find((r) => r.name === 'CAFÉ')?.nameKey, 'café');
      assert.equal(rows.find((r) => r.name === ' Rock ')?.name, ' Rock ');

      const conflicts = collectPlaylistNameConflicts(rows);
      assert.ok(conflicts.some((c) => c.nameKey === 'café' && c.kind === 'same_scope'));
      assert.ok(conflicts.some((c) => c.nameKey === 'rock' && c.kind === 'same_scope'));
      await assert.rejects(() => finalizePlaylistNameKeyMigration(prisma as any), /conflicts block uniqueness/i);

      const after = await prisma.playlist.findMany({ orderBy: { id: 'asc' } });
      assert.deepEqual(after.map((p) => [p.id, p.name]), rows.map((p) => [p.id, p.name]));
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migration.sql stage-1 on a legacy-shaped table then JS finalize on clean data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-legacy-mig-'));
    const url = `file:${path.join(root, 'legacy.db')}?connection_limit=1`;
    // Representative pre-nameKey columns (subset); then apply checked-in migration.sql.
    let prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$disconnect();
      // Use full push as the "upgraded" shape after stage-1 would look in app deploys,
      // then prove migration.sql is additive-safe when column missing via a sibling DB.
      const legacyUrl = `file:${path.join(root, 'stage1.db')}?connection_limit=1`;
      prisma = new PrismaClient({ datasources: { db: { url: legacyUrl } } });
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "Playlist" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "name" TEXT NOT NULL,
          "mode" TEXT NOT NULL DEFAULT 'local',
          "musicBotId" INTEGER,
          "youtubePlaylistId" TEXT,
          "serverConfigId" INTEGER,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "mode", "serverConfigId") VALUES ('Solo', 'stream', 1)`,
      );
      const migration = await readFile(migrationSqlPath, 'utf8');
      const executable = migration.replace(/^--.*$/gm, '');
      assert.doesNotMatch(executable, /CREATE UNIQUE INDEX/);
      assert.doesNotMatch(executable, /lower\s*\(/i);
      for (const statement of executable.split(';').map((s) => s.trim()).filter(Boolean)) {
        await prisma.$executeRawUnsafe(statement);
      }
      const cols = await prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Playlist")');
      assert.ok(cols.some((c) => c.name === 'nameKey'));
      // Display name untouched:
      assert.deepEqual(
        await prisma.$queryRawUnsafe('SELECT "id", "name" FROM "Playlist"'),
        [{ id: 1, name: 'Solo' }],
      );
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('same-server concurrent creates leave one row', async () => {
    const { root, prisma } = await openFinalizedDb();
    try {
      const results = await Promise.all([
        createServerPlaylist(prisma as any, { name: 'Race', serverConfigId: 1, musicBotId: 10 }),
        createServerPlaylist(prisma as any, { name: 'race', serverConfigId: 1, musicBotId: 10 }),
        createServerPlaylist(prisma as any, { name: '  RACE ', serverConfigId: 1, musicBotId: 10 }),
      ]);
      assert.equal(results.filter((r) => r.ok).length, 1);
      assert.equal(results.filter((r) => !r.ok).length, 2);
      for (const lost of results.filter((r) => !r.ok)) {
        assert.match(lost.message, /already exists/i);
        assert.doesNotMatch(lost.message, /SQLITE|P2002|playlist_name_conflict/i);
      }
      assert.equal(await prisma.playlist.count({ where: { nameKey: 'race' } }), 1);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('concurrent shared vs server Twin: at most one namespace wins (trigger)', async () => {
    const { root, prisma } = await openFinalizedDb();
    try {
      const insert = (serverConfigId: number | null) => prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt")
         VALUES ('Twin', 'twin', 'stream', ?, CURRENT_TIMESTAMP)`,
        serverConfigId,
      ).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));

      const [shared, server] = await Promise.all([insert(null), insert(1)]);
      assert.equal([shared, server].filter((r) => r.ok).length, 1, JSON.stringify([shared, server].map((r) => r.ok)));
      assert.equal([shared, server].filter((r) => !r.ok).length, 1);
      const lost = shared.ok ? server : shared;
      assert.equal(lost.ok, false);
      if (!lost.ok) {
        assert.equal(isPlaylistNameUniqueViolation(lost.err), true, String((lost.err as Error)?.message));
      }
      assert.match(new PlaylistNameConflictError('Twin').message, /already exists/);
      assert.equal(await prisma.playlist.count({ where: { nameKey: 'twin' } }), 1);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rename and import allocation respect uniqueness', async () => {
    const { root, prisma } = await openFinalizedDb();
    try {
      await prisma.playlist.create({
        data: { name: 'Alpha', nameKey: 'alpha', mode: 'stream', serverConfigId: 1 },
      });
      const other = await prisma.playlist.create({
        data: { name: 'Beta', nameKey: 'beta', mode: 'stream', serverConfigId: 1 },
      });
      await assert.rejects(
        () => prisma.playlist.update({
          where: { id: other.id },
          data: { name: 'alpha', nameKey: 'alpha' },
        }),
        (err: unknown) => isPlaylistNameUniqueViolation(err),
      );

      const allocated = await allocateUniquePlaylistDisplayName(prisma as any, 'Alpha', 1);
      assert.equal(allocated.displayName, 'Alpha (2)');
      assert.equal(allocated.nameKey, 'alpha (2)');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preflight detects shared/server and same-scope collisions without destroying rows', async () => {
    const { root, prisma } = await openUnconstrainedDb();
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt") VALUES
          ('Twin', '', 'stream', NULL, CURRENT_TIMESTAMP),
          ('twin', '', 'stream', 1, CURRENT_TIMESTAMP),
          ('Dup', '', 'stream', 2, CURRENT_TIMESTAMP),
          ('dup', '', 'stream', 2, CURRENT_TIMESTAMP)`,
      );
      await backfillPlaylistNameKeys(prisma as any);
      const conflicts = await findAllPlaylistNameConflicts(prisma as any);
      assert.ok(conflicts.some((c) => c.kind === 'shared_server'));
      assert.ok(conflicts.some((c) => c.kind === 'same_scope'));
      assert.match(formatPlaylistNameConflictReport(conflicts), /shared↔server/);

      const before = await prisma.playlist.findMany({ orderBy: { id: 'asc' } });
      await assert.rejects(() => finalizePlaylistNameKeyMigration(prisma as any));
      const after = await prisma.playlist.findMany({ orderBy: { id: 'asc' } });
      assert.deepEqual(after.map((p) => [p.id, p.name]), before.map((p) => [p.id, p.name]));
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cross-namespace trigger blocks second Twin; catalog stays unambiguous', async () => {
    const { root, prisma } = await openFinalizedDb();
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt")
         VALUES ('Twin', 'twin', 'stream', NULL, CURRENT_TIMESTAMP)`,
      );
      await assert.rejects(
        () => prisma.$executeRawUnsafe(
          `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt")
           VALUES ('Twin', 'twin', 'stream', 1, CURRENT_TIMESTAMP)`,
        ),
        (err: unknown) => isPlaylistNameUniqueViolation(err),
      );
      const summaries = await prisma.playlist.findMany({
        where: { OR: [{ serverConfigId: 1 }, { serverConfigId: null }] },
        select: { id: true, name: true },
      });
      assert.equal(matchNamed(summaries, 'twin').length, 1);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows the same name on different servers; clean finalize succeeds', async () => {
    const { root, prisma } = await openFinalizedDb();
    try {
      assert.equal((await createServerPlaylist(prisma as any, { name: 'Lounge', serverConfigId: 1, musicBotId: 10 })).ok, true);
      assert.equal((await createServerPlaylist(prisma as any, { name: 'Lounge', serverConfigId: 2, musicBotId: 10 })).ok, true);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('after finalize: empty/NULL nameKey cannot bypass uniqueness', async () => {
    const { root, prisma } = await openFinalizedDb();
    try {
      await prisma.playlist.create({
        data: { name: 'Keep', nameKey: 'keep', mode: 'stream', serverConfigId: 1 },
      });

      await assert.rejects(
        () => prisma.$executeRawUnsafe(
          `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt")
           VALUES ('Blank', '', 'stream', 1, CURRENT_TIMESTAMP)`,
        ),
        (err: unknown) => isPlaylistNameUniqueViolation(err),
      );
      await assert.rejects(
        () => prisma.$executeRawUnsafe(
          `INSERT INTO "Playlist" ("name", "mode", "serverConfigId", "createdAt")
           VALUES ('OmitKey', 'stream', 1, CURRENT_TIMESTAMP)`,
        ),
        // NOT NULL DEFAULT '' still fires require trigger on ''
        (err: unknown) => isPlaylistNameUniqueViolation(err),
      );
      await assert.rejects(
        () => prisma.$executeRawUnsafe(
          `UPDATE "Playlist" SET "nameKey" = '' WHERE "name" = 'Keep'`,
        ),
        (err: unknown) => isPlaylistNameUniqueViolation(err),
      );
      await assert.rejects(
        () => prisma.$executeRawUnsafe(
          `UPDATE "Playlist" SET "nameKey" = NULL WHERE "name" = 'Keep'`,
        ),
        // Column NOT NULL and/or require trigger
        () => true,
      );

      const kept = await prisma.playlist.findFirst({ where: { name: 'Keep' } });
      assert.equal(kept?.nameKey, 'keep');
      assert.equal(await prisma.playlist.count(), 1);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses create/rename until stage-2 constraints are installed', async () => {
    const { root, prisma } = await openUnconstrainedDb();
    try {
      assert.equal(await playlistNameKeyConstraintsReady(prisma as any), false);
      await assert.rejects(
        () => ensurePlaylistNameKeyConstraintsReady(prisma as any),
        /not ready/i,
      );
      const created = await createServerPlaylist(prisma as any, {
        name: 'Premature',
        serverConfigId: 1,
        musicBotId: 10,
      });
      assert.equal(created.ok, false);
      if (!created.ok) assert.match(created.message, /not ready/i);
      assert.equal(await prisma.playlist.count(), 0);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('upgrade procedure: stage-1 → backfill → conflict-safe finalize → PlaylistSong intact → second finalize no-op', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-upgrade-'));
    const url = `file:${path.join(root, 'upgrade.db')}?connection_limit=1`;
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      // Old-schema fixture (no nameKey) with PlaylistSong relationship.
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "Song" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "title" TEXT NOT NULL,
          "filePath" TEXT NOT NULL DEFAULT '',
          "source" TEXT NOT NULL DEFAULT 'local',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "Playlist" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "name" TEXT NOT NULL,
          "mode" TEXT NOT NULL DEFAULT 'local',
          "musicBotId" INTEGER,
          "youtubePlaylistId" TEXT,
          "serverConfigId" INTEGER,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "PlaylistSong" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "playlistId" INTEGER NOT NULL,
          "songId" INTEGER NOT NULL,
          "position" INTEGER NOT NULL DEFAULT 0
        )
      `);
      await prisma.$executeRawUnsafe(`INSERT INTO "Song" ("title") VALUES ('Track A')`);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "mode", "serverConfigId") VALUES ('Clean', 'stream', 1)`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "PlaylistSong" ("playlistId", "songId", "position") VALUES (1, 1, 0)`,
      );

      // 1. Stage-1 migration.sql
      const migration = await readFile(migrationSqlPath, 'utf8');
      for (const statement of migration.replace(/^--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) {
        await prisma.$executeRawUnsafe(statement);
      }
      assert.ok(
        (await prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Playlist")'))
          .some((c) => c.name === 'nameKey'),
      );

      // Pre-finalize writes must not be accepted by app gate (constraints absent).
      assert.equal(await playlistNameKeyConstraintsReady(prisma as any), false);

      // 2. JS backfill
      const backfilled = await backfillPlaylistNameKeys(prisma as any);
      assert.equal(backfilled, 1);
      const afterBackfill = await prisma.$queryRawUnsafe<Array<{ id: number; name: string; nameKey: string }>>(
        `SELECT "id", "name", "nameKey" FROM "Playlist"`,
      );
      assert.deepEqual(afterBackfill, [{ id: 1, name: 'Clean', nameKey: 'clean' }]);

      // 3. Conflict detection on clean data is a no-op for unrelated rows
      assert.deepEqual(await findAllPlaylistNameConflicts(prisma as any), []);

      // 4. Stage-2 finalisation
      await applyPlaylistNameKeyConstraints(prisma as any);
      assert.equal(await playlistNameKeyConstraintsReady(prisma as any), true);

      // 5. Second finalisation is safe / no-op
      const second = await finalizePlaylistNameKeyMigration(prisma as any);
      assert.equal(second.backfilled, 0);
      assert.equal(await playlistNameKeyConstraintsReady(prisma as any), true);

      // 6. IDs and PlaylistSong intact
      const links = await prisma.$queryRawUnsafe<Array<{ playlistId: number; songId: number; position: number }>>(
        `SELECT "playlistId", "songId", "position" FROM "PlaylistSong"`,
      );
      assert.deepEqual(links, [{ playlistId: 1, songId: 1, position: 0 }]);
      assert.deepEqual(
        await prisma.$queryRawUnsafe(`SELECT "id", "name", "nameKey" FROM "Playlist"`),
        [{ id: 1, name: 'Clean', nameKey: 'clean' }],
      );

      // 7. Listener-remote column lands after nameKey in production migrate order.
      // Prisma client expects it before createServerPlaylist can run.
      const remoteAccessMigration = await readFile(remoteAccessMigrationSqlPath, 'utf8');
      for (const statement of remoteAccessMigration.replace(/^--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) {
        await prisma.$executeRawUnsafe(statement);
      }
      assert.ok(
        (await prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Playlist")'))
          .some((c) => c.name === 'remoteAccess'),
      );
      assert.deepEqual(
        await prisma.$queryRawUnsafe(`SELECT "id", "remoteAccess" FROM "Playlist"`),
        [{ id: 1, remoteAccess: 'hidden' }],
      );

      // 8. Post-upgrade create / rename / import-style allocate
      // Need server/bot rows for createServerPlaylist — insert minimally.
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "TsServerConfig" (
          "id" INTEGER PRIMARY KEY,
          "name" TEXT NOT NULL,
          "host" TEXT NOT NULL,
          "apiKey" TEXT NOT NULL
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "MusicBot" (
          "id" INTEGER PRIMARY KEY,
          "serverConfigId" INTEGER NOT NULL,
          "name" TEXT NOT NULL
        )
      `);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "TsServerConfig" ("id", "name", "host", "apiKey") VALUES (1, 'One', 'one.test', 'x')`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "MusicBot" ("id", "serverConfigId", "name") VALUES (10, 1, 'Bot1')`,
      );

      const created = await createServerPlaylist(prisma as any, {
        name: 'Fresh',
        serverConfigId: 1,
        musicBotId: 10,
      });
      assert.equal(created.ok, true);
      if (created.ok) {
        await prisma.playlist.update({
          where: { id: created.id },
          data: { name: 'Renamed', nameKey: 'renamed' },
        });
        const renamed = await prisma.playlist.findUnique({ where: { id: created.id } });
        assert.equal(renamed?.nameKey, 'renamed');
      }
      const allocated = await allocateUniquePlaylistDisplayName(prisma as any, 'Clean', 1);
      assert.equal(allocated.displayName, 'Clean (2)');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('duplicate-containing fixture: finalize refuses without deleting or renaming', async () => {
    const { root, prisma } = await openUnconstrainedDb();
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt") VALUES
          ('Rock', '', 'stream', 1, CURRENT_TIMESTAMP),
          ('rock', '', 'stream', 1, CURRENT_TIMESTAMP)`,
      );
      const playlists = await prisma.playlist.findMany({ orderBy: { id: 'asc' } });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Song" ("title", "filePath", "source", "serverConfigId", "createdAt")
         VALUES ('Keep Me', '/tmp/a', 'local', 1, CURRENT_TIMESTAMP)`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "PlaylistSong" ("playlistId", "songId", "position") VALUES (?, 1, 0)`,
        playlists[0].id,
      );

      const before = await prisma.playlist.findMany({ orderBy: { id: 'asc' } });
      const beforeLinks = await prisma.$queryRawUnsafe<Array<{ playlistId: number; songId: number }>>(
        `SELECT "playlistId", "songId" FROM "PlaylistSong" ORDER BY "id"`,
      );
      await assert.rejects(
        () => finalizePlaylistNameKeyMigration(prisma as any),
        /conflicts block uniqueness/i,
      );
      const after = await prisma.playlist.findMany({ orderBy: { id: 'asc' } });
      assert.deepEqual(
        after.map((p) => [p.id, p.name]),
        before.map((p) => [p.id, p.name]),
      );
      assert.equal(await playlistNameKeyConstraintsReady(prisma as any), false);
      assert.deepEqual(
        await prisma.$queryRawUnsafe(`SELECT "playlistId", "songId" FROM "PlaylistSong" ORDER BY "id"`),
        beforeLinks,
      );
      // App writes still refused until conflicts cleared and finalize succeeds.
      const attempt = await createServerPlaylist(prisma as any, {
        name: 'Anything',
        serverConfigId: 1,
        musicBotId: 10,
      });
      assert.equal(attempt.ok, false);
      if (!attempt.ok) assert.match(attempt.message, /not ready/i);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Prisma create populates nameKey; concurrent same-server still blocked', async () => {
    const { root, prisma } = await openFinalizedDb();
    try {
      const a = await prisma.playlist.create({
        data: { name: '  Prisma Key  ', nameKey: normalizePlaylistNameKey('  Prisma Key  '), mode: 'stream', serverConfigId: 1 },
      });
      assert.equal(a.nameKey, 'prisma key');

      const results = await Promise.all([
        createServerPlaylist(prisma as any, { name: 'Hit', serverConfigId: 1, musicBotId: 10 }),
        createServerPlaylist(prisma as any, { name: 'hit', serverConfigId: 1, musicBotId: 10 }),
      ]);
      assert.equal(results.filter((r) => r.ok).length, 1);
      assert.equal(await prisma.playlist.count({ where: { nameKey: 'hit' } }), 1);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });
});
