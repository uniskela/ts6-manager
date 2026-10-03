import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '../../generated/prisma/index.js';

const directory = mkdtempSync(join(tmpdir(), 'iptv-metadata-schema-'));
const databaseUrl = `file:${join(directory, 'test.db')}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

before(() => {
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
  });
});
after(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

it('adds nullable country and language columns to IPTV channels', async () => {
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string; notnull: bigint }>>('PRAGMA table_info("IptvChannel")');
  assert.deepEqual(columns.filter((column) => ['tvgCountry', 'tvgLanguage'].includes(column.name)).map((column) => [column.name, Number(column.notnull)]), [['tvgCountry', 0], ['tvgLanguage', 0]]);
});

it('migrates an existing channel without backfilling its metadata', async () => {
  const legacy = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'legacy.db')}` } } });
  try {
    await legacy.$executeRawUnsafe('CREATE TABLE "IptvChannel" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)');
    await legacy.$executeRawUnsafe('INSERT INTO "IptvChannel" ("id", "name") VALUES (1, \'Existing\')');
    const migration = readFileSync(new URL('../../prisma/migrations/20261003010000_iptv_country_language/migration.sql', import.meta.url), 'utf8');
    for (const statement of migration.replace(/^--.*$/gm, '').split(';').map((part) => part.trim()).filter(Boolean)) await legacy.$executeRawUnsafe(statement);
    assert.deepEqual(await legacy.$queryRawUnsafe('SELECT "name", "tvgCountry", "tvgLanguage" FROM "IptvChannel"'), [{ name: 'Existing', tvgCountry: null, tvgLanguage: null }]);
  } finally { await legacy.$disconnect(); }
});
