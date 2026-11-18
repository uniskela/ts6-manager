/**
 * Refresh-token replay and revocation under a bounded SQLite pool.
 *
 * The pool size must not change the security semantics of the refresh
 * protocol. This test proves, at whatever pool size is configured:
 *
 *   - one-use rotation stays atomic (exactly one successor per token),
 *   - a genuine consumed-token replay revokes ONLY its own session family,
 *   - unrelated session families stay valid,
 *   - a persistent external database lock fails closed without issuing a
 *     successor token.
 *
 * It complements auth.refresh-rotation.sqlite.test.ts, which covers the
 * protocol invariants themselves.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSqliteAuthApp, type SqliteAuthPool } from './test-support/sqlite-auth-app.js';

const POOL = (process.env.SQLITE_TEST_POOL ?? 'default') as SqliteAuthPool;

describe(`SQLite replay and revocation (pool ${String(POOL)})`, { timeout: 180_000 }, () => {
  it('keeps one-use rotation atomic and family-scoped', async () => {
    const fixture = await openSqliteAuthApp(POOL);
    const { prisma, base } = fixture;
    try {
      const post = (token: string) => fetch(`${base}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });

      // Two independent families for the same user, plus one for another user.
      const familyA = 'family-a';
      const familyB = 'family-b';
      await prisma.refreshToken.createMany({ data: [
        { token: 'R0-a', family: familyA, userId: 1, expiresAt: new Date(Date.now() + 86_400_000) },
        { token: 'R0-b', family: familyB, userId: 1, expiresAt: new Date(Date.now() + 86_400_000) },
        { token: 'R0-other', family: 'family-other', userId: 3, expiresAt: new Date(Date.now() + 86_400_000) },
      ] });

      // Rotation is atomic: R0-a becomes R1-a and the original is consumed.
      const first = await post('R0-a');
      assert.equal(first.status, 200);
      const { refreshToken: r1a } = await first.json() as { refreshToken: string };
      assert.ok(r1a);
      const consumed = await prisma.refreshToken.findUnique({ where: { token: 'R0-a' } });
      assert.equal(consumed?.replacedBy, r1a);
      assert.equal(await prisma.refreshToken.count({ where: { token: r1a } }), 1);

      // A genuine replay of the consumed token is rejected and revokes only
      // its own family.
      const replay = await post('R0-a');
      assert.equal(replay.status, 401);
      assert.equal(await prisma.refreshToken.count({ where: { family: familyA } }), 0);

      // The other family of the same user is untouched.
      const other = await post('R0-b');
      assert.equal(other.status, 200);
      // And so is the other user's family.
      const otherUser = await post('R0-other');
      assert.equal(otherUser.status, 200);
    } finally {
      await fixture.close();
    }
  });

  it('fails closed on a persistent external lock without issuing a successor', async () => {
    const fixture = await openSqliteAuthApp(POOL);
    const { prisma, base } = fixture;
    try {
      await prisma.refreshToken.createMany({ data: [
        { token: 'R0-lock', family: 'fam-lock', userId: 1, expiresAt: new Date(Date.now() + 86_400_000) },
      ] });

      // Hold an exclusive write lock on the database file from another process.
      const locker = spawn('python3', ['-u', '-c',
        'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); c.execute("BEGIN IMMEDIATE"); print("locked",flush=True); sys.stdin.readline(); c.rollback(); c.close()',
        fixture.databaseUrl.slice(5),
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      try {
        const [ready] = await once(locker.stdout, 'data');
        assert.match(String(ready), /locked/);
        const response = await fetch(`${base}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: 'R0-lock' }),
        });
        // The request must fail, not succeed.
        assert.ok(response.status >= 500, `expected a server error while locked, got ${response.status}`);
        const body = await response.json().catch(() => ({})) as { refreshToken?: string };
        // No successor token may be issued while the database is locked.
        assert.equal(body.refreshToken, undefined, 'a successor token was issued while the database was locked');
        // And the original token must not have been consumed.
        const row = await prisma.refreshToken.findUnique({ where: { token: 'R0-lock' } });
        assert.equal(row?.replacedBy ?? null, null);
      } finally {
        locker.stdin.end('\n');
        await once(locker, 'exit');
      }
    } finally {
      await fixture.close();
    }
  });
});
