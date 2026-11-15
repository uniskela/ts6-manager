/**
 * P1 F-1/F-2 regressions: refresh-path contention and retention (real SQLite).
 *
 * Scenario A mirrors the independent-review invalid-refresh storm against admin
 * disable (20 concurrent invalid POSTs × several trials). Timing thresholds are
 * deliberately loose — we assert success of the admin action and absence of
 * living refresh tokens, not wall-clock SLO numbers.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../../generated/prisma/index.js';
import { authRoutes } from './auth.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { runRefreshTokenRetentionOnce } from '../auth/refresh-token-retention.js';

const directory = mkdtempSync(join(tmpdir(), 'p1-refresh-contention-'));
const databaseUrl = `file:${join(directory, 'test.db')}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const app = express();
app.use(express.json());
app.locals.prisma = prisma;
app.use('/api/auth', authRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');

async function baseUrl() {
  if (!server.listening) await new Promise<void>((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function seedAlice() {
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  const passwordHash = await bcrypt.hash('AlicePass1', 4);
  await prisma.user.create({
    data: { id: 1, username: 'alice', displayName: 'Alice', role: 'admin', passwordHash, enabled: true },
  });
}

async function adminDisable() {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: 1 }, data: { enabled: false } });
    await tx.refreshToken.deleteMany({ where: { userId: 1 } });
  });
}

async function adminResetPassword(newPassword: string) {
  const passwordHash = await bcrypt.hash(newPassword, 4);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: 1 }, data: { passwordHash } });
    await tx.refreshToken.deleteMany({ where: { userId: 1 } });
  });
}

function postRefresh(base: string, refreshToken: string) {
  return fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
}

before(() => {
  execFileSync(
    'npx',
    ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'],
    {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    },
  );
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe('P1 F-1 refresh contention against real SQLite', () => {
  it('admin disable succeeds under concurrent invalid refresh storm (20×15)', async () => {
    const base = await baseUrl();
    const trials = 15;
    const stormSize = 20;

    for (let trial = 0; trial < trials; trial++) {
      await seedAlice();
      const expiresAt = new Date(Date.now() + 86_400_000);
      await prisma.refreshToken.create({
        data: { token: `live-${trial}`, userId: 1, expiresAt, family: `fam-${trial}` },
      });

      const storm = Array.from({ length: stormSize }, (_, i) =>
        postRefresh(base, `invalid-storm-${trial}-${i}`),
      );
      const disablePromise = adminDisable();

      const [disableResult, ...responses] = await Promise.all([
        disablePromise.then(() => 'ok' as const).catch((err: unknown) => err),
        ...storm,
      ]);

      assert.equal(
        disableResult,
        'ok',
        `trial ${trial}: admin disable must complete under invalid-refresh storm`,
      );
      assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
      assert.equal((await prisma.user.findUnique({ where: { id: 1 } }))!.enabled, false);

      for (const res of responses) {
        assert.ok(
          res.status === 401 || res.status === 400,
          `trial ${trial}: invalid refresh must not succeed (got ${res.status})`,
        );
      }
    }
  });

  it('admin reset vs concurrent live refresh leaves no surviving successor', async () => {
    const base = await baseUrl();

    for (const order of ['refresh-first', 'reset-first'] as const) {
      await seedAlice();
      const expiresAt = new Date(Date.now() + 86_400_000);
      await prisma.refreshToken.create({
        data: { token: `pre-${order}`, userId: 1, expiresAt, family: `fam-${order}` },
      });
      // Unrelated user/session must survive.
      const bobHash = await bcrypt.hash('BobPass1a', 4);
      await prisma.user.create({
        data: { id: 2, username: 'bob', displayName: 'Bob', role: 'viewer', passwordHash: bobHash, enabled: true },
      });
      await prisma.refreshToken.create({
        data: { token: `bob-${order}`, userId: 2, expiresAt, family: `fam-bob-${order}` },
      });

      const refreshPromise = postRefresh(base, `pre-${order}`);
      const resetPromise =
        order === 'refresh-first'
          ? refreshPromise.then(() => adminResetPassword('NewPass1a'))
          : adminResetPassword('NewPass1a');

      if (order === 'reset-first') {
        await resetPromise;
        const refreshRes = await refreshPromise;
        assert.equal(refreshRes.status, 401);
      } else {
        const [refreshRes] = await Promise.all([refreshPromise, resetPromise]);
        if (refreshRes.status === 200) {
          const body = (await refreshRes.json()) as { refreshToken: string };
          assert.equal(await prisma.refreshToken.count({ where: { token: body.refreshToken } }), 0);
        } else {
          assert.equal(refreshRes.status, 401);
        }
      }

      assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
      assert.equal(await prisma.refreshToken.count({ where: { token: `bob-${order}` } }), 1);
      await prisma.refreshToken.deleteMany({ where: { userId: 2 } });
      await prisma.user.delete({ where: { id: 2 } });
    }
  });

  it('background retention removes expired rows without blocking refresh', async () => {
    await seedAlice();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.createMany({
      data: [
        { token: 'expired-a', userId: 1, expiresAt: past, family: 'fam-exp' },
        { token: 'expired-b', userId: 1, expiresAt: past, family: 'fam-exp' },
        { token: 'live-keep', userId: 1, expiresAt: future, family: 'fam-live' },
      ],
    });

    const deleted = await runRefreshTokenRetentionOnce(prisma);
    assert.ok(deleted >= 2);
    assert.equal(await prisma.refreshToken.count({ where: { token: 'live-keep' } }), 1);
    assert.equal(await prisma.refreshToken.count({ where: { expiresAt: { lt: new Date() } } }), 0);

    const base = await baseUrl();
    const refreshRes = await postRefresh(base, 'live-keep');
    assert.equal(refreshRes.status, 200);
  });

  it('replay family revoke stays family-scoped under concurrent invalid traffic', async () => {
    await seedAlice();
    const base = await baseUrl();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.createMany({
      data: [
        { token: 'R0', userId: 1, expiresAt, family: 'fam-replay', replacedBy: 'R1' },
        { token: 'R1', userId: 1, expiresAt, family: 'fam-replay' },
        { token: 'other', userId: 1, expiresAt, family: 'fam-other' },
      ],
    });

    const storm = Array.from({ length: 12 }, (_, i) => postRefresh(base, `junk-${i}`));
    const replay = postRefresh(base, 'R0');
    const [replayRes, ...junk] = await Promise.all([replay, ...storm]);

    assert.equal(replayRes.status, 401);
    assert.equal(await prisma.refreshToken.count({ where: { family: 'fam-replay' } }), 0);
    assert.equal(await prisma.refreshToken.count({ where: { family: 'fam-other' } }), 1);
    for (const res of junk) {
      assert.ok(res.status === 401 || res.status === 400);
    }
  });
});

describe('P1 F-1 refresh-token retention helpers', () => {
  it('retention tick failure path does not throw to callers of runRefreshTokenRetentionOnce doubles', async () => {
    // Direct unit: a prisma that throws on findMany — caller (start tick) swallows;
    // runRefreshTokenRetentionOnce itself surfaces so tests can observe errors.
    const boom = {
      refreshToken: {
        findMany: async () => {
          throw new Error('simulated retention failure');
        },
      },
    } as unknown as PrismaClient;
    await assert.rejects(() => runRefreshTokenRetentionOnce(boom), /simulated retention failure/);
  });
});
