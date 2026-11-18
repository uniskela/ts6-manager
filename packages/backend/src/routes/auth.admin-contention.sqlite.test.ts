/**
 * Administrative contention under a bounded SQLite connection pool.
 *
 * SQLite serialises writers on the database file, so a large Prisma pool adds
 * contention rather than throughput. When an administrator disables an account
 * or resets a password while authentication traffic is in flight, that
 * contention can turn into SQLITE_BUSY timeouts (Prisma P1008 / P2028), the
 * administrative write fails, and the target's refresh tokens stay usable.
 *
 * These tests run the same real routes, the same bcrypt cost and the same
 * workloads against each pool size, and compare:
 *
 *   - whether the administrative operation succeeds,
 *   - whether any target refresh token survives a successful revocation,
 *   - whether unrelated users are affected,
 *   - the error codes and latency observed.
 *
 * The pool size is read from SQLITE_TEST_POOL so the same test can be run
 * against each configuration.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { openSqliteAuthApp, type SqliteAuthPool } from './test-support/sqlite-auth-app.js';

const POOL = (process.env.SQLITE_TEST_POOL ?? 'default') as SqliteAuthPool;
const BCRYPT_COST = 12;

type AdminOutcome = {
  scenario: string;
  adminStatus: number;
  latencyMs: number;
  authStatuses: number[];
  auth500s: number;
  errorCodes: string[];
  survivors: number;
  usableTargetTokens: number;
  unrelatedStatus: number;
  auditRows: number;
  staleLoginStatus: number | null;
};

describe(`SQLite administrative contention (pool ${String(POOL)})`, { timeout: 300_000 }, () => {
  it('keeps administrative revocation reliable under authentication traffic', async () => {
    const fixture = await openSqliteAuthApp(POOL);
    const { prisma, base } = fixture;
    const adminToken = jwt.sign({ id: 2, username: 'operator', role: 'admin' }, config.jwtSecret);
    const outcomes: AdminOutcome[] = [];

    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}/api/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as { refreshToken?: string };
      return { status: response.status, refreshToken: payload.refreshToken };
    };

    try {
      for (const scenario of ['refresh-disable', 'mixed-disable', 'login-reset'] as const) {
        const trials = scenario === 'login-reset' ? 4 : 8;
        for (let trial = 0; trial < trials; trial++) {
          await fixture.reset();
          // Production-cost password hashing.
          const passwordHash = await bcryptHash('test-password');
          await prisma.user.update({ where: { id: 1 }, data: { passwordHash } });

          // Eight independently valid refresh sessions for the target, plus one
          // for an unrelated user that must survive.
          const targetTokens = Array.from({ length: 8 }, (_, i) => `session-${i}`);
          await prisma.refreshToken.createMany({
            data: [
              ...targetTokens.map((token) => ({
                token, family: token, userId: 1, expiresAt: new Date(Date.now() + 86_400_000),
              })),
              { token: 'unrelated', family: 'other', userId: 3, expiresAt: new Date(Date.now() + 86_400_000) },
            ],
          });

          const traffic = [
            ...(scenario === 'login-reset'
              ? []
              : targetTokens.map((refreshToken) => post('refresh', { refreshToken }))),
            ...Array.from({ length: scenario === 'refresh-disable' ? 0 : 4 }, () =>
              post('login', { username: 'admin', password: 'test-password' })),
          ];

          const started = performance.now();
          const admin = await fetch(`${base}/api/users/1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify(scenario === 'login-reset' ? { password: 'NewPassword1' } : { enabled: false }),
          });
          const latencyMs = Math.round(performance.now() - started);
          await admin.text();

          const auth = await Promise.all(traffic);
          const survivors = await prisma.refreshToken.count({ where: { userId: 1 } });

          // Which of the tokens the server saw are still usable?
          const candidates = new Set<string>([
            ...targetTokens,
            ...auth.map((r) => r.refreshToken).filter((t): t is string => Boolean(t)),
          ]);
          let usableTargetTokens = 0;
          for (const token of candidates) {
            if ((await post('refresh', { refreshToken: token })).status === 200) usableTargetTokens++;
          }

          const unrelatedStatus = (await post('refresh', { refreshToken: 'unrelated' })).status;
          const auditRows = await prisma.adminAuditEvent.count({
            where: { action: 'user.update', outcome: 'success' },
          });
          const staleLoginStatus = scenario === 'login-reset' && admin.status === 204
            ? (await post('login', { username: 'admin', password: 'test-password' })).status
            : null;

          outcomes.push({
            scenario,
            adminStatus: admin.status,
            latencyMs,
            authStatuses: auth.map((r) => r.status),
            auth500s: auth.filter((r) => r.status >= 500).length,
            errorCodes: [...fixture.errors],
            survivors,
            usableTargetTokens,
            unrelatedStatus,
            auditRows,
            staleLoginStatus,
          });
        }
      }

      const disable = outcomes.filter((o) => o.scenario !== 'login-reset');
      const reset = outcomes.filter((o) => o.scenario === 'login-reset');
      const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
      const summary = {
        pool: String(POOL),
        engine: fixture.engine[0],
        disableFailures: disable.filter((o) => o.adminStatus !== 204).length,
        disableTrials: disable.length,
        resetFailures: reset.filter((o) => o.adminStatus !== 204).length,
        resetTrials: reset.length,
        auth500s: outcomes.reduce((n, o) => n + o.auth500s, 0),
        errorCodes: outcomes.flatMap((o) => o.errorCodes).reduce<Record<string, number>>((acc, c) => {
          acc[c] = (acc[c] ?? 0) + 1; return acc;
        }, {}),
        medianAdminMs: latencies[Math.floor(latencies.length / 2)],
        maxAdminMs: latencies[latencies.length - 1],
        // A successful revocation must leave no usable target token.
        successfulOpsLeavingUsableTokens: outcomes.filter((o) => o.adminStatus === 204 && o.usableTargetTokens > 0).length,
        // A failed revocation leaving usable tokens is the security problem.
        failedOpsLeavingUsableTokens: outcomes.filter((o) => o.adminStatus !== 204 && o.usableTargetTokens > 0).length,
        unrelatedSessionsBroken: outcomes.filter((o) => o.unrelatedStatus !== 200).length,
        successfulOpsWithWrongAuditCount: outcomes.filter((o) => o.adminStatus === 204 && o.auditRows !== 1).length,
        stalePasswordAccepted: outcomes.filter((o) => o.staleLoginStatus === 200).length,
      };
      console.log(`ADMIN_CONTENTION_SUMMARY=${JSON.stringify(summary)}`);
      if (process.env.SQLITE_REPORT) {
        writeFileSync(process.env.SQLITE_REPORT, JSON.stringify({ summary, outcomes }, null, 2));
      }

      // Regardless of pool size: a successful administrative operation must
      // revoke every target refresh token and leave other users alone.
      for (const o of outcomes) {
        if (o.adminStatus === 204) {
          assert.equal(o.survivors, 0, `${o.scenario}: target refresh rows survived a successful revocation`);
          assert.equal(o.usableTargetTokens, 0, `${o.scenario}: a target refresh token stayed usable`);
          assert.equal(o.unrelatedStatus, 200, `${o.scenario}: an unrelated session was broken`);
          assert.equal(o.auditRows, 1, `${o.scenario}: expected exactly one audit row`);
          if (o.staleLoginStatus !== null) {
            assert.equal(o.staleLoginStatus, 401, `${o.scenario}: the old password still worked`);
          }
        }
      }
    } finally {
      await fixture.close();
    }
  });
});

/** Local bcrypt hash helper with the production cost. */
async function bcryptHash(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}
