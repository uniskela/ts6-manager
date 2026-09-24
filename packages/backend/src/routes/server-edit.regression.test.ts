import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { serverRoutes } from './servers.routes.js';
import { decrypt } from '../utils/crypto.js';

test('create then edit SSH settings persists encrypted secrets and refreshes event/file connections', async () => {
  let stored: any;
  const refreshed: string[] = [];
  const apiKey = randomBytes(32).toString('hex');
  const password = randomBytes(32).toString('hex');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, role: 'admin' } as any; next(); });
  app.locals.prisma = {
    tsServerConfig: {
      create: async ({ data }: any) => { stored = { id: 1, ...data, sshFingerprint: 'unchanged' }; return stored; },
      update: async ({ where, data }: any) => { assert.equal(where.id, 1); Object.assign(stored, data); return stored; },
    },
    botFlow: { findMany: async () => [{ id: 3 }] },
    adminAuditEvent: {
      create: async ({ data }: any) => ({ id: 'audit1', ...data }),
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (fn: any) => fn(app.locals.prisma),
  };
  app.locals.connectionPool = {
    addClient: () => {},
    syncMetricsClient: () => {},
    refreshClient: async () => { assert.equal(decrypt(stored.apiKey), apiKey); refreshed.push('webquery'); },
  };
  app.locals.botEngine = {
    getEventBridge: () => ({ reconnectConfig: async (id: number) => {
      assert.equal(id, 1);
      assert.equal(decrypt(stored.sshPassword), password);
      assert.equal(stored.sshUsername, 'serveradmin');
      // File routes use this same EventBridge, not a separate credential cache.
      refreshed.push('event/file SSH');
    } }),
    reloadFlow: async (id: number) => { assert.equal(id, 3); refreshed.push('flow'); },
  };
  app.use('/servers', serverRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/servers`;
  const send = (path: string, method: string, body: unknown) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await send('', 'POST', { name: 'test', host: 'localhost', apiKey })).status, 201);
    for (const port of [10022, 10023]) {
      assert.equal((await send('/1', 'PUT', { sshPort: port, sshUsername: 'serveradmin', sshPassword: password, apiKey: '' })).status, 200);
      assert.equal(stored.sshPort, port);
      assert.notEqual(stored.sshPassword, password);
      assert.equal(stored.sshFingerprint, 'unchanged');
    }
    const ciphertext = stored.sshPassword;
    assert.equal((await send('/1', 'PUT', { sshPassword: '', sshUsername: '', apiKey: '' })).status, 200);
    assert.equal(stored.sshPassword, ciphertext);
    assert.deepEqual(refreshed, Array(3).fill(['webquery', 'event/file SSH', 'flow']).flat());
    assert.equal(stored.id, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
