import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { radioStationRoutes } from './radio-stations.routes.js';
import { requireServerAccess } from '../middleware/server-access.js';
import { errorHandler } from '../middleware/error-handler.js';

async function send(app: Express, method: string, path: string, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fixture(role: 'admin' | 'viewer' | null = 'admin', hasAccess = true) {
  const original = {
    id: 7, serverConfigId: 1, name: 'Original station', url: 'https://8.8.8.8/live',
    genre: 'Rock', imageUrl: 'https://example.com/logo.png', createdAt: new Date('2026-10-01'),
  };
  const row = { ...original };
  const writes: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!role) { res.status(401).json({ error: 'Not authenticated' }); return; }
    req.user = { id: 1, role, username: 'tester' };
    next();
  });
  app.locals.prisma = {
    userServerAccess: { findUnique: async () => hasAccess ? {} : null },
    radioStation: {
      findFirst: async ({ where }: any) => row.id === where.id && row.serverConfigId === where.serverConfigId ? { ...row } : null,
      update: async ({ where, data }: any) => {
        assert.deepEqual(where, { id: 7, serverConfigId: 1 }, 'the write must also be scoped to the server');
        writes.push(data);
        Object.assign(row, data);
        return { ...row };
      },
      create: async ({ data }: any) => { writes.push(data); return { id: 8, ...data }; },
    },
  };
  app.use('/api/servers/:configId/radio-stations', requireServerAccess(), radioStationRoutes);
  app.use(errorHandler);
  return { app, original, row, writes };
}

const stationPath = '/api/servers/1/radio-stations/7';

describe('radio station edit', () => {
  it('updates name, url and genre', async () => {
    const f = fixture();
    const response = await send(f.app, 'PUT', stationPath, {
      name: '  New station  ', url: 'https://1.1.1.1/stream', genre: 'Chill',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.name, 'New station');
    assert.equal(response.body.url, 'https://1.1.1.1/stream');
    assert.equal(response.body.genre, 'Chill');
    assert.equal(f.row.name, 'New station');
    assert.equal(f.row.url, 'https://1.1.1.1/stream');
    assert.equal(f.row.genre, 'Chill');
    assert.equal(f.row.imageUrl, f.original.imageUrl);
  });

  for (const url of ['http://192.168.1.10/live', 'file:///etc/passwd', 'http://metadata.google.internal/live', 'http://169.254.169.254/latest/meta-data']) {
    it(`rejects a blocked url with the add-station message: ${url}`, async () => {
      const f = fixture();
      const added = await send(f.app, 'POST', '/api/servers/1/radio-stations', { name: 'Blocked', url });
      const edited = await send(f.app, 'PUT', stationPath, { name: 'Changed', genre: 'Party', url });
      assert.equal(added.status, 400);
      assert.equal(edited.status, 400);
      assert.deepEqual(edited.body, added.body);
      assert.deepEqual(f.row, f.original);
      assert.deepEqual(f.writes, []);
    });
  }

  it('404 for a station on another server', async () => {
    const f = fixture();
    const response = await send(f.app, 'PUT', '/api/servers/2/radio-stations/7', { name: 'Changed' });
    assert.equal(response.status, 404);
    assert.deepEqual(f.row, f.original);
    assert.deepEqual(f.writes, []);
  });

  it('404 for an unknown station', async () => {
    const f = fixture();
    assert.equal((await send(f.app, 'PUT', '/api/servers/1/radio-stations/999', { name: 'Changed' })).status, 404);
    assert.deepEqual(f.writes, []);
  });

  for (const genre of ['', null]) {
    it(`${JSON.stringify(genre)} genre clears it without changing omitted fields`, async () => {
      const f = fixture();
      const response = await send(f.app, 'PUT', stationPath, { genre });
      assert.equal(response.status, 200);
      assert.equal(response.body.genre, null);
      assert.deepEqual(f.row, { ...f.original, genre: null });
    });
  }

  for (const name of ['', '   ', null, 42]) {
    it(`400 when name is empty after trim or not a string: ${JSON.stringify(name)}`, async () => {
      const f = fixture();
      assert.equal((await send(f.app, 'PUT', stationPath, { name })).status, 400);
      assert.deepEqual(f.row, f.original);
      assert.deepEqual(f.writes, []);
    });
  }

  for (const data of [{ url: null }, { url: 42 }, { genre: 42 }]) {
    it(`400 for malformed editable fields: ${JSON.stringify(data)}`, async () => {
      const f = fixture();
      assert.equal((await send(f.app, 'PUT', stationPath, data)).status, 400);
      assert.deepEqual(f.row, f.original);
      assert.deepEqual(f.writes, []);
    });
  }

  it('does not accept server or image changes from the request body', async () => {
    const f = fixture();
    assert.equal((await send(f.app, 'PUT', stationPath, { name: 'Changed', serverConfigId: 2, imageUrl: 'changed' })).status, 200);
    assert.deepEqual(f.row, { ...f.original, name: 'Changed' });
  });

  for (const [role, access, status] of [['viewer', false, 403], ['viewer', true, 403], [null, true, 401]] as const) {
    it(`refuses edits for ${role ?? 'unauthenticated'} users (access=${access})`, async () => {
      const f = fixture(role, access);
      assert.equal((await send(f.app, 'PUT', stationPath, { name: 'Changed' })).status, status);
      assert.deepEqual(f.writes, []);
    });
  }
});
