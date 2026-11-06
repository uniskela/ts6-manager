import { AppError } from '../../middleware/error-handler.js';

/**
 * Playlist display-name normalisation (create / rename / import / backfill).
 *
 * **Authoritative policy:** `name.trim().toLowerCase()` in JavaScript (default
 * Unicode case mapping). Every writer and the migration backfill MUST use this
 * function. SQLite `lower()` is not used for enforcement — it is ASCII-oriented
 * and can diverge (e.g. Turkish İ/i, accented letters).
 *
 * Uniqueness compares persisted `nameKey` bytes only (already normalised).
 */
export function normalizePlaylistNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function normalizePlaylistDisplayName(name: string): string {
  return name.trim();
}

export class PlaylistNameConflictError extends AppError {
  constructor(displayName: string, existingId?: number) {
    const label = displayName.slice(0, 60);
    super(
      409,
      existingId != null
        ? `Playlist "${label}" already exists ([${existingId}]).`
        : `A playlist named "${label}" already exists.`,
      undefined,
      { reason: 'playlist_name_conflict' },
    );
    this.name = 'PlaylistNameConflictError';
  }
}

export function isPlaylistNameUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err == null) return false;
  const e = err as {
    code?: string;
    message?: string;
    meta?: { message?: string; cause?: string; driverAdapterError?: { message?: string } };
  };
  if (e.code === 'P2002') return true;
  const blob = [
    e.message,
    e.meta?.message,
    e.meta?.cause,
    e.meta?.driverAdapterError?.message,
    e.code,
  ].filter(Boolean).join(' ');
  // Trigger RAISE(ABORT, 'playlist_name_conflict') and partial unique indexes.
  // Prisma may surface these as P2002, P2010, or a generic constraint message.
  return /playlist_name_conflict|playlist_namekey_required|Playlist_server_nameKey_unique|Playlist_shared_nameKey_unique|UNIQUE constraint failed: Playlist/i
    .test(blob);
}

export type PlaylistNameConflictRow = {
  kind: 'same_scope' | 'shared_server';
  nameKey: string;
  serverConfigId: number | null;
  ids: number[];
  names: string[];
};

type PlaylistRow = { id: number; name: string; serverConfigId: number | null; nameKey?: string | null };

type NameLookupDb = {
  playlist: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { id: true; name: true; serverConfigId: true; nameKey?: true };
    }): Promise<PlaylistRow[]>;
  };
  $executeRaw?(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe?(sql: string, ...values: unknown[]): Promise<unknown>;
  $queryRawUnsafe?(sql: string, ...values: unknown[]): Promise<unknown>;
};

/**
 * Catalog-safe availability for a target scope.
 *
 * - serverConfigId = N: conflict if same nameKey on server N OR shared (null)
 * - serverConfigId = null (shared): conflict if same nameKey on ANY playlist
 */
export async function findPlaylistNameOccupant(
  db: NameLookupDb,
  nameKey: string,
  serverConfigId: number | null,
  excludeId?: number,
): Promise<{ id: number; name: string; serverConfigId: number | null } | null> {
  if (!nameKey) return null;
  const rows = await db.playlist.findMany({
    where: serverConfigId == null
      ? { nameKey }
      : { nameKey, OR: [{ serverConfigId }, { serverConfigId: null }] },
    select: { id: true, name: true, serverConfigId: true },
  });
  return rows.find((row) => row.id !== excludeId) ?? null;
}

/** Rewrite every nameKey from display name via JS (idempotent). Does not change `name`. */
export async function backfillPlaylistNameKeys(db: NameLookupDb): Promise<number> {
  if (!db.$executeRaw && !db.$executeRawUnsafe) {
    throw new Error('$executeRaw is required for nameKey backfill');
  }
  const rows = await db.playlist.findMany({
    where: { id: { gte: 0 } },
    select: { id: true, name: true, serverConfigId: true, nameKey: true },
  });
  let updated = 0;
  for (const row of rows) {
    const nameKey = normalizePlaylistNameKey(row.name);
    if (row.nameKey === nameKey) continue;
    // Raw update avoids Prisma requiring unrelated columns on legacy fixtures.
    if (db.$executeRaw) {
      await db.$executeRaw`UPDATE "Playlist" SET "nameKey" = ${nameKey} WHERE "id" = ${row.id}`;
    } else {
      await db.$executeRawUnsafe!(
        `UPDATE "Playlist" SET "nameKey" = ? WHERE "id" = ?`,
        nameKey,
        row.id,
      );
    }
    updated += 1;
  }
  return updated;
}

/**
 * Preflight: same-scope duplicates, shared-namespace duplicates, and
 * shared↔server pairs that would make a catalog ambiguous — after JS keys.
 */
