import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { auditRoutes } from '../routes/audit.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { listAuditEvents } from './query.js';

const SECRET = 'super-secret-apikey-value-xyz';

function buildApp(options: {
  role?: 'admin' | 'viewer';
  rows?: Array<Record<string, unknown>>;
}): Express {
  const rows = (options.rows ?? []).map((r) => ({
    id: String(r.id),
    operationId: String(r.operationId ?? r.id),
    actorUserId: Number(r.actorUserId ?? 1),
    actorUsername: (r.actorUsername as string) ?? 'admin',
    action: String(r.action ?? 'client.kick'),
    connectionId: (r.connectionId as number | null) ?? 1,
    virtualServerId: (r.virtualServerId as number | null) ?? 1,
    targetType: (r.targetType as string | null) ?? 'client',
    targetId: (r.targetId as string | null) ?? '1',
    outcome: String(r.outcome ?? 'success'),
    resultCode: (r.resultCode as string | null) ?? 'ok',
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt ?? Date.now())),
    completedAt: r.completedAt instanceof Date ? r.completedAt : null,
  }));

  const prisma = {
    adminAuditEvent: {
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where?: any;
        orderBy?: unknown;
        take?: number;
      }) => {
        void orderBy;
        let list = rows.slice().sort((a, b) => {
          const dt = b.createdAt.getTime() - a.createdAt.getTime();
          if (dt !== 0) return dt;
          return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
        });
        if (where?.action) list = list.filter((r) => r.action === where.action);
        if (where?.outcome) list = list.filter((r) => r.outcome === where.outcome);
        if (where?.actorUserId != null) list = list.filter((r) => r.actorUserId === where.actorUserId);
        if (where?.connectionId != null) list = list.filter((r) => r.connectionId === where.connectionId);
        if (where?.AND?.[0]?.OR) {
          const cursorOr = where.AND[0].OR as Array<any>;
          const ltDate: Date = cursorOr[0].createdAt.lt;
          const eqDate: Date = cursorOr[1].createdAt;
          const ltId: string = cursorOr[1].id.lt;
          list = list.filter((r) =>
            r.createdAt.getTime() < ltDate.getTime()
            || (r.createdAt.getTime() === eqDate.getTime() && r.id < ltId),
          );
        }
        return list.slice(0, take ?? list.length);
      },
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: 1,
      role: options.role ?? 'admin',
      username: 'tester',
    };
    req.app.locals.prisma = prisma;
    next();
  });
  app.use('/api/audit', auditRoutes);
  app.use(errorHandler);
  return app;
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

describe('audit routes', () => {
  it('denies viewers', async () => {
    const app = buildApp({ role: 'viewer' });
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/audit`);
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('returns cursor pagination and retention metadata for admins', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `id${i}`,
      operationId: `op${i}`,
      createdAt: new Date(now - i * 1000),
      action: 'client.kick',
      outcome: 'success',
    }));
    const app = buildApp({ role: 'admin', rows });
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/audit?limit=2`);
      assert.equal(res.status, 200);
      const body = await res.json() as {
        items: unknown[];
        nextCursor: string | null;
        retention: { maxAgeDays: number; maxRows: number };
      };
      assert.equal(body.items.length, 2);
      assert.ok(body.nextCursor);
      assert.equal(body.retention.maxAgeDays, 30);
      assert.equal(body.retention.maxRows, 100_000);
      assert.equal(JSON.stringify(body).includes(SECRET), false);

      const page2 = await fetch(`${base}/api/audit?limit=2&cursor=${encodeURIComponent(body.nextCursor!)}`);
      assert.equal(page2.status, 200);
      const body2 = await page2.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      assert.equal(body2.items.length, 1);
      assert.equal(body2.nextCursor, null);
    } finally {
      await close();
    }
  });
});

describe('listAuditEvents cursor stability', () => {
  it('pages without duplicating ids across pages', async () => {
    const now = Date.now();
    const stored = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i}`,
      operationId: `o${i}`,
      actorUserId: 1,
      actorUsername: 'admin',
      action: 'user.update',
      connectionId: null,
      virtualServerId: null,
      targetType: 'user',
      targetId: String(i),
      outcome: 'success',
      resultCode: 'ok',
      createdAt: new Date(now - i * 1000),
      completedAt: new Date(now - i * 1000),
    }));

    const prisma = {
      adminAuditEvent: {
        findMany: async ({
          where,
          take,
        }: {
          where?: any;
          take?: number;
        }) => {
          let list = stored.slice().sort((a, b) => {
            const dt = b.createdAt.getTime() - a.createdAt.getTime();
            if (dt !== 0) return dt;
            return b.id < a.id ? -1 : 1;
          });
          if (where?.AND) {
            const cursorOr = where.AND[0].OR as Array<any>;
            const ltDate: Date = cursorOr[0].createdAt.lt;
            const eqDate: Date = cursorOr[1].createdAt;
            const ltId: string = cursorOr[1].id.lt;
            list = list.filter((r) =>
              r.createdAt.getTime() < ltDate.getTime()
              || (r.createdAt.getTime() === eqDate.getTime() && r.id < ltId),
            );
          }
          return list.slice(0, take);
        },
      },
    } as any;

    const page1 = await listAuditEvents(prisma, { limit: 2 });
    const page2 = await listAuditEvents(prisma, { limit: 2, cursor: page1.nextCursor! });
    const page3 = await listAuditEvents(prisma, { limit: 2, cursor: page2.nextCursor! });
    const ids = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
    assert.deepEqual(ids, ['e0', 'e1', 'e2', 'e3', 'e4']);
    assert.equal(new Set(ids).size, 5);
  });
});
