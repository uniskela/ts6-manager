/**
 * P1-A: administrator password reset / disable must revoke target refresh tokens.
 * Refresh-token revocation is not immediate access-JWT or WebSocket termination.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { userRoutes } from './users.routes.js';
import { authRoutes } from './auth.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { config } from '../config.js';
import { assertRefreshRejected, putUser } from './test-support/http-auth-helpers.js';

type UserRow = {
  id: number;
  username: string;
  displayName: string;
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
  user?: UserRow;
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

function createStore(options?: {
  /** Throw inside $transaction after mutate begins (simulates DB failure). */
  failTransaction?: boolean;
  /**
   * When refreshToken.updateMany runs, await this gate before returning.
   * Used to interleave an admin reset with an in-flight refresh rotation.
   */
  onRefreshClaim?: () => Promise<void>;
}) {
  let userSeq = 2;
  let refreshSeq = 1;
  const users = new Map<number, UserRow>([
    [
      1,
      {
        id: 1,
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        enabled: true,
        passwordHash: '$2a$12$placeholderAdminHashxxxxxxxxxxxx',
      },
    ],
    [
      2,
      {
        id: 2,
        username: 'victim',
        displayName: 'Victim',
        role: 'viewer',
        enabled: true,
        // bcrypt hash of "OldPass1" — tests that need compare use auth.routes with real hashes
        passwordHash: '',
      },
    ],
  ]);
  const refreshTokens = new Map<number, RefreshRow>();

  const prisma: any = {
    user: {
      findUnique: async ({ where }: { where: { id?: number; username?: string } }) => {
        if (where.id != null) return users.get(where.id) ?? null;
        if (where.username != null) {
          for (const u of users.values()) if (u.username === where.username) return u;
        }
        return null;
      },
      findMany: async () => [...users.values()],
      create: async ({ data }: { data: Omit<UserRow, 'id'> }) => {
        const row: UserRow = { id: ++userSeq, ...data };
        users.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: number }; data: Partial<UserRow> }) => {
        const row = users.get(where.id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: number; passwordHash?: string; enabled?: boolean };
        data: Partial<UserRow>;
      }) => {
        const row = users.get(where.id);
        if (!row) return { count: 0 };
        if (where.passwordHash != null && row.passwordHash !== where.passwordHash) return { count: 0 };
        if (where.enabled != null && row.enabled !== where.enabled) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      delete: async ({ where }: { where: { id: number } }) => {
        users.delete(where.id);
        return { id: where.id };
      },
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
          const full = { ...row, user: users.get(row.userId) };
          return include?.user ? full : { ...row };
        }
        return null;
      },
      findFirst: async ({ where }: { where: { replacedBy?: string } }) => {
        for (const row of refreshTokens.values()) {
          if (where.replacedBy != null && row.replacedBy === where.replacedBy) return { ...row };
        }
        return null;
      },
      create: async ({ data }: { data: Omit<RefreshRow, 'id' | 'replacedBy'> & { replacedBy?: string | null } }) => {
        const row: RefreshRow = {
          id: ++refreshSeq,
          token: data.token,
          userId: data.userId,
          expiresAt: data.expiresAt,
          family: data.family ?? null,
          replacedBy: data.replacedBy ?? null,
        };
        refreshTokens.set(row.id, row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: number };
        data: Partial<RefreshRow>;
      }) => {
        const row = refreshTokens.get(where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        // After a successful claim: allow an admin revoke to interleave before create().
        if (options?.onRefreshClaim) await options.onRefreshClaim();
        return { count: 1 };
      },
      delete: async ({ where }: { where: { id: number } }) => {
        refreshTokens.delete(where.id);
        return { id: where.id };
      },
      deleteMany: async ({
        where,
      }: {
        where: { id?: number; token?: string; userId?: number; expiresAt?: { lt: Date } };
      }) => {
        let count = 0;
        for (const [id, row] of [...refreshTokens.entries()]) {
          if (where.id != null && row.id !== where.id) continue;
          if (where.token != null && row.token !== where.token) continue;
          if (where.userId != null && row.userId !== where.userId) continue;
          if (where.expiresAt?.lt && !(row.expiresAt < where.expiresAt.lt)) continue;
          refreshTokens.delete(id);
          count++;
        }
        return { count };
      },
    },
    adminAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      if (!options?.failTransaction) return fn(prisma);
      // Snapshot + restore so a thrown transaction cannot leave partial success state.
      const userSnap = new Map([...users.entries()].map(([id, u]) => [id, { ...u }]));
      const refreshSnap = new Map([...refreshTokens.entries()].map(([id, r]) => [id, { ...r }]));
      try {
        await fn(prisma);
        throw new Error('simulated db failure');
      } catch (err) {
        users.clear();
        for (const [id, u] of userSnap) users.set(id, u);
        refreshTokens.clear();
        for (const [id, r] of refreshSnap) refreshTokens.set(id, r);
        throw err;
      }
    },
  };

  return {
    prisma,
    users,
    refreshTokens,
    seedRefresh(userId: number, token: string, family = 'fam-1') {
      const row: RefreshRow = {
        id: ++refreshSeq,
        token,
        userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        family,
        replacedBy: null,
      };
      refreshTokens.set(row.id, row);
      return row;
    },
  };
}

