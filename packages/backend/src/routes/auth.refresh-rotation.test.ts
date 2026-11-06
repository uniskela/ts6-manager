/**
 * P1-B: refresh-token rotation and reuse detection (in-memory contract tests).
 * Complements auth.refresh-rotation.sqlite.test.ts for real SQLite concurrency.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { authRoutes } from './auth.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

type UserRow = {
  id: number;
  username: string;
  role: string;
  enabled: boolean;
  passwordHash: string;
};

type RefreshRow = {
  id: number;
  token: string;
  userId: number;
  expiresAt: Date;
  family: string | null;
  replacedBy: string | null;
};

function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('expected TCP address'));
      else {
        resolve({
          base: `http://127.0.0.1:${address.port}`,
          close: () =>
            new Promise((res, rej) => {
              server.closeAllConnections?.();
              server.close((err) => (err ? rej(err) : res()));
            }),
        });
      }
    });
  });
}

function createStore(options?: { onClaim?: () => Promise<void> }) {
  let refreshSeq = 0;
  const users = new Map<number, UserRow>([
    [1, { id: 1, username: 'alice', role: 'admin', enabled: true, passwordHash: 'x' }],
    [2, { id: 2, username: 'bob', role: 'viewer', enabled: true, passwordHash: 'y' }],
  ]);
  const refreshTokens = new Map<number, RefreshRow>();

  const prisma: any = {
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => users.get(where.id) ?? null,
    },
    refreshToken: {
      findUnique: async ({
        where,
        include,
      }: {
        where: { token: string };
        include?: { user: boolean };
      }) => {
        for (const row of refreshTokens.values()) {
          if (row.token !== where.token) continue;
          return include?.user ? { ...row, user: users.get(row.userId) } : { ...row };
        }
        return null;
      },
      findFirst: async ({ where }: { where: { replacedBy?: string } }) => {
        for (const row of refreshTokens.values()) {
          if (where.replacedBy != null && row.replacedBy === where.replacedBy) return { ...row };
        }
        return null;
      },
      create: async ({
        data,
      }: {
        data: { token: string; userId: number; expiresAt: Date; family?: string | null };
      }) => {
        const row: RefreshRow = {
          id: ++refreshSeq,
          token: data.token,
          userId: data.userId,
          expiresAt: data.expiresAt,
          family: data.family ?? null,
          replacedBy: null,
        };
        refreshTokens.set(row.id, row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: number; replacedBy?: null };
        data: Partial<RefreshRow>;
      }) => {
        const row = refreshTokens.get(where.id);
        if (!row) return { count: 0 };
        if (where.replacedBy === null && row.replacedBy != null) return { count: 0 };
        Object.assign(row, data);
        if (options?.onClaim) await options.onClaim();
        return { count: 1 };
      },
      delete: async ({ where }: { where: { id: number } }) => {
        refreshTokens.delete(where.id);
        return { id: where.id };
      },
      deleteMany: async ({
        where,
      }: {
        where: {
          id?: number;
          token?: string;
          userId?: number;
          family?: string | null;
          expiresAt?: { lt: Date };
        };
      }) => {
        let count = 0;
        for (const [id, row] of [...refreshTokens.entries()]) {
          if (where.id != null && row.id !== where.id) continue;
          if (where.token != null && row.token !== where.token) continue;
          if (where.userId != null && row.userId !== where.userId) continue;
          if ('family' in where && row.family !== where.family) continue;
          if (where.expiresAt?.lt && !(row.expiresAt < where.expiresAt.lt)) continue;
          refreshTokens.delete(id);
          count++;
        }
        return { count };
      },
    },
    $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  };

  return {
    prisma,
    refreshTokens,
    seed(userId: number, token: string, family: string | null) {
      const row: RefreshRow = {
        id: ++refreshSeq,
        token,
        userId,
        expiresAt: new Date(Date.now() + 86_400_000),
        family,
        replacedBy: null,
      };
      refreshTokens.set(row.id, row);
      return row;
    },
  };
}

async function mount(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.app.locals.prisma = prisma;
    next();
  });
  app.use('/api/auth', authRoutes);
  app.use(errorHandler);
  return listen(app);
}

async function refresh(base: string, token: string) {
  return fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: token }),
  });
}

describe('P1-B refresh rotation / reuse detection (reproduction)', () => {
  it('valid refresh rotates successfully and returns a new refresh token', async () => {
    const store = createStore();
    store.seed(1, 'live-a', 'fam-1');
    const { base, close } = await mount(store.prisma);
    try {
      const res = await refresh(base, 'live-a');
      assert.equal(res.status, 200);
      const body = (await res.json()) as { accessToken: string; refreshToken: string };
      assert.ok(body.accessToken);
      assert.ok(body.refreshToken);
      assert.notEqual(body.refreshToken, 'live-a');
      assert.equal(
        [...store.refreshTokens.values()].some((r) => r.token === body.refreshToken),
        true,
      );
    } finally {
      await close();
    }
  });

  it('reusing a consumed refresh token is detected and revokes that token family only', async () => {
    const store = createStore();
    store.seed(1, 'family1-a', 'fam-1');
    store.seed(1, 'family2-c', 'fam-2'); // separate device / family
    const { base, close } = await mount(store.prisma);
    try {
      const first = await refresh(base, 'family1-a');
      assert.equal(first.status, 200);
      const { refreshToken: family1B } = (await first.json()) as { refreshToken: string };

      // Replay the consumed token.
      const replay = await refresh(base, 'family1-a');
      assert.equal(replay.status, 401);

      // Intended contract: fam-1 successor revoked; fam-2 untouched.
      assert.equal(
        [...store.refreshTokens.values()].some((r) => r.token === family1B),
        false,
        'reuse must invalidate the replayed token family (including the successor)',
      );
      assert.equal(
        [...store.refreshTokens.values()].some((r) => r.token === 'family2-c'),
        true,
        'a different refresh family for the same user must survive',
      );
    } finally {
      await close();
    }
  });

  it('unknown refresh token returns 401 without modifying unrelated sessions', async () => {
    const store = createStore();
    store.seed(1, 'keep-me', 'fam-keep');
    store.seed(2, 'bob-token', 'fam-bob');
    const before = store.refreshTokens.size;
    const { base, close } = await mount(store.prisma);
    try {
      const res = await refresh(base, 'no-such-token');
      assert.equal(res.status, 401);
      assert.equal(store.refreshTokens.size, before);
      assert.ok([...store.refreshTokens.values()].some((r) => r.token === 'keep-me'));
      assert.ok([...store.refreshTokens.values()].some((r) => r.token === 'bob-token'));
    } finally {
      await close();
    }
  });

  it('two simultaneous refreshes of one token cannot both succeed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let claims = 0;
    const store = createStore({
      onClaim: async () => {
        claims++;
        if (claims === 1) await gate;
      },
    });
    store.seed(1, 'race-token', 'fam-race');
    const { base, close } = await mount(store.prisma);
    try {
      const p1 = refresh(base, 'race-token');
      // Let the first request reach claim, then start the second.
      await new Promise((r) => setTimeout(r, 20));
      const p2 = refresh(base, 'race-token');
      await new Promise((r) => setTimeout(r, 20));
      release();
      const [a, b] = await Promise.all([p1, p2]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [200, 401], 'exactly one refresh may succeed');
      const winners = [a, b].filter((r) => r.status === 200);
      assert.equal(winners.length, 1);
    } finally {
      await close();
    }
  });
});
