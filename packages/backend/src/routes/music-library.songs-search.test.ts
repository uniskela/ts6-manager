import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/error-handler.js';

// music-library.routes creates MUSIC_DIR on import; keep it out of /data in tests.
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-songs-search-'));
const previousMusicDir = process.env.MUSIC_DIR;
process.env.MUSIC_DIR = musicDir;
const { musicLibraryRoutes } = await import('./music-library.routes.js');
after(() => {
  if (previousMusicDir === undefined) delete process.env.MUSIC_DIR;
  else process.env.MUSIC_DIR = previousMusicDir;
  fs.rmSync(musicDir, { recursive: true, force: true });
});

async function send(app: Express, pathName: string) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathName}`);
    const text = await response.text();
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const songs = [
  {
    id: 1, title: 'Neon Skyline', artist: 'Midnight Transit', duration: 214,
    filePath: '/a.ogg', source: 'local', sourceUrl: null, fileSize: 1,
    serverConfigId: 1, createdAt: new Date('2026-10-02'),
  },
  {
    id: 2, title: 'Quiet Morning', artist: 'Neon Pulse', duration: 180,
    filePath: '/b.ogg', source: 'local', sourceUrl: null, fileSize: 1,
    serverConfigId: 1, createdAt: new Date('2026-10-01'),
  },
  {
    id: 3, title: 'Other Server Track', artist: 'Someone', duration: 100,
    filePath: '/c.ogg', source: 'local', sourceUrl: null, fileSize: 1,
    serverConfigId: 2, createdAt: new Date('2026-10-03'),
  },
  {
    id: 4, title: 'Alpha', artist: null, duration: 90,
    filePath: '/d.ogg', source: 'local', sourceUrl: null, fileSize: 1,
    serverConfigId: 1, createdAt: new Date('2026-09-30'),
  },
];

/** SQLite LIKE via Prisma `contains` is case-insensitive for ASCII. */
function matchesWhere(row: Record<string, unknown>, where?: any): boolean {
  return !where || Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as any[]).some((c) => matchesWhere(row, c));
    if (value && typeof value === 'object' && 'contains' in value) {
      const hay = String(row[key] ?? '').toLowerCase();
      return hay.includes(String((value as { contains: string }).contains).toLowerCase());
    }
    return row[key] === value;
  });
}

function routeFixture() {
  let lastFindMany: unknown = 'unset';
  let lastCount: unknown = 'unset';
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 1, role: 'admin', username: 'tester' };
    next();
  });
  app.locals.prisma = {
    song: {
      findMany: async (args: { where?: any; skip?: number; take?: number; orderBy?: any }) => {
        lastFindMany = args;
        let rows = songs.filter((row) => matchesWhere(row, args.where));
        if (args.orderBy?.createdAt === 'desc') {
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        const skip = args.skip ?? 0;
        const take = args.take ?? rows.length;
        return rows.slice(skip, skip + take);
      },
      count: async ({ where }: { where?: any }) => {
        lastCount = where;
        return songs.filter((row) => matchesWhere(row, where)).length;
      },
    },
  };
  app.use('/servers/:configId/music-library', musicLibraryRoutes);
  app.use(errorHandler);
  return {
    app,
    get lastFindMany() { return lastFindMany; },
    get lastCount() { return lastCount; },
  };
}

describe('GET /songs/search', () => {
  it('matches title or artist case-insensitively and pages results', async () => {
    const f = routeFixture();
    const response = await send(f.app, '/servers/1/music-library/songs/search?search=neon&page=1&pageSize=50');
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 2);
    assert.equal(response.body.page, 1);
    assert.equal(response.body.pageSize, 50);
    assert.deepEqual(response.body.songs.map((s: { id: number }) => s.id), [1, 2]);
    assert.deepEqual(f.lastCount, {
      serverConfigId: 1,
      OR: [
        { title: { contains: 'neon' } },
        { artist: { contains: 'neon' } },
      ],
    });
  });

  it('defaults page to 1 and pageSize to 50, and caps pageSize at 100', async () => {
    const f = routeFixture();
    const defaults = await send(f.app, '/servers/1/music-library/songs/search');
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.page, 1);
    assert.equal(defaults.body.pageSize, 50);
    assert.equal((f.lastFindMany as { skip: number; take: number }).skip, 0);
    assert.equal((f.lastFindMany as { take: number }).take, 50);

    const capped = await send(f.app, '/servers/1/music-library/songs/search?pageSize=250');
    assert.equal(capped.status, 200);
    assert.equal(capped.body.pageSize, 100);
    assert.equal((f.lastFindMany as { take: number }).take, 100);
  });

  it('rejects a page or pageSize that is not a positive whole number', async () => {
    for (const qs of [
      'page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=1e300',
      'pageSize=0', 'pageSize=-2', 'pageSize=2.5', 'pageSize=nope', 'pageSize=1e300',
    ]) {
      const f = routeFixture();
      const response = await send(f.app, `/servers/1/music-library/songs/search?${qs}`);
      assert.equal(response.status, 400, qs);
      assert.equal(f.lastFindMany, 'unset', qs);
    }
  });

  it('never returns another server\'s songs', async () => {
    const f = routeFixture();
    const response = await send(f.app, '/servers/1/music-library/songs/search?search=');
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 3);
    assert.ok(response.body.songs.every((s: { serverConfigId: number }) => s.serverConfigId === 1));
    assert.equal((f.lastCount as { serverConfigId: number }).serverConfigId, 1);
  });

  it('pages with skip/take for a later page', async () => {
    const f = routeFixture();
    const response = await send(f.app, '/servers/1/music-library/songs/search?page=2&pageSize=2');
    assert.equal(response.status, 200);
    assert.equal(response.body.page, 2);
    assert.equal(response.body.pageSize, 2);
    assert.equal(response.body.total, 3);
    assert.equal(response.body.songs.length, 1);
    assert.equal((f.lastFindMany as { skip: number; take: number }).skip, 2);
    assert.equal((f.lastFindMany as { take: number }).take, 2);
  });

  it('leaves GET /songs unchanged (full list, no paging wrapper)', async () => {
    const f = routeFixture();
    const response = await send(f.app, '/servers/1/music-library/songs');
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body));
    assert.deepEqual(response.body.map((s: { id: number }) => s.id), [1, 2, 4]);
  });
});
