import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import express, { type Express } from 'express';
import { radioStationRoutes } from './radio-stations.routes.js';
import { requireServerAccess } from '../middleware/server-access.js';
import { errorHandler } from '../middleware/error-handler.js';
import { radioBrowser } from '../utils/radio-browser.js';

async function send(app: Express, path: string) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await response.text();
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fixture(role: 'admin' | 'viewer' = 'admin') {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 1, role, username: 'tester' };
    next();
  });
  app.locals.prisma = {
    userServerAccess: { findUnique: async () => ({}) },
  };
  app.use('/api/servers/:configId/radio-stations', requireServerAccess(), radioStationRoutes);
  app.use(errorHandler);
  return app;
}

describe('radio station browse', () => {
  it('searches Radio Browser for admins', async () => {
    const search = mock.method(radioBrowser, 'searchStations', async () => [{
      stationuuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'Jazz',
      url: 'https://stream.example/live',
      genre: 'jazz',
      imageUrl: null,
      countrycode: 'DE',
      codec: 'MP3',
      bitrate: 128,
    }]);
    try {
      const response = await send(fixture(), '/api/servers/1/radio-stations/browse?q=jazz');
      assert.equal(response.status, 200);
      assert.equal(response.body[0].name, 'Jazz');
      assert.equal(search.mock.callCount(), 1);
      assert.deepEqual(search.mock.calls[0].arguments[0], {
        name: 'jazz',
        tag: '',
        countrycode: '',
        limit: undefined,
      });
    } finally {
      search.mock.restore();
    }
  });

  it('requires a search field', async () => {
    const response = await send(fixture(), '/api/servers/1/radio-stations/browse');
    assert.equal(response.status, 400);
    assert.match(response.body.error, /search query/i);
  });

  it('rejects viewers', async () => {
    const response = await send(fixture('viewer'), '/api/servers/1/radio-stations/browse?q=jazz');
    assert.equal(response.status, 403);
  });
});