export function collectPlaylistNameConflicts(rows: PlaylistRow[]): PlaylistNameConflictRow[] {
  const normalised = rows.map((row) => ({
    ...row,
    nameKey: row.nameKey && row.nameKey.length > 0
      ? row.nameKey
      : normalizePlaylistNameKey(row.name),
  }));

  const out: PlaylistNameConflictRow[] = [];
  const byScope = new Map<string, PlaylistRow[]>();
  for (const row of normalised) {
    const scope = row.serverConfigId == null ? 'shared' : `server:${row.serverConfigId}`;
    const key = `${scope}\0${row.nameKey}`;
    const list = byScope.get(key) ?? [];
    list.push(row);
    byScope.set(key, list);
  }
  for (const group of byScope.values()) {
    if (group.length < 2) continue;
    out.push({
      kind: 'same_scope',
      nameKey: group[0].nameKey!,
      serverConfigId: group[0].serverConfigId,
      ids: group.map((r) => r.id),
      names: group.map((r) => r.name),
    });
  }

  const byKey = new Map<string, PlaylistRow[]>();
  for (const row of normalised) {
    const list = byKey.get(row.nameKey!) ?? [];
    list.push(row);
    byKey.set(row.nameKey!, list);
  }
  for (const [nameKey, group] of byKey) {
    const shared = group.filter((r) => r.serverConfigId == null);
    const servers = group.filter((r) => r.serverConfigId != null);
    if (!shared.length || !servers.length) continue;
    out.push({
      kind: 'shared_server',
      nameKey,
      serverConfigId: null,
      ids: group.map((r) => r.id),
      names: group.map((r) => r.name),
    });
  }
  return out;
}

export async function findAllPlaylistNameConflicts(db: NameLookupDb): Promise<PlaylistNameConflictRow[]> {
  const rows = await db.playlist.findMany({
    where: { id: { gte: 0 } },
    select: { id: true, name: true, serverConfigId: true, nameKey: true },
  });
  return collectPlaylistNameConflicts(rows);
}

/** @deprecated use findAllPlaylistNameConflicts */
export async function findPlaylistNameKeyConflicts(db: NameLookupDb): Promise<PlaylistNameConflictRow[]> {
  return findAllPlaylistNameConflicts(db);
}

export function formatPlaylistNameConflictReport(conflicts: PlaylistNameConflictRow[]): string {
  if (!conflicts.length) return 'No playlist nameKey conflicts.';
  return conflicts.map((c) => {
    const scope = c.kind === 'shared_server'
      ? 'shared↔server'
      : c.serverConfigId == null ? 'shared' : `serverConfigId=${c.serverConfigId}`;
    return `${c.kind} ${scope} nameKey=${JSON.stringify(c.nameKey)} ids=[${c.ids.join(',')}] names=${JSON.stringify(c.names)}`;
  }).join('\n');
}

export async function allocateUniquePlaylistDisplayName(
  db: NameLookupDb,
  desiredName: string,
  serverConfigId: number | null,
  opts: { maxAttempts?: number; excludeId?: number } = {},
): Promise<{ displayName: string; nameKey: string }> {
  const maxAttempts = opts.maxAttempts ?? 50;
  const base = normalizePlaylistDisplayName(desiredName) || 'Imported Playlist';
  for (let n = 1; n <= maxAttempts; n++) {
    const displayName = n === 1 ? base : `${base} (${n})`;
    const nameKey = normalizePlaylistNameKey(displayName);
    const taken = await findPlaylistNameOccupant(db, nameKey, serverConfigId, opts.excludeId);
    if (!taken) return { displayName, nameKey };
  }
  throw new AppError(409, 'Could not allocate a unique playlist name.');
}

/** Partial unique indexes — same-server and shared namespaces. */
export const PLAYLIST_NAMEKEY_UNIQUE_INDEX_SQL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "Playlist_server_nameKey_unique" ON "Playlist" ("serverConfigId", "nameKey") WHERE "serverConfigId" IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Playlist_shared_nameKey_unique" ON "Playlist" ("nameKey") WHERE "serverConfigId" IS NULL`,
] as const;

/** Reject NULL/empty nameKey so writers cannot bypass uniqueness indexes/triggers. */
export const PLAYLIST_NAMEKEY_REQUIRED_TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS "Playlist_nameKey_require_insert"
BEFORE INSERT ON "Playlist"
FOR EACH ROW
WHEN NEW."nameKey" IS NULL OR NEW."nameKey" = ''
BEGIN
  SELECT RAISE(ABORT, 'playlist_namekey_required');
END`,
  `CREATE TRIGGER IF NOT EXISTS "Playlist_nameKey_require_update"
BEFORE UPDATE OF "nameKey" ON "Playlist"
FOR EACH ROW
WHEN NEW."nameKey" IS NULL OR NEW."nameKey" = ''
BEGIN
  SELECT RAISE(ABORT, 'playlist_namekey_required');
