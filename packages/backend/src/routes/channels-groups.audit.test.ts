import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { channelRoutes } from './channels.routes.js';
import { serverGroupRoutes } from './server-groups.routes.js';
import { channelGroupRoutes } from './channel-groups.routes.js';
import { tokenRoutes } from './tokens.routes.js';
import { virtualServerRoutes } from './virtual-servers.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

const SECRET = 'super-secret-apikey-value-xyz';
const TOKEN_SECRET = 'tok_sentinel_do_not_store_abcdef';

function mockPrisma(rows: Array<Record<string, unknown>>) {
  return {
    adminAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `a${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        for (const row of rows) {
          if (row.operationId === where.operationId && row.outcome === where.outcome) {
            Object.assign(row, data);
          }
        }
        return { count: 1 };
      },
    },
  };
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function mountVsScoped(
  mountPath: string,
  router: express.Router,
  executeImpl: (cmd: string, params: Record<string, unknown>) => Promise<unknown>,
): { app: Express; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 5, role: 'admin', username: 'auditor' };
    req.app.locals.prisma = mockPrisma(rows);
    req.app.locals.connectionPool = {
      getClient: () => ({
        execute: async (_sid: number, cmd: string, params: Record<string, unknown> = {}) =>
          executeImpl(cmd, params),
      }),
    };
    next();
  });
  app.use(mountPath, router);
  app.use(errorHandler);
  return { app, rows };
}

describe('channel / group / token / vs audit instrumentation', () => {
  it('audits channel CRUD without passwords or topic text', async () => {
    const { app, rows } = mountVsScoped(
      '/api/servers/:configId/vs/:sid/channels',
      channelRoutes,
      async (cmd) => {
        if (cmd === 'channelcreate') return [{ cid: 88 }];
        return [{ ok: 1 }];
      },
    );
    const { base, close } = await listen(app);
    try {
      const create = await fetch(`${base}/api/servers/3/vs/1/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_name: 'Lobby',
          channel_password: SECRET,
          channel_topic: `topic ${SECRET}`,
        }),
      });
      assert.equal(create.status, 201);

      const update = await fetch(`${base}/api/servers/3/vs/1/channels/88`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_password: SECRET }),
      });
      assert.equal(update.status, 200);

      const move = await fetch(`${base}/api/servers/3/vs/1/channels/88/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpid: 1 }),
      });
      assert.equal(move.status, 200);

      const perm = await fetch(`${base}/api/servers/3/vs/1/channels/88/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permsid: `i_secret_${SECRET}`, permvalue: 1 }),
      });
      assert.equal(perm.status, 200);

      const del = await fetch(`${base}/api/servers/3/vs/1/channels/88`, { method: 'DELETE' });
      assert.equal(del.status, 200);

      assert.equal(rows[0].action, 'channel.create');
      assert.equal(rows[0].targetId, '88');
      assert.equal(rows.some((r) => r.action === 'channel.update'), true);
      assert.equal(rows.some((r) => r.action === 'channel.move'), true);
      assert.equal(rows.some((r) => r.action === 'channel.permission_add'), true);
      assert.equal(rows.some((r) => r.action === 'channel.delete'), true);
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
      assert.equal(JSON.stringify(rows).includes('channel_password'), false);
      assert.equal(JSON.stringify(rows).includes('topic'), false);
    } finally {
      await close();
    }
  });

  it('audits server and channel group mutations without names or perm values', async () => {
    const { app: sgApp, rows: sgRows } = mountVsScoped(
      '/api/servers/:configId/vs/:sid/server-groups',
      serverGroupRoutes,
      async (cmd) => {
        if (cmd === 'servergroupadd') return [{ sgid: 12 }];
        return [{ ok: 1 }];
      },
    );
    const { base: sgBase, close: sgClose } = await listen(sgApp);
    try {
      const create = await fetch(`${sgBase}/api/servers/3/vs/1/server-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Admins ${SECRET}` }),
      });
      assert.equal(create.status, 201);
      assert.equal(sgRows[0].action, 'server_group.create');
      assert.equal(sgRows[0].targetId, '12');

      const member = await fetch(`${sgBase}/api/servers/3/vs/1/server-groups/12/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cldbid: 99 }),
      });
      assert.equal(member.status, 200);
      assert.equal(sgRows.some((r) => r.action === 'server_group.member_add'), true);

      const perm = await fetch(`${sgBase}/api/servers/3/vs/1/server-groups/12/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permsid: `b_${SECRET}`, permvalue: 1 }),
      });
      assert.equal(perm.status, 200);
      assert.equal(JSON.stringify(sgRows).includes(SECRET), false);
    } finally {
      await sgClose();
    }

    const { app: cgApp, rows: cgRows } = mountVsScoped(
      '/api/servers/:configId/vs/:sid/channel-groups',
      channelGroupRoutes,
      async (cmd) => {
        if (cmd === 'channelgroupadd') return [{ cgid: 7 }];
        return [{ ok: 1 }];
      },
    );
    const { base: cgBase, close: cgClose } = await listen(cgApp);
    try {
      const create = await fetch(`${cgBase}/api/servers/3/vs/1/channel-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `CG ${SECRET}` }),
      });
      assert.equal(create.status, 201);
      assert.equal(cgRows[0].targetId, '7');

      const assign = await fetch(`${cgBase}/api/servers/3/vs/1/channel-groups/7/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: 1, cldbid: 2 }),
      });
      assert.equal(assign.status, 200);
      assert.equal(cgRows.some((r) => r.action === 'channel_group.assign'), true);
      assert.equal(JSON.stringify(cgRows).includes(SECRET), false);
    } finally {
      await cgClose();
    }
  });

  it('never stores privilege key token from create response or delete path', async () => {
    const { app, rows } = mountVsScoped(
      '/api/servers/:configId/vs/:sid/tokens',
      tokenRoutes,
      async (cmd, params) => {
        if (cmd === 'privilegekeyadd') return [{ token: TOKEN_SECRET }];
        if (cmd === 'privilegekeydelete') {
          assert.equal(params.token, TOKEN_SECRET);
          return [{ ok: 1 }];
        }
        return [];
      },
    );
    const { base, close } = await listen(app);
    try {
      const create = await fetch(`${base}/api/servers/3/vs/1/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokentype: 0, tokenid1: 1, tokenid2: 0, tokendescription: SECRET }),
      });
      assert.equal(create.status, 201);
      assert.equal(rows[0].action, 'privilege_key.create');
      assert.equal(rows[0].targetId, null);
      assert.equal(rows[0].targetType, 'privilege_key');

      const del = await fetch(`${base}/api/servers/3/vs/1/tokens/${encodeURIComponent(TOKEN_SECRET)}`, {
        method: 'DELETE',
      });
      assert.equal(del.status, 200);
      assert.equal(rows[1].action, 'privilege_key.delete');
      assert.equal(rows[1].targetId, null);
      assert.equal(JSON.stringify(rows).includes(TOKEN_SECRET), false);
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
    } finally {
      await close();
    }
  });

  it('audits virtual server edit/start/stop without password field values', async () => {
    const { app, rows } = mountVsScoped(
      '/api/servers/:configId/vs',
      virtualServerRoutes,
      async () => [{ ok: 1 }],
    );
    const { base, close } = await listen(app);
    try {
      const edit = await fetch(`${base}/api/servers/3/vs/2`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          virtualserver_name: 'Prod',
          virtualserver_password: SECRET,
        }),
      });
      assert.equal(edit.status, 200);
      assert.equal(rows[0].action, 'virtual_server.edit');
      assert.equal(rows[0].targetId, '2');

      const start = await fetch(`${base}/api/servers/3/vs/2/start`, { method: 'POST' });
      assert.equal(start.status, 200);
      const stop = await fetch(`${base}/api/servers/3/vs/2/stop`, { method: 'POST' });
      assert.equal(stop.status, 200);
      assert.equal(rows.some((r) => r.action === 'virtual_server.start'), true);
      assert.equal(rows.some((r) => r.action === 'virtual_server.stop'), true);
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
      assert.equal(JSON.stringify(rows).includes('virtualserver_password'), false);
    } finally {
      await close();
    }
  });

  it('fail-closed: privilege key create does not dispatch when audit insert fails', async () => {
    let dispatched = false;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 1, role: 'admin', username: 'admin' };
      req.app.locals.prisma = {
        adminAuditEvent: {
          create: async () => {
            throw new Error('db down');
          },
        },
      };
      req.app.locals.connectionPool = {
        getClient: () => ({
          execute: async () => {
            dispatched = true;
            return [{ token: TOKEN_SECRET }];
          },
        }),
      };
      next();
    });
    app.use('/api/servers/:configId/vs/:sid/tokens', tokenRoutes);
    app.use(errorHandler);

    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/servers/1/vs/1/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokentype: 0 }),
      });
      assert.equal(res.status >= 500, true);
      assert.equal(dispatched, false);
    } finally {
      await close();
    }
  });
});
