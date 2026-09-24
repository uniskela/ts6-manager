import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { clientRoutes } from '../routes/clients.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

const SECRET = 'super-secret-apikey-value-xyz';

function buildApp(executeImpl: (cmd: string, params: Record<string, unknown>) => Promise<unknown>): {
  app: Express;
  rows: Array<Record<string, unknown>>;
} {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
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

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 5, role: 'admin', username: 'auditor' };
    req.app.locals.prisma = prisma;
    req.app.locals.connectionPool = {
      getClient: () => ({
        execute: async (_sid: number, cmd: string, params: Record<string, unknown>) => executeImpl(cmd, params),
      }),
    };
    next();
  });
  app.use('/api/servers/:configId/vs/:sid/clients', clientRoutes);
  app.use(errorHandler);
  return { app, rows };
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

describe('client moderation audit instrumentation', () => {
  it('records attempt-before-dispatch and success without reason text/secrets', async () => {
    const { app, rows } = buildApp(async () => [{ ok: 1 }]);
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/servers/3/vs/1/clients/9/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasonid: 5, reasonmsg: `bye ${SECRET}` }),
      });
      assert.equal(res.status, 200);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'client.kick');
      assert.equal(rows[0].outcome, 'success');
      assert.equal(rows[0].actorUserId, 5);
      assert.equal(rows[0].connectionId, 3);
      assert.equal(rows[0].virtualServerId, 1);
      assert.equal(rows[0].targetId, '9');
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
      assert.equal(JSON.stringify(rows).includes('reasonmsg'), false);
    } finally {
      await close();
    }
  });

  it('fail-closed: does not dispatch when audit attempt insert fails', async () => {
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
            return [];
          },
        }),
      };
      next();
    });
    app.use('/api/servers/:configId/vs/:sid/clients', clientRoutes);
    app.use(errorHandler);

    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/servers/1/vs/1/clients/2/ban`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banreason: SECRET }),
      });
      assert.equal(res.status >= 500, true);
      assert.equal(dispatched, false);
    } finally {
      await close();
    }
  });

  it('keeps HTTP success when TeamSpeak succeeds but audit completion fails', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 1, role: 'admin', username: 'admin' };
      req.app.locals.prisma = {
        adminAuditEvent: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: 'a1', ...data };
            rows.push(row);
            return row;
          },
          updateMany: async () => {
            throw new Error('completion storage failed');
          },
        },
      };
      req.app.locals.connectionPool = {
        getClient: () => ({
          execute: async () => [{ ok: 1 }],
        }),
      };
      next();
    });
    app.use('/api/servers/:configId/vs/:sid/clients', clientRoutes);
    app.use(errorHandler);
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/servers/1/vs/1/clients/2/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasonmsg: SECRET }),
      });
      assert.equal(res.status, 200);
      assert.equal(rows[0].outcome, 'pending');
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
    } finally {
      await close();
    }
  });

  it('records client.move without channel password', async () => {
    const { app, rows } = buildApp(async () => [{ ok: 1 }]);
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/servers/3/vs/1/clients/9/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: 42, cpw: SECRET }),
      });
      assert.equal(res.status, 200);
      assert.equal(rows[0].action, 'client.move');
      assert.equal(rows[0].outcome, 'success');
      assert.equal(rows[0].targetId, '9');
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
      assert.equal(JSON.stringify(rows).includes('cpw'), false);
    } finally {
      await close();
    }
  });

  it('records client.poke/message without message body', async () => {
    const { app, rows } = buildApp(async () => [{ ok: 1 }]);
    const { base, close } = await listen(app);
    try {
      const poke = await fetch(`${base}/api/servers/3/vs/1/clients/9/poke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: `poke ${SECRET}` }),
      });
      assert.equal(poke.status, 200);
      const message = await fetch(`${base}/api/servers/3/vs/1/clients/9/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: `hello ${SECRET}` }),
      });
      assert.equal(message.status, 200);
      assert.equal(rows.some((r) => r.action === 'client.poke'), true);
      assert.equal(rows.some((r) => r.action === 'client.message'), true);
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
      assert.equal(JSON.stringify(rows).includes('hello'), false);
    } finally {
      await close();
    }
  });

  it('records client permission mutations without permsid/value secrets', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 5, role: 'admin', username: 'auditor' };
      req.app.locals.prisma = {
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
      req.app.locals.connectionPool = {
        getClient: () => ({
          execute: async (_sid: number, cmd: string) => {
            if (cmd === 'permidgetbyname') return [{ permid: 77 }];
            return [];
          },
          executePost: async () => [{ ok: 1 }],
        }),
      };
      next();
    });
    app.use('/api/servers/:configId/vs/:sid/clients', clientRoutes);
    app.use(errorHandler);

    const { base, close } = await listen(app);
    try {
      const put = await fetch(`${base}/api/servers/3/vs/1/clients/55/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permsid: `b_secret_${SECRET}`,
          permvalue: 999,
          permnegated: 0,
          permskip: 0,
        }),
      });
      assert.equal(put.status, 200);
      const del = await fetch(`${base}/api/servers/3/vs/1/clients/55/permissions`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permsid: `b_secret_${SECRET}` }),
      });
      assert.equal(del.status, 200);
      assert.equal(rows[0].action, 'client.permission_add');
      assert.equal(rows[1].action, 'client.permission_delete');
      assert.equal(rows[0].targetId, '55');
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
      assert.equal(JSON.stringify(rows).includes('permsid'), false);
      assert.equal(JSON.stringify(rows).includes('999'), false);
    } finally {
      await close();
    }
  });
});
