import { openSqliteAuthApp, type SqliteAuthPool } from '../src/routes/test-support/sqlite-auth-app.js';
import { writeFileSync } from 'node:fs';

/**
 * SQLITE_TEST_POOL accepts:
 *   'default' — Prisma default pool (what production uses in this worktree)
 *   'N'       — an explicit connection_limit, e.g. '2' or '3'
 */
const rawPool = process.env.SQLITE_TEST_POOL ?? 'default';
const pool: SqliteAuthPool = rawPool === 'default' ? 'default' : Number(rawPool);
if (typeof pool === 'number' && (!Number.isInteger(pool) || pool < 1)) {
  throw new Error(`SQLITE_TEST_POOL must be 'default' or a positive integer (got ${rawPool})`);
}

const fixture = await openSqliteAuthApp(pool);
if (!process.env.SQLITE_TEST_ADDRESS_FILE) throw new Error('SQLITE_TEST_ADDRESS_FILE required');
writeFileSync(process.env.SQLITE_TEST_ADDRESS_FILE, fixture.base);
console.log(JSON.stringify({ pool: rawPool, engine: fixture.engine }));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
