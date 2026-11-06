import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { DEFAULT_PLAYLIST_VOTE_SETTINGS } from '@ts6/common';
import { playlistVoteSettingsRoutes } from './playlist-vote-settings.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { playlistVoteSettingsKey } from '../voice/playlist-vote-settings.js';

async function fixture(role?: string) {
  const rows = new Map<string, string>();
  const audit: any[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) (req as any).user = { id: 1, username: 'test', role };
    next();
  });
  const prisma: any = {
    appSetting: {
      findUnique: async ({ where }: any) => rows.has(where.key) ? { value: rows.get(where.key) } : null,
      upsert: async ({ where, create }: any) => { rows.set(where.key, create.value); },
    },
    adminAuditEvent: {
      create: async ({ data }: any) => { audit.push(data); return { id: 'event' }; },
    },
    $transaction: async (write: (tx: unknown) => Promise<unknown>) => write({
      appSetting: {
        upsert: async ({ where, create }: any) => { rows.set(where.key, create.value); },
      },
      adminAuditEvent: {
        create: async ({ data }: any) => { audit.push(data); return { id: 'event' }; },
      },
    }),
  };
  app.locals.prisma = prisma;
  app.use('/servers/:configId/playlist-vote-settings', playlistVoteSettingsRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    base: `http://127.0.0.1:${address.port}/servers`,
    rows,
    audit,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

describe('playlist vote settings routes', () => {
  it('requires admin for reading and changing settings', async () => {
    for (const [role, status] of [[undefined, 401], ['viewer', 403], ['operator', 403]] as const) {
      const { base, close, rows, audit } = await fixture(role);
      try {
        for (const method of ['GET', 'PUT']) {
          assert.equal((await fetch(`${base}/1/playlist-vote-settings/1`, {
            method,
            headers: method === 'PUT' ? { 'Content-Type': 'application/json' } : undefined,
            body: method === 'PUT' ? JSON.stringify(DEFAULT_PLAYLIST_VOTE_SETTINGS) : undefined,
          })).status, status);
        }
        assert.equal(rows.size, 0);
        assert.equal(audit.length, 0);
      } finally { await close(); }
    }
  });

  it('returns defaults and persists settings for the selected virtual server with an audit row', async () => {
    const { base, close, rows, audit } = await fixture('admin');
    try {
      assert.deepEqual(
        await (await fetch(`${base}/1/playlist-vote-settings/1`)).json(),
        DEFAULT_PLAYLIST_VOTE_SETTINGS,
      );
      const settings = { enabled: true, thresholdPercent: 75, maxRequestSize: 40 };
      const response = await fetch(`${base}/1/playlist-vote-settings/2`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), settings);
      assert.deepEqual(await (await fetch(`${base}/1/playlist-vote-settings/2`)).json(), settings);
      assert.deepEqual(await (await fetch(`${base}/1/playlist-vote-settings/1`)).json(), DEFAULT_PLAYLIST_VOTE_SETTINGS);
      assert.deepEqual(await (await fetch(`${base}/2/playlist-vote-settings/2`)).json(), DEFAULT_PLAYLIST_VOTE_SETTINGS);
      assert.equal(rows.get(playlistVoteSettingsKey(1, 2)), JSON.stringify(settings));
      assert.equal(audit.length, 1);
      assert.equal(audit[0].action, 'settings.playlist_vote_update');
      assert.equal(audit[0].outcome, 'success');
      assert.equal(audit[0].connectionId, 1);
      assert.equal(audit[0].virtualServerId, 2);
      assert.equal(audit[0].targetId, 'playlist-vote');
    } finally { await close(); }
  });

  it('rejects invalid scope and malformed updates without writes or audits', async () => {
    const { base, close, rows, audit } = await fixture('admin');
    try {
      for (const path of ['0/playlist-vote-settings/1', '1/playlist-vote-settings/0', '1/playlist-vote-settings/1x']) {
        assert.equal((await fetch(`${base}/${path}`)).status, 400);
      }
      for (const body of [{}, { enabled: true, thresholdPercent: 80 }, { ...DEFAULT_PLAYLIST_VOTE_SETTINGS, thresholdPercent: 0 }]) {
        const response = await fetch(`${base}/1/playlist-vote-settings/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
      }
      assert.equal(rows.size, 0);
      assert.equal(audit.length, 0);
    } finally { await close(); }
  });
});
