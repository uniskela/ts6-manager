import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { playlistRoutes } from './playlists.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fixture(existingSongIds: number[] = [], conflicts = 0) {
  const songs = [
    { id: 1, source: 'youtube' },
    { id: 2, source: 'youtube' },
    { id: 3, source: 'url' },
    { id: 4, source: 'local' },
  ];
  const links = existingSongIds.map((songId, position) => ({ playlistId: 7, songId, position }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, role: 'admin', username: 'tester' };
    next();
  });
  const prisma: any = {
    transactions: 0,
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      prisma.transactions++;
      if (conflicts-- > 0) throw Object.assign(new Error('write conflict'), { code: 'P2034' });
      return fn(prisma);
    },
    playlist: {
      findUnique: async ({ where }: any) =>
        where.id === 7 ? { id: 7, mode: 'stream', youtubePlaylistId: null } : null,
    },
    song: {
      findMany: async ({ where }: any) => songs.filter((s) => where.id.in.includes(s.id)),
    },
    playlistSong: {
      aggregate: async () => ({
        _max: { position: links.length ? Math.max(...links.map((l) => l.position)) : null },
      }),
      findUnique: async ({ where }: any) =>
        links.find((l) => l.songId === where.playlistId_songId.songId) ?? null,
      create: async ({ data }: any) => {
        links.push(data);
        return data;
      },
    },
  };
  app.locals.prisma = prisma;
  app.use('/playlists', playlistRoutes);
  app.use(errorHandler);
  return { app, links, prisma };
}

describe('POST /playlists/:id/songs', () => {
  it('adds several songs in order and counts only new rows', async () => {
    const f = fixture([2]);
    const res = await post(f.app, '/playlists/7/songs', { songIds: [1, 2, 3, 1] });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { success: true, added: 2, alreadyInPlaylist: 1 });
    assert.deepEqual(f.links.map((l) => [l.songId, l.position]), [[2, 0], [1, 1], [3, 2]]);
  });

  it('still accepts a single songId', async () => {
    const f = fixture();
    const res = await post(f.app, '/playlists/7/songs', { songId: 3 });
    assert.equal(res.status, 201);
    assert.equal(res.body.added, 1);
  });

  it('reports an already-present single song as not added', async () => {
    const f = fixture([1]);
    const res = await post(f.app, '/playlists/7/songs', { songId: 1 });
    assert.deepEqual(res.body, { success: true, added: 0, alreadyInPlaylist: 1 });
  });

  it('rejects songs that do not match the playlist mode without adding any', async () => {
    const f = fixture();
    const res = await post(f.app, '/playlists/7/songs', { songIds: [1, 4] });
    assert.equal(res.status, 400);
    assert.equal(f.links.length, 0);
  });

  it('retries the whole batch after a write conflict', async () => {
    const f = fixture([], 1);
    const res = await post(f.app, '/playlists/7/songs', { songIds: [1, 2] });
    assert.equal(res.status, 201);
    assert.equal(res.body.added, 2);
    assert.equal(f.prisma.transactions, 2);
  });

  it('gives up after repeated write conflicts', async () => {
    const f = fixture([], 5);
    const res = await post(f.app, '/playlists/7/songs', { songIds: [1] });
    assert.equal(res.status, 500);
    assert.equal(f.prisma.transactions, 3);
    assert.equal(f.links.length, 0);
  });

  it('rejects unknown songs', async () => {
    const f = fixture();
    const res = await post(f.app, '/playlists/7/songs', { songIds: [1, 99] });
    assert.equal(res.status, 404);
    assert.equal(f.links.length, 0);
  });
});
