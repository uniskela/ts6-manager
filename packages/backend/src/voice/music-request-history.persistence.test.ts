import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PrismaClient } from '../../generated/prisma/index.js';
import { musicRequestListWhere, recordMusicRequest } from './music-request-history.js';

const prismaCli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));
const currentSchema = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

test('schema upgrade and a new client preserve legacy history and bounded per-bot requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ts6-history-db-'));
  const url = `file:${path.join(root, 'history.db')}`;
  const oldSchema = path.join(root, 'legacy.prisma');
  // The pre-history models: no per-bot key, metadata, or availability status.
  await writeFile(oldSchema, `
    datasource db {\n provider = "sqlite"\n url = env("DATABASE_URL")\n }
    model TsServerConfig {\n id Int @id @default(autoincrement())\n name String\n host String\n apiKey String\n updatedAt DateTime @updatedAt\n musicRequests MusicRequest[]\n }
    model MusicRequest {\n id Int @id @default(autoincrement())\n title String\n url String\n serverConfigId Int\n serverConfig TsServerConfig @relation(fields: [serverConfigId], references: [id], onDelete: Cascade)\n requestedAt DateTime @default(now())\n @@unique([serverConfigId, url])\n }
  `);
  const push = (schema: string) => execFileSync(process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--schema', schema],
    { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  let db = new PrismaClient({ datasources: { db: { url } } });
  try {
    push(oldSchema);
    await db.$executeRaw`INSERT INTO "TsServerConfig" (id, name, host, apiKey, updatedAt) VALUES (1, 'Demo', 'demo.test', 'unused', ${new Date()})`;
    await db.$executeRaw`INSERT INTO "MusicRequest" (id, title, url, serverConfigId, requestedAt) VALUES (1, 'Legacy title', 'https://example.test/legacy', 1, ${new Date()})`;
    await db.$disconnect();
    push(currentSchema);
    db = new PrismaClient({ datasources: { db: { url } } });
    const legacy = await db.musicRequest.findUniqueOrThrow({ where: { id: 1 } });
    assert.equal(legacy.title, 'Legacy title');
    assert.equal(legacy.url, 'https://example.test/legacy');
    assert.equal(legacy.musicBotId, 0);
    assert.equal(legacy.source, 'url');
    assert.equal(legacy.status, 'available');

    const input = { serverConfigId: 1, musicBotId: 4, title: 'Track', artist: 'Artist', duration: 42, source: 'youtube' };
    for (const suffix of ['first', 'second', 'third']) {
      await recordMusicRequest(db, { ...input, url: `https://example.test/${suffix}` }, 2);
    }
    await recordMusicRequest(db, { ...input, musicBotId: 8, url: 'https://example.test/third' }, 2);
    await db.$disconnect();
    db = new PrismaClient({ datasources: { db: { url } } });
    const history = await db.musicRequest.findMany({ where: musicRequestListWhere(1, 4) });
    assert.equal(history.length, 3); // two per-bot rows plus the legacy row
    assert.equal(history.some(row => row.url === 'https://example.test/first'), false);
    assert.equal(history.filter(row => row.musicBotId === 4).every(row => row.artist === 'Artist' && row.duration === 42), true);
    assert.equal(await db.musicRequest.count({ where: { musicBotId: 8 } }), 1);
  } finally {
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
