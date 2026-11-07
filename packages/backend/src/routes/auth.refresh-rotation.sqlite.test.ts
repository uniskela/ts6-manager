/**
 * P1-B: real SQLite/Prisma proofs for atomic refresh rotation and family revoke.
 *
 * Handling notes (no replay grace period; no global all-device revoke):
 * - Consumed rows retained until expiresAt; replay uses replacedBy and deletes
 *   only that userId+family (null family = legacy null-family rows only).
 * - First rotate of a null-family row assigns a nanoid family.
 * - Concurrent same-token refresh: CAS updateMany — one winner; loser 401
 *   without family revoke. Frontend multi-tab uses Web Lock `ts6-auth-refresh`;
 *   browsers without locks still rely on CAS (loser retries with new token).
 * - Admin deleteMany vs in-flight rotate: closed by mint inside $transaction
 *   (no sessionEpoch / shared helper required with P1-A).
 * - Login mint rechecks enabled + passwordHash in the same transaction as
 *   create; authTestHooks only pause between verify and mint for ordering proofs.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '../../generated/prisma/index.js';
import { authRoutes, type AuthTestHooks } from './auth.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { config } from '../config.js';

const directory = mkdtempSync(join(tmpdir(), 'p1b-refresh-'));
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

function setHooks(hooks: AuthTestHooks | undefined) {
  app.locals.authTestHooks = hooks;
}

async function seedAlice() {
  setHooks(undefined);
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  const passwordHash = await bcrypt.hash('AlicePass1', 4);
  await prisma.user.create({
    data: { id: 1, username: 'alice', displayName: 'Alice', role: 'admin', passwordHash, enabled: true },
  });
}

async function adminResetPassword(newPassword: string) {
  const passwordHash = await bcrypt.hash(newPassword, 4);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: 1 }, data: { passwordHash } });
    await tx.refreshToken.deleteMany({ where: { userId: 1 } });
  });
}

async function adminDisable() {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: 1 }, data: { enabled: false } });
    await tx.refreshToken.deleteMany({ where: { userId: 1 } });
  });
}

async function putSelfPassword(base: string, body: { currentPassword: string; newPassword: string }) {
  const accessToken = jwt.sign(
    { id: 1, username: 'alice', role: 'admin' },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '15m' },
  );
  return fetch(`${base}/api/auth/password`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
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
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe('P1-B refresh rotation against real SQLite', () => {
  it('rotates atomically and detects consumed-token replay with family-only revoke', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.createMany({
      data: [
        { token: 'fam1-a', userId: 1, expiresAt, family: 'fam-1' },
        { token: 'fam2-c', userId: 1, expiresAt, family: 'fam-2' },
      ],
    });
    const base = await baseUrl();

    const first = await postRefresh(base, 'fam1-a');
    assert.equal(first.status, 200);
    const { refreshToken: fam1B } = (await first.json()) as { refreshToken: string };

    const consumed = await prisma.refreshToken.findUnique({ where: { token: 'fam1-a' } });
    assert.ok(consumed);
    assert.equal(consumed!.replacedBy, fam1B);

    const replay = await postRefresh(base, 'fam1-a');
    assert.equal(replay.status, 401);
    assert.equal(await prisma.refreshToken.count({ where: { family: 'fam-1' } }), 0);
    assert.equal(await prisma.refreshToken.count({ where: { token: 'fam2-c' } }), 1);
  });

  it('assigns a family to legacy null-family rows on first rotate and scopes reuse revoke', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.createMany({
      data: [
        { token: 'legacy-a', userId: 1, expiresAt, family: null },
        { token: 'legacy-other', userId: 1, expiresAt, family: null },
      ],
    });
    const base = await baseUrl();

    const first = await postRefresh(base, 'legacy-a');
    assert.equal(first.status, 200);
    const { refreshToken: next } = (await first.json()) as { refreshToken: string };
    const consumed = await prisma.refreshToken.findUniqueOrThrow({ where: { token: 'legacy-a' } });
    assert.ok(consumed.family);
    assert.equal(consumed.replacedBy, next);
    assert.equal(await prisma.refreshToken.count({ where: { token: 'legacy-other' } }), 1);

    const replay = await postRefresh(base, 'legacy-a');
    assert.equal(replay.status, 401);
    assert.equal(await prisma.refreshToken.count({ where: { family: consumed.family } }), 0);
    assert.equal(await prisma.refreshToken.count({ where: { token: 'legacy-other' } }), 1);
  });

  it('allows only one of two concurrent refreshes of the same token to succeed', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({
      data: { token: 'race-token', userId: 1, expiresAt, family: 'fam-race' },
    });
    const base = await baseUrl();

    const [a, b] = await Promise.all([
      postRefresh(base, 'race-token'),
      postRefresh(base, 'race-token'),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 401]);
    // Pre-commit CAS loser must not wipe the winner's family (one live successor).
    assert.equal(await prisma.refreshToken.count({ where: { family: 'fam-race', replacedBy: null } }), 1);
  });

  it('post-commit second presenter of R0 gets 401, family-revokes, and R1 is unusable', async () => {
    // Kody finding #1: after R0→R1 commits, another legitimate R0 POST is
    // wire-identical to attacker replay — protocol cannot tell them apart.
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({
      data: { token: 'R0-post', userId: 1, expiresAt, family: 'fam-post' },
    });
    const base = await baseUrl();

    const first = await postRefresh(base, 'R0-post');
    assert.equal(first.status, 200);
    const { refreshToken: r1 } = (await first.json()) as { refreshToken: string };
    assert.equal(await prisma.refreshToken.count({ where: { token: r1 } }), 1);

    const late = await postRefresh(base, 'R0-post');
    assert.equal(late.status, 401);
    assert.equal(await prisma.refreshToken.count({ where: { family: 'fam-post' } }), 0);

    const r1Reuse = await postRefresh(base, r1);
    assert.equal(r1Reuse.status, 401);
  });

  // Genuine consumed-token replay (family revoke, other families intact) remains
  // covered by "rotates atomically and detects consumed-token replay…".

  it('admin-style deleteMany of user tokens cannot leave a post-reset successor when refresh is transactional', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({
      data: { token: 'pre-admin', userId: 1, expiresAt, family: 'fam-admin' },
    });
    const base = await baseUrl();

    const refreshPromise = postRefresh(base, 'pre-admin');
    const adminPromise = prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({ where: { userId: 1 } });
    });

    const [refreshRes] = await Promise.all([refreshPromise, adminPromise]);
    if (refreshRes.status === 200) {
      const body = (await refreshRes.json()) as { refreshToken: string };
      assert.equal(await prisma.refreshToken.count({ where: { token: body.refreshToken } }), 0);
    } else {
      assert.equal(refreshRes.status, 401);
    }
    assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
  });

  it('login mint: admin reset before mint (ordering A) rejects and leaves no token', async () => {
    await seedAlice();
    const base = await baseUrl();
    // Deterministic: password verified against old hash, then admin resets before mint tx.
    setHooks({
      afterPasswordVerified: async () => {
        await adminResetPassword('NewPass1a');
      },
    });

    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'AlicePass1' }),
    });
    assert.equal(loginRes.status, 401);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
  });

  it('login mint: mint commits then admin reset (ordering B) leaves no surviving token after reset', async () => {
    await seedAlice();
    const base = await baseUrl();
    // Deterministic: no mid-flight admin — mint succeeds, then P1-A-style reset clears tokens.
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'AlicePass1' }),
    });
    assert.equal(loginRes.status, 200);
    const body = (await loginRes.json()) as { refreshToken: string; accessToken: string };
    assert.ok(body.refreshToken);
    const payload = jwt.verify(body.accessToken, config.jwtSecret) as { id: number; username: string; role: string };
    assert.equal(payload.id, 1);
    assert.equal(payload.username, 'alice');
    assert.equal(payload.role, 'admin');
    assert.equal(await prisma.refreshToken.count({ where: { token: body.refreshToken } }), 1);

    await adminResetPassword('NewPass1a');
    assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
  });

  it('login with the new password succeeds after admin reset', async () => {
    await seedAlice();
    await adminResetPassword('NewPass1a');
    const base = await baseUrl();
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'NewPass1a' }),
    });
    assert.equal(loginRes.status, 200);
    const body = (await loginRes.json()) as { refreshToken: string };
    assert.equal(await prisma.refreshToken.count({ where: { token: body.refreshToken } }), 1);
  });

  it('login mint: admin disable before mint rejects and leaves no token', async () => {
    await seedAlice();
    const base = await baseUrl();
    setHooks({
      afterPasswordVerified: async () => {
        await adminDisable();
      },
    });
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'AlicePass1' }),
    });
    assert.equal(loginRes.status, 401);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
    const alice = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    assert.equal(alice.enabled, false);
  });

  it('refresh rotate: admin disable before rotate transaction rejects and leaves no live tokens', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({
      data: { token: 'pre-disable', userId: 1, expiresAt, family: 'fam-dis' },
    });
    const base = await baseUrl();
    setHooks({
      beforeRefreshRotate: async () => {
        await adminDisable();
      },
    });
    const res = await postRefresh(base, 'pre-disable');
    assert.equal(res.status, 401);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
  });

  it('refresh rotate rolls back mark when successor insert fails', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({
      data: { token: 'pre-fail', userId: 1, expiresAt, family: 'fam-fail' },
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER IF NOT EXISTS abort_refresh_token_insert
      BEFORE INSERT ON RefreshToken
      BEGIN
        SELECT RAISE(ABORT, 'forced refresh insert failure');
      END;
    `);
    const base = await baseUrl();
    try {
      const res = await postRefresh(base, 'pre-fail');
      assert.ok(res.status >= 500);
      const row = await prisma.refreshToken.findUniqueOrThrow({ where: { token: 'pre-fail' } });
      assert.equal(row.replacedBy, null, 'failed rotate must not leave a half-consumed token');
      assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 1);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS abort_refresh_token_insert;`);
    }
  });

  it('self-service password change revokes refresh tokens atomically with the hash update', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({
      data: { token: 'self-live', userId: 1, expiresAt, family: 'fam-self' },
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    const base = await baseUrl();
    const res = await putSelfPassword(base, { currentPassword: 'AlicePass1', newPassword: 'NewPass1a' });
    assert.equal(res.status, 204);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    assert.notEqual(after.passwordHash, before.passwordHash);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
  });

  it('self-service password change rolls back when refresh revoke fails', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({
      data: { token: 'self-del-fail', userId: 1, expiresAt, family: 'fam-sdf' },
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER IF NOT EXISTS abort_refresh_token_delete_pw
      BEFORE DELETE ON RefreshToken
      BEGIN
        SELECT RAISE(ABORT, 'forced refresh delete failure');
      END;
    `);
    const base = await baseUrl();
    try {
      const res = await putSelfPassword(base, { currentPassword: 'AlicePass1', newPassword: 'NewPass1a' });
      assert.ok(res.status >= 500);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
      assert.equal(after.passwordHash, before.passwordHash);
      assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 1);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS abort_refresh_token_delete_pw;`);
    }
  });

  it('self-service password change cannot overwrite an admin reset that lands after verify', async () => {
    await seedAlice();
    setHooks({
      afterPasswordVerified: async () => {
        await adminResetPassword('AdminSetPass1');
      },
    });
    const base = await baseUrl();
    const res = await putSelfPassword(base, {
      currentPassword: 'AlicePass1',
      newPassword: 'StaleSelfPass1',
    });
    assert.equal(res.status, 401);
    setHooks(undefined);
    // Admin reset password still works; stale self-change did not win.
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'AdminSetPass1' }),
    });
    assert.equal(login.status, 200);
    const stale = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'StaleSelfPass1' }),
    });
    assert.equal(stale.status, 401);
  });

  it('disabled account cannot complete self-service password change', async () => {
    await seedAlice();
    setHooks({
      afterPasswordVerified: async () => {
        await adminDisable();
      },
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    const base = await baseUrl();
    const res = await putSelfPassword(base, {
      currentPassword: 'AlicePass1',
      newPassword: 'DisabledPass1',
    });
    assert.equal(res.status, 401);
    setHooks(undefined);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    assert.equal(after.enabled, false);
    assert.equal(after.passwordHash, before.passwordHash);
  });

  it('in-flight refresh cannot leave a live token after password-change revocation', async () => {
    await seedAlice();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.create({
      data: { token: 'inflight-live', userId: 1, expiresAt, family: 'fam-if' },
    });
    setHooks({
      beforeRefreshRotate: async () => {
        const base = await baseUrl();
        const pw = await putSelfPassword(base, {
          currentPassword: 'AlicePass1',
          newPassword: 'AfterRevoke1a',
        });
        assert.equal(pw.status, 204);
      },
    });
    const base = await baseUrl();
    const refresh = await postRefresh(base, 'inflight-live');
    assert.equal(refresh.status, 401);
    setHooks(undefined);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 0);
  });

  it('legitimate self-service password change succeeds and subsequent login works', async () => {
    await seedAlice();
    const base = await baseUrl();
    const res = await putSelfPassword(base, { currentPassword: 'AlicePass1', newPassword: 'LegitPass1a' });
    assert.equal(res.status, 204);
    const oldLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'AlicePass1' }),
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'LegitPass1a' }),
    });
    assert.equal(newLogin.status, 200);
    const body = (await newLogin.json()) as { refreshToken?: string };
    assert.ok(body.refreshToken);
  });
});
