import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { userRoutes } from './users.routes.js';
import { settingsRoutes } from './settings.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

const SECRET = 'super-secret-apikey-value-xyz';
const COOKIE_SECRET = 'SID=sentinel-cookie-value-do-not-store';

function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('expected TCP address'));
      else {
        resolve({
          base: `http://127.0.0.1:${address.port}`,
          close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
        });
      }
    });
  });
}

describe('user/settings audit privacy', () => {
  it('user create audits id/role facts without password', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 1, role: 'admin', username: 'admin' };
      const prisma = {
        user: {
          create: async ({ data }: { data: Record<string, unknown> }) => ({
            id: 99,
            username: data.username,
          }),
        },
        adminAuditEvent: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: 'u1', ...data };
            rows.push(row);
            return row;
          },
        },
        $transaction: async (fn: any) => fn(prisma),
      };
      req.app.locals.prisma = prisma;
      next();
    });
    app.use('/api/users', userRoutes);
    app.use(errorHandler);
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'newuser',
          password: `Aa1${SECRET}`,
          displayName: 'New',
          role: 'viewer',
        }),
      });
      assert.equal(res.status, 201);
      assert.equal(rows[0].action, 'user.create');
      assert.equal(rows[0].targetId, '99');
      assert.equal(JSON.stringify(rows).includes(SECRET), false);
      assert.equal(JSON.stringify(rows).includes(`Aa1${SECRET}`), false);
      assert.equal(JSON.stringify(rows).includes('passwordHash'), false);
    } finally {
      await close();
    }
  });

  it('yt-cookie upload never stores cookie text in audit rows', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 1, role: 'admin', username: 'admin' };
      req.app.locals.prisma = {
        adminAuditEvent: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: 'c1', ...data };
            rows.push(row);
            return row;
          },
          updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            for (const row of rows) {
              if (row.operationId === where.operationId) Object.assign(row, data);
            }
            return { count: 1 };
          },
        },
      };
      next();
    });
    app.use('/api/settings', settingsRoutes);
    app.use(errorHandler);
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/settings/yt-cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: COOKIE_SECRET }),
      });
      assert.equal(res.status, 200);
      assert.equal(rows[0].action, 'settings.yt_cookies_changed');
      assert.equal(rows[0].outcome, 'success');
      assert.equal(JSON.stringify(rows).includes(COOKIE_SECRET), false);
      assert.equal(JSON.stringify(rows).includes('text'), false);
    } finally {
      await close();
    }
  });
});