async function mountApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: 'admin', username: 'admin' };
    req.app.locals.prisma = prisma;
    next();
  });
  app.use('/api/users', userRoutes);
  app.use('/api/auth', authRoutes);
  app.use(errorHandler);
  return listen(app);
}

function seedVictimAndOther(
  store: ReturnType<typeof createStore>,
  victimToken: string,
  otherToken: string,
) {
  store.users.set(3, {
    id: 3,
    username: 'other',
    displayName: 'Other',
    role: 'viewer',
    enabled: true,
    passwordHash: '',
  });
  store.seedRefresh(2, victimToken);
  store.seedRefresh(3, otherToken);
}

function hasUserRefresh(store: ReturnType<typeof createStore>, userId: number) {
  return [...store.refreshTokens.values()].some((r) => r.userId === userId);
}

function hasToken(store: ReturnType<typeof createStore>, token: string) {
  return [...store.refreshTokens.values()].some((r) => r.token === token);
}

describe('P1-A admin refresh-token revocation', () => {
  it('admin password reset revokes outstanding refresh tokens (401 on /refresh)', async () => {
    const store = createStore();
    seedVictimAndOther(store, 'refresh-victim-1', 'refresh-other-1');
    const { base, close } = await mountApp(store.prisma);
    try {
      assert.equal((await putUser(base, { password: 'NewPass1a' })).status, 204);
      assert.equal(hasUserRefresh(store, 2), false, 'target refresh rows must be deleted');
      assert.equal(hasToken(store, 'refresh-other-1'), true, 'other users must keep their refresh tokens');
      await assertRefreshRejected(base, 'refresh-victim-1');
    } finally {
      await close();
    }
  });

  it('admin disable revokes outstanding refresh tokens', async () => {
    const store = createStore();
    seedVictimAndOther(store, 'refresh-victim-2', 'refresh-other-2');
    const { base, close } = await mountApp(store.prisma);
    try {
      assert.equal((await putUser(base, { enabled: false })).status, 204);
      assert.equal(
        [...store.refreshTokens.values()].filter((r) => r.userId === 2).length,
        0,
        'disable must delete refresh rows immediately, not only fail later /refresh',
      );
      assert.equal(hasToken(store, 'refresh-other-2'), true);
      assert.equal(store.users.get(2)!.enabled, false);
      await assertRefreshRejected(base, 'refresh-victim-2');
    } finally {
      await close();
    }
  });

  it('re-enabling an account does not restore previously revoked refresh tokens', async () => {
    const store = createStore();
    seedVictimAndOther(store, 'refresh-victim-3', 'refresh-other-3');
    const { base, close } = await mountApp(store.prisma);
    try {
      assert.equal((await putUser(base, { enabled: false })).status, 204);
      assert.equal(hasUserRefresh(store, 2), false);

      assert.equal((await putUser(base, { enabled: true })).status, 204);
      assert.equal(store.users.get(2)!.enabled, true);
      assert.equal(hasUserRefresh(store, 2), false, 're-enable must not resurrect tokens');
      assert.equal(hasToken(store, 'refresh-other-3'), true);
      await assertRefreshRejected(base, 'refresh-victim-3');
    } finally {
      await close();
    }
  });

  it('metadata-only update preserves outstanding refresh tokens', async () => {
    const store = createStore();
    store.seedRefresh(2, 'refresh-victim-4');
    const { base, close } = await mountApp(store.prisma);
    try {
      const put = await putUser(base, { displayName: 'Renamed' });
      assert.equal(put.status, 204);
      assert.equal(store.refreshTokens.size, 1);
      assert.equal(store.users.get(2)!.displayName, 'Renamed');

      // Token still present; /refresh would mint access if user hash/compare path OK.
      // Here we only assert the row survived the metadata update.
      assert.ok([...store.refreshTokens.values()].some((r) => r.token === 'refresh-victim-4'));
    } finally {
      await close();
    }
  });

  it('enabled:true with live tokens does not revoke sessions', async () => {
    const store = createStore();
    store.seedRefresh(2, 'refresh-victim-enabled-true');
    const { base, close } = await mountApp(store.prisma);
    try {
      const put = await putUser(base, { enabled: true });
      assert.equal(put.status, 204);
      assert.equal(store.users.get(2)!.enabled, true);
      assert.ok(
        [...store.refreshTokens.values()].some((r) => r.token === 'refresh-victim-enabled-true'),
        'enabling must not revoke live tokens',
      );
    } finally {
      await close();
    }
  });

  it('role-preserving edit without password/disable does not revoke', async () => {
    const store = createStore();
    store.seedRefresh(2, 'refresh-victim-5');
    const { base, close } = await mountApp(store.prisma);
    try {
      const put = await putUser(base, { role: 'viewer', displayName: 'Still Viewer' });
      assert.equal(put.status, 204);
      assert.equal(store.refreshTokens.size, 1);
    } finally {
      await close();
    }
  });

  it('self-service password change still revokes the caller refresh tokens', async () => {
    const store = createStore();
    const hash = await bcrypt.hash('OldPass1a', 4);
    store.users.set(1, {
      id: 1,
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      enabled: true,
      passwordHash: hash,
    });
    store.seedRefresh(1, 'admin-refresh-1');
    store.seedRefresh(2, 'other-user-refresh');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.app.locals.prisma = store.prisma;
      next();
    });
    app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    const accessToken = jwt.sign(
      { id: 1, username: 'admin', role: 'admin' },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '15m' },
    );
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ currentPassword: 'OldPass1a', newPassword: 'NewPass2b' }),
      });
      assert.equal(res.status, 204);
      assert.equal(
        [...store.refreshTokens.values()].some((r) => r.userId === 1),
        false,
      );
      assert.equal(
        [...store.refreshTokens.values()].some((r) => r.token === 'other-user-refresh'),
        true,
        'other users sessions must remain',
      );
    } finally {
      await close();
    }
  });

  it('database failure does not report success or leave a partial password update without revoke', async () => {
    const store = createStore({ failTransaction: true });
    store.seedRefresh(2, 'refresh-victim-6');
    const beforeHash = store.users.get(2)!.passwordHash;
    const { base, close } = await mountApp(store.prisma);
    try {
      const put = await putUser(base, { password: 'NewPass1a' });
      assert.notEqual(put.status, 204);
      assert.ok(put.status >= 500);
      assert.equal(store.users.get(2)!.passwordHash, beforeHash);
      assert.equal(store.refreshTokens.size, 1);
      assert.ok([...store.refreshTokens.values()].some((r) => r.token === 'refresh-victim-6'));
    } finally {
      await close();
    }
  });

  it('documents known admin-reset/refresh race defect pending P1-B (not final behaviour)', async () => {
    // Known defect on P1-A alone / release blocker until P1-B: in-flight refresh can mint
    // a usable successor after admin password reset. Invert to 401 / no successor when
    // merging with P1-B (see security/p1ab-integration-gate).
    // Harness: claim held open → admin deleteMany → create() after revoke.
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let adminDone!: () => void;
    const adminGate = new Promise<void>((resolve) => {
      adminDone = resolve;
    });

    const store = createStore({
      onRefreshClaim: async () => {
        adminDone();
        await claimGate;
      },
    });
    store.seedRefresh(2, 'refresh-race-1', 'fam-race');
    const claimedId = [...store.refreshTokens.values()][0]!.id;

    const { base, close } = await mountApp(store.prisma);
    try {
      const refreshPromise = fetch(`${base}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'refresh-race-1' }),
      });

      await adminGate;
      const put = await putUser(base, { password: 'NewPass1a' });
      assert.equal(put.status, 204);
      assert.equal(store.refreshTokens.has(claimedId), false);

      releaseClaim();
      const refreshRes = await refreshPromise;
      const body = (await refreshRes.json()) as { refreshToken?: string };
      assert.equal(
        refreshRes.status,
        200,
        'defect pinned on P1-A alone: successor mint after reset — invert under P1-B merge',
      );
      assert.ok(body.refreshToken);
      assert.notEqual(body.refreshToken, 'refresh-race-1');
      assert.equal(
        [...store.refreshTokens.values()].some((r) => r.token === body.refreshToken),
        true,
        'defect pinned: live successor after reset — must be absent under P1-B',
      );
    } finally {
      await close();
    }
  });
});
