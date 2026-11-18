/**
 * SQLite connection-pool sizing.
 *
 * Prisma opens a pool of connections per client. For SQLite that pool is a
 * liability: SQLite serialises writers on the database file, so extra
 * connections do not add write throughput — they only add contention. When an
 * administrator disables an account or resets a password while ordinary
 * authentication traffic is in flight, the extra connections turn that
 * contention into `SQLITE_BUSY` timeouts (Prisma P1008 / P2028), which can
 * make the administrative write fail and leave the target's refresh tokens
 * usable.
 *
 * A pool of two keeps enough concurrency for ordinary reads while making the
 * write contention bounded and observable.
 *
 * The connection limit is appended to the configured database URL so the
 * operator keeps full control:
 *
 *   - the database path is preserved exactly;
 *   - unrelated query parameters are preserved;
 *   - an explicitly configured `connection_limit` is respected and never
 *     overwritten.
 */
export const DEFAULT_SQLITE_CONNECTION_LIMIT = 2;

/**
 * Return the database URL to use for the SQLite connection pool.
 *
 * A non-SQLite URL is returned unchanged: the limit only applies to SQLite.
 * An explicit `connection_limit` in the URL is left alone so an operator can
 * opt into a different pool size.
 */
export function sqliteDatasourceUrl(
  databaseUrl: string,
  defaultLimit: number = DEFAULT_SQLITE_CONNECTION_LIMIT,
): string {
  if (!isSqliteUrl(databaseUrl)) return databaseUrl;

  const queryStart = databaseUrl.indexOf('?');
  const query = queryStart < 0 ? '' : databaseUrl.slice(queryStart + 1);
  const params = new URLSearchParams(query);
  // Respect an explicit operator override.
  if (params.has('connection_limit')) return databaseUrl;

  params.set('connection_limit', String(defaultLimit));
  const base = queryStart < 0 ? databaseUrl : databaseUrl.slice(0, queryStart);
  return `${base}?${params.toString()}`;
}

/** Whether the URL addresses a SQLite database. */
export function isSqliteUrl(databaseUrl: string): boolean {
  return databaseUrl.startsWith('file:') || databaseUrl.startsWith(':memory:');
}
