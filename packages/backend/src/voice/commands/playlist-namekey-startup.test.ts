/**
 * Validates the db-push + finalize path that apply-schema.sh runs on container start.
 * Uses a copied legacy (pre-nameKey) SQLite database — no production DB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import {
  allocateUniquePlaylistDisplayName,
  finalizePlaylistNameKeyMigration,
  playlistNameKeyConstraintsReady,
  previewPlaylistNameKeyMigration,
} from './playlist-name.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../../../generated/prisma/index.js') as typeof import('../../../generated/prisma/index.js');
const prismaCli = fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));
const migrationSqlPath = fileURLToPath(
  new URL('../../../prisma/migrations/20261103000000_playlist_name_key/migration.sql', import.meta.url),
);

describe('playlist nameKey startup finalisation (db push companion)', () => {
  it('legacy copy: db push → preview → finalize → create/rename → restart idempotent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-namekey-startup-'));
    const legacyPath = path.join(root, 'legacy.db');
    const url = `file:${legacyPath}`;

    // Build a minimal pre-nameKey legacy DB, then copy path semantics via reopen.
    const bootstrap = new PrismaClient({ datasources: { db: { url } } });
    try {
      await bootstrap.$executeRawUnsafe(`
        CREATE TABLE "Playlist" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "name" TEXT NOT NULL,
          "mode" TEXT NOT NULL DEFAULT 'stream',
          "serverConfigId" INTEGER,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await bootstrap.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "mode", "serverConfigId") VALUES ('Morning', 'stream', 1)`,
      );
      const stage1 = await readFile(migrationSqlPath, 'utf8');
      for (const statement of stage1.replace(/^--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) {
        await bootstrap.$executeRawUnsafe(statement);
      }
    } finally {
      await bootstrap.$disconnect();
    }

    // Simulate remaining schema via db push (adds other columns Prisma expects).
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });

    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      // Parent row required once Prisma FK is active after db push.
      await prisma.tsServerConfig.create({
        data: { id: 1, name: 'Legacy Copy', host: '127.0.0.1', apiKey: 'x' },
      });

      const preview = await previewPlaylistNameKeyMigration(prisma as any);
      assert.equal(preview.constraintsReady, false);
      assert.equal(preview.conflicts.length, 0);
      assert.equal(preview.emptyNormalized.length, 0);
      assert.equal(preview.compatible, true);
      assert.ok(preview.wouldBackfill >= 1);

      const first = await finalizePlaylistNameKeyMigration(prisma as any);
      assert.ok(first.backfilled >= 1);
      assert.equal(await playlistNameKeyConstraintsReady(prisma as any), true);

      // Restart / reconcile: second finalize is a no-op.
      const second = await finalizePlaylistNameKeyMigration(prisma as any);
      assert.equal(second.backfilled, 0);
      assert.equal(await playlistNameKeyConstraintsReady(prisma as any), true);

      const rows = await prisma.playlist.findMany();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Morning');
      assert.equal(rows[0].nameKey, 'morning');

      const allocated = await allocateUniquePlaylistDisplayName(prisma as any, 'Evening', 1);
      await prisma.playlist.create({
        data: {
          name: allocated.displayName,
          nameKey: allocated.nameKey,
          mode: 'stream',
          serverConfigId: 1,
        },
      });
      // Rename keeps uniqueness: "Morning" stays free when excluding self; pick a new name.
      const renamed = await allocateUniquePlaylistDisplayName(prisma as any, 'Sunrise', 1, { excludeId: rows[0].id });
      assert.equal(renamed.nameKey, 'sunrise');
      await prisma.playlist.update({
        where: { id: rows[0].id },
        data: { name: renamed.displayName, nameKey: renamed.nameKey },
      });
      const after = await prisma.playlist.findUnique({ where: { id: rows[0].id } });
      assert.equal(after?.nameKey, 'sunrise');
      // Creating another "Sunrise" allocates a disambiguated key without destroying rows.
      const clash = await allocateUniquePlaylistDisplayName(prisma as any, 'Sunrise', 1);
      assert.equal(clash.nameKey, 'sunrise (2)');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('duplicate names refuse finalisation without destroying rows', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-namekey-dup-'));
    const url = `file:${path.join(root, 'dup.db')}`;
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.tsServerConfig.create({
        data: { id: 1, name: 'Dup Fixture', host: '127.0.0.1', apiKey: 'x' },
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Playlist" ("name", "nameKey", "mode", "serverConfigId", "createdAt") VALUES
          ('Rock', '', 'stream', 1, CURRENT_TIMESTAMP),
          ('ROCK', '', 'stream', 1, CURRENT_TIMESTAMP)`,
      );
      const preview = await previewPlaylistNameKeyMigration(prisma as any);
      assert.equal(preview.compatible, false);
      assert.ok(preview.conflicts.some((c) => c.nameKey === 'rock'));
      await assert.rejects(
        () => finalizePlaylistNameKeyMigration(prisma as any),
        /conflicts block uniqueness/i,
      );
      assert.equal(await prisma.playlist.count(), 2);
      assert.equal(await playlistNameKeyConstraintsReady(prisma as any), false);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });
});