END`,
] as const;

/**
 * Atomic shared↔server exclusion (SQLite triggers). Partial unique indexes alone
 * cannot span NULL vs non-NULL serverConfigId.
 */
export const PLAYLIST_NAMEKEY_CROSS_TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS "Playlist_nameKey_block_cross_insert"
BEFORE INSERT ON "Playlist"
FOR EACH ROW
WHEN NEW."nameKey" IS NOT NULL AND NEW."nameKey" != ''
BEGIN
  SELECT RAISE(ABORT, 'playlist_name_conflict')
  WHERE EXISTS (
    SELECT 1 FROM "Playlist" AS p
    WHERE p."nameKey" = NEW."nameKey"
      AND (
        (NEW."serverConfigId" IS NULL AND p."serverConfigId" IS NOT NULL)
        OR (NEW."serverConfigId" IS NOT NULL AND p."serverConfigId" IS NULL)
      )
  );
END`,
  `CREATE TRIGGER IF NOT EXISTS "Playlist_nameKey_block_cross_update"
BEFORE UPDATE OF "nameKey", "serverConfigId" ON "Playlist"
FOR EACH ROW
WHEN NEW."nameKey" IS NOT NULL AND NEW."nameKey" != ''
BEGIN
  SELECT RAISE(ABORT, 'playlist_name_conflict')
  WHERE EXISTS (
    SELECT 1 FROM "Playlist" AS p
    WHERE p."id" != NEW."id"
      AND p."nameKey" = NEW."nameKey"
      AND (
        (NEW."serverConfigId" IS NULL AND p."serverConfigId" IS NOT NULL)
        OR (NEW."serverConfigId" IS NOT NULL AND p."serverConfigId" IS NULL)
      )
  );
END`,
] as const;

const REQUIRED_CONSTRAINT_OBJECTS = [
  'Playlist_server_nameKey_unique',
  'Playlist_shared_nameKey_unique',
  'Playlist_nameKey_require_insert',
  'Playlist_nameKey_require_update',
  'Playlist_nameKey_block_cross_insert',
  'Playlist_nameKey_block_cross_update',
] as const;

export async function playlistNameKeyConstraintsReady(db: NameLookupDb): Promise<boolean> {
  if (!db.$queryRawUnsafe) return true; // unit-test mocks without SQLite
  const rows = await db.$queryRawUnsafe(
    `SELECT name AS name FROM sqlite_master WHERE name IN (${REQUIRED_CONSTRAINT_OBJECTS.map(() => '?').join(',')})`,
    ...REQUIRED_CONSTRAINT_OBJECTS,
  ) as Array<{ name: string }>;
  const found = new Set(rows.map((r) => r.name));
  return REQUIRED_CONSTRAINT_OBJECTS.every((name) => found.has(name));
}

/** Refuse playlist writes until stage-2 indexes/triggers are installed. */
export async function ensurePlaylistNameKeyConstraintsReady(db: NameLookupDb): Promise<void> {
  if (await playlistNameKeyConstraintsReady(db)) return;
  throw new AppError(
    503,
    'Playlist name uniqueness is not ready. Finish nameKey migration finalisation before creating or renaming playlists.',
    undefined,
    { reason: 'playlist_namekey_not_ready' },
  );
}

/**
 * Stage 2 after migrate deploy + JS backfill: enforce uniqueness when clean.
 * Throws AppError(409) with a conflict report if preflight finds issues —
 * does not create indexes/triggers in that case (no partial unique half-apply).
 * Idempotent when already applied (IF NOT EXISTS).
 */
export async function applyPlaylistNameKeyConstraints(db: NameLookupDb): Promise<void> {
  if (!db.$executeRawUnsafe) throw new Error('$executeRawUnsafe is required');
  if (await playlistNameKeyConstraintsReady(db)) return;
  const conflicts = await findAllPlaylistNameConflicts(db);
  if (conflicts.length) {
    throw new AppError(
      409,
      `Playlist nameKey conflicts block uniqueness constraints:\n${formatPlaylistNameConflictReport(conflicts)}`,
      undefined,
      { reason: 'playlist_name_conflict' },
    );
  }
  // Empty/NULL keys must be impossible before unique indexes (otherwise '' collapses many names).
  const empty = db.$queryRawUnsafe
    ? await db.$queryRawUnsafe(
      `SELECT "id" AS id FROM "Playlist" WHERE "nameKey" IS NULL OR "nameKey" = ''`,
    ) as Array<{ id: number }>
    : await db.playlist.findMany({
      where: { nameKey: '' },
      select: { id: true, name: true, serverConfigId: true, nameKey: true },
    });
  if (empty.length) {
    throw new AppError(
      409,
      `Playlist nameKey backfill incomplete; empty keys remain for ids=[${empty.map((r) => r.id).join(',')}].`,
      undefined,
      { reason: 'playlist_namekey_required' },
    );
  }
  for (const sql of PLAYLIST_NAMEKEY_REQUIRED_TRIGGER_SQL) {
    await db.$executeRawUnsafe(sql);
  }
  for (const sql of PLAYLIST_NAMEKEY_UNIQUE_INDEX_SQL) {
    await db.$executeRawUnsafe(sql);
  }
  for (const sql of PLAYLIST_NAMEKEY_CROSS_TRIGGER_SQL) {
    await db.$executeRawUnsafe(sql);
  }
}

/**
 * Full post-migrate finalize for a temp or operator-run DB:
 * JS backfill → preflight → require-key triggers + indexes + cross triggers.
 */
export async function finalizePlaylistNameKeyMigration(db: NameLookupDb): Promise<{ backfilled: number }> {
  const backfilled = await backfillPlaylistNameKeys(db);
  await applyPlaylistNameKeyConstraints(db);
  return { backfilled };
}
