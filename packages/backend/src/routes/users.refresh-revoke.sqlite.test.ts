/**
 * P1-A corrections: real SQLite/Prisma proofs for atomic revoke + target scoping.
 * Complements the in-memory suite; does not replace the P1-A production fix (c3b3a85 / tip).
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
import { userRoutes } from './users.routes.js';
import { authRoutes } from './auth.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

const directory = mkdtempSync(join(tmpdir(), 'p1a-revoke-'));
const databaseUrl = `file:${join(directory, 'test.db')}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).user = { id: 1, role: 'admin', username: 'admin' };
  next();
});
app.locals.prisma = prisma;
app.use('/api/users', userRoutes);
app.use('/api/auth', authRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');

async function baseUrl() {
  if (!server.listening) await new Promise<void>((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function seedUsers() {
  await prisma.refreshToken.deleteMany();
  await prisma.adminAuditEvent.deleteMany();
  await prisma.user.deleteMany();
  const adminHash = await bcrypt.hash('AdminPass1', 4);
  const victimHash = await bcrypt.hash('VictimPass1', 4);
  const otherHash = await bcrypt.hash('OtherPass1', 4);
  await prisma.user.create({
    data: { id: 1, username: 'admin', displayName: 'Admin', role: 'admin', passwordHash: adminHash, enabled: true },
  });
  await prisma.user.create({
    data: { id: 2, username: 'victim', displayName: 'Victim', role: 'viewer', passwordHash: victimHash, enabled: true },
  });
  await prisma.user.create({
    data: { id: 3, username: 'other', displayName: 'Other', role: 'viewer', passwordHash: otherHash, enabled: true },
  });
}

function expiresSoon() {
  return new Date(Date.now() + 86_400_000);
}

async function putUser(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/users/2`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function assertRefreshRejected(base: string, refreshToken: string) {
  const refresh = await fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  assert.equal(refresh.status, 401);
}

async function withAbortTrigger(name: string, sql: string, run: () => Promise<void>) {
  await prisma.$executeRawUnsafe(sql);
  try {
    await run();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name};`);
  }
}

async function assertPasswordDisableRolledBack(beforeHash: string) {
  const afterUser = await prisma.user.findUniqueOrThrow({ where: { id: 2 } });
  assert.equal(afterUser.passwordHash, beforeHash);
  assert.equal(afterUser.enabled, true);
  assert.equal(await prisma.refreshToken.count({ where: { userId: 2 } }), 1);
  assert.equal(await prisma.adminAuditEvent.count(), 0);
}

/** Shared seed + put + rollback assert; each caller supplies a distinct abort trigger. */
async function assertPasswordDisableRollsBackOnTrigger(opts: {
  token: string;
  family: string;
  triggerName: string;
  triggerSql: string;
}) {
  await seedUsers();
  await prisma.refreshToken.create({
    data: {
      token: opts.token,
      userId: 2,
      expiresAt: expiresSoon(),
      family: opts.family,
    },
  });
  const before = await prisma.user.findUniqueOrThrow({ where: { id: 2 } });
  const base = await baseUrl();
  await withAbortTrigger(opts.triggerName, opts.triggerSql, async () => {
    const put = await putUser(base, { password: 'NewPass1a', enabled: false });
    assert.ok(put.status >= 500, `expected server error, got ${put.status}`);
    await assertPasswordDisableRolledBack(before.passwordHash);
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

describe('P1-A refresh revoke against real SQLite', () => {
  it('rolls back password/disable/revoke/audit when audit insert fails', async () => {
    await assertPasswordDisableRollsBackOnTrigger({
      token: 'victim-live',
      family: 'fam-v',
      triggerName: 'abort_admin_audit_insert',
      triggerSql: `
      CREATE TRIGGER IF NOT EXISTS abort_admin_audit_insert
      BEFORE INSERT ON AdminAuditEvent
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END;
    `,
    });
  });

  it('password reset revokes only the target user family of refresh tokens', async () => {
    await seedUsers();
    const expiresAt = expiresSoon();
    await prisma.refreshToken.createMany({
      data: [
        { token: 'victim-a', userId: 2, expiresAt, family: 'fam-v' },
        { token: 'other-a', userId: 3, expiresAt, family: 'fam-o' },
        { token: 'admin-a', userId: 1, expiresAt, family: 'fam-a' },
      ],
    });

    const base = await baseUrl();
    assert.equal((await putUser(base, { password: 'NewPass1a' })).status, 204);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 2 } }), 0);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 3 } }), 1);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 1 } }), 1);
    await assertRefreshRejected(base, 'victim-a');
  });

  it('disable then re-enable leaves revoked tokens dead; other users untouched', async () => {
    await seedUsers();
    const expiresAt = expiresSoon();
    await prisma.refreshToken.createMany({
      data: [
        { token: 'victim-b', userId: 2, expiresAt, family: 'fam-v2' },
        { token: 'other-b', userId: 3, expiresAt, family: 'fam-o2' },
      ],
    });
    const base = await baseUrl();

    assert.equal((await putUser(base, { enabled: false })).status, 204);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 2 } }), 0);

    assert.equal((await putUser(base, { enabled: true })).status, 204);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 2 } }), 0);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 3 } }), 1);
    await assertRefreshRejected(base, 'victim-b');
  });

  it('rolls back password update when refresh-token delete fails inside the transaction', async () => {
    await assertPasswordDisableRollsBackOnTrigger({
      token: 'victim-del-fail',
      family: 'fam-df',
      triggerName: 'abort_refresh_token_delete',
      triggerSql: `
      CREATE TRIGGER IF NOT EXISTS abort_refresh_token_delete
      BEFORE DELETE ON RefreshToken
      BEGIN
        SELECT RAISE(ABORT, 'forced refresh delete failure');
      END;
    `,
    });
  });

  it('enabled:true with live tokens does not revoke sessions', async () => {
    await seedUsers();
    const expiresAt = expiresSoon();
    await prisma.refreshToken.createMany({
      data: [
        { token: 'victim-live-en', userId: 2, expiresAt, family: 'fam-en' },
        { token: 'other-live-en', userId: 3, expiresAt, family: 'fam-en-o' },
      ],
    });
    const base = await baseUrl();
    assert.equal((await putUser(base, { enabled: true })).status, 204);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 2 } }), 1);
    assert.equal(await prisma.refreshToken.count({ where: { userId: 3 } }), 1);
  });
});
