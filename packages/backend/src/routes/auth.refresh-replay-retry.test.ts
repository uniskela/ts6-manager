/**
 * P1 F-1 companion: bounded SQLITE busy retry on replay-family revoke.
 * Persistent non-busy failures never produce authentication success.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postAuthRefresh, withAuthApp } from './test-support/mount-auth-app.js';

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

function createReplayStore(options: {
  deleteManyImpl: (args: { where: { userId: number; family: string | null } }) => Promise<{ count: number }>;
}) {
  const users = new Map<number, UserRow>([
    [1, { id: 1, username: 'alice', role: 'admin', enabled: true, passwordHash: 'x' }],
  ]);
  const expiresAt = new Date(Date.now() + 86_400_000);
  const refreshTokens = new Map<number, RefreshRow>([
    [1, { id: 1, token: 'R0', userId: 1, expiresAt, family: 'fam-1', replacedBy: 'R1' }],
    [2, { id: 2, token: 'R1', userId: 1, expiresAt, family: 'fam-1', replacedBy: null }],
    [3, { id: 3, token: 'other', userId: 1, expiresAt, family: 'fam-other', replacedBy: null }],
  ]);

  const prisma: any = {
    refreshToken: {
      findUnique: async ({
        where,
        include,
      }: {
        where: { token?: string };
        include?: { user: boolean };
      }) => {
        for (const row of refreshTokens.values()) {
          if (where.token != null && row.token !== where.token) continue;
          return include?.user ? { ...row, user: users.get(row.userId) } : row;
        }
        return null;
      },
      deleteMany: async (args: { where: { userId: number; family: string | null } }) => {
        const result = await options.deleteManyImpl(args);
        if (result.count >= 0) {
          for (const [id, row] of [...refreshTokens.entries()]) {
            if (row.userId === args.where.userId && row.family === args.where.family) {
              refreshTokens.delete(id);
            }
          }
        }
        return result;
      },
      delete: async () => ({ count: 1 }),
      updateMany: async () => ({ count: 0 }),
      create: async () => {
        throw new Error('create should not run on replay');
      },
    },
    $transaction: async () => {
      throw new Error('transaction should not run on replay');
    },
  };

  return { prisma, refreshTokens };
}

function lockedBusyError(): Error {
  const err = new Error('database is locked');
  (err as { code?: string }).code = 'P2034';
  return err;
}

describe('P1 F-1 replay-family revoke busy retry', () => {
  it('retries transient database-locked errors then revokes the family', async () => {
    let attempts = 0;
    const { prisma, refreshTokens } = createReplayStore({
      deleteManyImpl: async () => {
        attempts += 1;
        if (attempts < 3) throw lockedBusyError();
        return { count: 2 };
      },
    });

    await withAuthApp(prisma, async (base) => {
      const res = await postAuthRefresh(base, 'R0');
      assert.equal(res.status, 401);
      assert.equal(attempts, 3);
      assert.equal(
        [...refreshTokens.values()].some((r) => r.family === 'fam-1'),
        false,
      );
      assert.equal(
        [...refreshTokens.values()].some((r) => r.family === 'fam-other'),
        true,
      );
    });
  });

  it('does not return auth success when revoke fails persistently', async () => {
    let attempts = 0;
    const { prisma, refreshTokens } = createReplayStore({
      deleteManyImpl: async () => {
        attempts += 1;
        throw lockedBusyError();
      },
    });

    await withAuthApp(prisma, async (base) => {
      const res = await postAuthRefresh(base, 'R0');
      assert.notEqual(res.status, 200);
      assert.ok(res.status >= 500 || res.status === 401);
      assert.equal(attempts, 3);
      // Family still present because revoke never succeeded — auth must not mint.
      assert.equal(
        [...refreshTokens.values()].some((r) => r.token === 'R1'),
        true,
      );
    });
  });

  it('does not retry non-busy failures', async () => {
    let attempts = 0;
    const { prisma } = createReplayStore({
      deleteManyImpl: async () => {
        attempts += 1;
        throw new Error('unique constraint failed');
      },
    });

    await withAuthApp(prisma, async (base) => {
      const res = await postAuthRefresh(base, 'R0');
      assert.notEqual(res.status, 200);
      assert.equal(attempts, 1);
    });
  });
});
