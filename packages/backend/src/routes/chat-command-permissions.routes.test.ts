import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { chatCommandRoutes } from './chat-commands.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';

async function fixture(role?: string) {
  const rows = new Map<string, string>();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) (req as any).user = { id: 1, username: 'test', role };
    next();
  });
  app.locals.prisma = { appSetting: {
    findUnique: async ({ where }: any) => rows.has(where.key) ? { value: rows.get(where.key) } : null,
    upsert: async ({ where, create }: any) => { rows.set(where.key, create.value); },
  } };
  app.use('/servers/:configId/chat-commands', chatCommandRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    base: `http://127.0.0.1:${address.port}/servers`, rows,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

describe('admin command permission routes', () => {
  it('requires admin for reading and changing policies', async () => {
    for (const [role, status] of [[undefined, 401], ['viewer', 403], ['operator', 403]] as const) {
      const { base, close, rows } = await fixture(role);
      try {
        for (const method of ['GET', 'PUT']) {
          assert.equal((await fetch(`${base}/1/chat-commands/permissions/1`, { method })).status, status);
        }
        assert.equal(rows.size, 0);
      } finally { await close(); }
    }
  });

  it('returns upgrade defaults and persists full policies for the selected virtual server', async () => {
    const { base, close } = await fixture('admin');
    try {
      assert.deepEqual(await (await fetch(`${base}/1/chat-commands/permissions/1`)).json(), defaultMediaCommandPermissions());
      const policy = { ...defaultMediaCommandPermissions(), queue: { mode: 'server_groups', serverGroupIds: [7, 8] } };
      const response = await fetch(`${base}/1/chat-commands/permissions/2`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), policy);
      assert.deepEqual(await (await fetch(`${base}/1/chat-commands/permissions/2`)).json(), policy);
      assert.deepEqual(await (await fetch(`${base}/1/chat-commands/permissions/1`)).json(), defaultMediaCommandPermissions());
      assert.deepEqual(await (await fetch(`${base}/2/chat-commands/permissions/2`)).json(), defaultMediaCommandPermissions());
    } finally { await close(); }
  });

  it('rejects invalid scope and incomplete or malformed updates without writes', async () => {
    const { base, close, rows } = await fixture('admin');
    try {
      for (const path of ['0/chat-commands/permissions/1', '1/chat-commands/permissions/0', '1/chat-commands/permissions/1x']) {
        assert.equal((await fetch(`${base}/${path}`)).status, 400);
      }
      for (const policy of [{}, { ...defaultMediaCommandPermissions(), video: { mode: 'server_groups', serverGroupIds: ['7'] } }]) {
        const response = await fetch(`${base}/1/chat-commands/permissions/1`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy),
        });
        assert.equal(response.status, 400);
      }
      assert.equal(rows.size, 0);
    } finally { await close(); }
  });
});
