import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { playlistRoutes } from './playlists.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fixture() {
  let nextId = 1;
  const playlists = new Map<number, any>();
  const audit: any[] = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, role: 'admin', username: 'tester' };
    next();
  });
  const playlistApi = {
    findMany: async () =>
      [...playlists.values()]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((p) => ({ ...p, _count: { songs: 0 } })),
    findUnique: async ({ where }: any) => {
      const row = playlists.get(where.id);
      if (!row) return null;
      return { ...row, songs: [] };
    },
    create: async ({ data }: any) => {
      const row = {
        id: nextId++,
        name: data.name,
        mode: data.mode ?? 'local',
        remoteAccess: data.remoteAccess ?? 'hidden',
        musicBotId: data.musicBotId ?? null,
        youtubePlaylistId: null,
        serverConfigId: data.serverConfigId ?? null,
        createdAt: new Date('2026-11-06T00:00:00Z'),
      };
      playlists.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = playlists.get(where.id);
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
      Object.assign(row, data);
      return row;
    },
  };
  const adminAuditEvent = {
    create: async ({ data }: any) => {
      audit.push({ ...data });
      return { id: 'event', operationId: data.operationId };
    },
  };
  app.locals.prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ playlist: playlistApi, adminAuditEvent }),
    tsServerConfig: {
      findUnique: async ({ where }: any) => (where.id === 1 ? { id: 1 } : null),
    },
    playlist: playlistApi,
    adminAuditEvent,
  };
  app.use('/playlists', playlistRoutes);
  app.use(errorHandler);
  return { app, playlists, audit };
}

describe('playlist remoteAccess', () => {
  it('defaults new playlists to hidden and exposes remoteAccess on list/get/create', async () => {
    const f = fixture();
    const created = await request(f.app, 'POST', '/playlists', { name: 'Quiet', serverConfigId: 1 });
    assert.equal(created.status, 201);
    assert.equal(created.body.remoteAccess, 'hidden');
    assert.equal(f.playlists.get(1).remoteAccess, 'hidden');
    assert.equal(f.audit.length, 0);

    const listed = await request(f.app, 'GET', '/playlists');
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].remoteAccess, 'hidden');

    const detail = await request(f.app, 'GET', '/playlists/1');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.remoteAccess, 'hidden');
  });

  it('updates remoteAccess and audits only when visibility changes', async () => {
    const f = fixture();
    await request(f.app, 'POST', '/playlists', { name: 'Shareable' });

    const toBrowse = await request(f.app, 'PUT', '/playlists/1', { remoteAccess: 'browse' });
    assert.equal(toBrowse.status, 200);
    assert.equal(f.playlists.get(1).remoteAccess, 'browse');
    assert.equal(f.audit.length, 1);
    assert.equal(f.audit[0].action, 'playlist.remote_access_update');
    assert.equal(f.audit[0].outcome, 'success');
    assert.equal(f.audit[0].targetType, 'playlist');
    assert.equal(f.audit[0].targetId, '1');

    const same = await request(f.app, 'PUT', '/playlists/1', { remoteAccess: 'browse', name: 'Shareable' });
    assert.equal(same.status, 200);
    assert.equal(f.audit.length, 1, 'unchanged visibility is not audited again');

    const toRequest = await request(f.app, 'PUT', '/playlists/1', { remoteAccess: 'request' });
    assert.equal(toRequest.status, 200);
    assert.equal(f.playlists.get(1).remoteAccess, 'request');
    assert.equal(f.audit.length, 2);

    const detail = await request(f.app, 'GET', '/playlists/1');
    assert.equal(detail.body.remoteAccess, 'request');
  });

  it('rejects invalid remoteAccess before writes or audits', async () => {
    const f = fixture();
    await request(f.app, 'POST', '/playlists', { name: 'Quiet' });

    const badCreate = await request(f.app, 'POST', '/playlists', { name: 'Bad', remoteAccess: 'public' });
    assert.equal(badCreate.status, 400);
    assert.equal(f.playlists.size, 1);

    const badUpdate = await request(f.app, 'PUT', '/playlists/1', { remoteAccess: 'public' });
    assert.equal(badUpdate.status, 400);
    assert.equal(f.playlists.get(1).remoteAccess, 'hidden');
    assert.equal(f.audit.length, 0);
  });

  it('audits create when remoteAccess starts as browse or request', async () => {
    const f = fixture();
    const created = await request(f.app, 'POST', '/playlists', { name: 'Open', remoteAccess: 'browse' });
    assert.equal(created.status, 201);
    assert.equal(created.body.remoteAccess, 'browse');
    assert.equal(f.audit.length, 1);
    assert.equal(f.audit[0].action, 'playlist.remote_access_update');
    assert.equal(f.audit[0].targetId, '1');
  });
});
