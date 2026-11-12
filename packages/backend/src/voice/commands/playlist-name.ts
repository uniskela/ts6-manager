import fs from 'node:fs';
import path from 'node:path';
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

/**
 * Resolve a Prisma SQLite `DATABASE_URL` to an absolute filesystem path.
 * Relative `file:` paths are resolved against the Prisma schema directory
 * (Prisma's semantics), not `process.cwd()`.
 */
export function resolvePrismaSqliteDatabasePath(
  databaseUrl: string,
  schemaDir: string,
): { ok: true; absolutePath: string } | { ok: false; error: string } {
  const raw = databaseUrl.trim();
  if (!raw) return { ok: false, error: 'DATABASE_URL is empty' };
  if (!/^file:/i.test(raw)) {
    return { ok: false, error: 'DATABASE_URL must be a file: SQLite URL' };
  }
  let pathPart = raw.replace(/^file:/i, '');
  const queryIdx = pathPart.indexOf('?');
  if (queryIdx >= 0) pathPart = pathPart.slice(0, queryIdx);
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    return { ok: false, error: 'DATABASE_URL path could not be decoded' };
  }
  // file:///abs → /abs ; file://localhost/abs → /abs ; file:/abs → /abs
  if (pathPart.startsWith('///')) {
    pathPart = pathPart.slice(2);
  } else if (pathPart.startsWith('//')) {
    pathPart = pathPart.replace(/^\/\/[^/]*/, '') || pathPart;
  }
  if (!pathPart) return { ok: false, error: 'DATABASE_URL has empty path' };

  const absolutePath = path.isAbsolute(pathPart)
    ? path.normalize(pathPart)
    : path.resolve(schemaDir, pathPart);
  return { ok: true, absolutePath };
}

export type SqlitePreflightTarget =
  | { kind: 'absent_fresh'; absolutePath: string }
  | { kind: 'present'; absolutePath: string }
  | { kind: 'error'; message: string };

/**
 * Decide whether preflight should open the DATABASE_URL target, treat it as a
 * fresh/absent install, or fail closed. Never creates the SQLite file.
 *
 * When `markerDbFile` (apply-schema `DB_FILE`) exists at a different path than a
 * missing DATABASE_URL target, refuse — opening Prisma would initialise an empty
 * replacement DB and conceal the operator configuration error.
 */
export function classifySqlitePreflightTarget(opts: {
  databaseUrl: string;
  schemaDir: string;
  markerDbFile?: string | null;
}): SqlitePreflightTarget {
  const resolved = resolvePrismaSqliteDatabasePath(opts.databaseUrl, opts.schemaDir);
  if (!resolved.ok) return { kind: 'error', message: resolved.error };
  const { absolutePath } = resolved;

  try {
    fs.accessSync(absolutePath, fs.constants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      return {
        kind: 'error',
        message: `DATABASE_URL database is not readable: ${absolutePath}${code ? ` (${code})` : ''}`,
      };
    }
    const marker = opts.markerDbFile?.trim();
    if (marker) {
      try {
        fs.accessSync(marker, fs.constants.R_OK);
        const markerReal = fs.realpathSync(marker);
        if (path.resolve(markerReal) !== path.resolve(absolutePath)) {
          return {
            kind: 'error',
            message:
              `DATABASE_URL targets missing ${path.resolve(absolutePath)} but DB_FILE exists at ${markerReal}; ` +
              'refusing to initialise a replacement database',
          };
        }
      } catch (markerErr) {
        const markerCode = (markerErr as NodeJS.ErrnoException)?.code;
        if (markerCode !== 'ENOENT') {
          return {
            kind: 'error',
            message: `DB_FILE is not readable: ${marker}${markerCode ? ` (${markerCode})` : ''}`,
          };
        }
      }
    }
    return { kind: 'absent_fresh', absolutePath };
  }

  try {
    if (!fs.statSync(absolutePath).isFile()) {
      return { kind: 'error', message: `DATABASE_URL path is not a file: ${absolutePath}` };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      kind: 'error',
      message: `DATABASE_URL database could not be inspected: ${absolutePath}${code ? ` (${code})` : ''}`,
    };
  }
  return { kind: 'present', absolutePath };
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

export type PlaylistEmptyNormalizedRow = {
  id: number;
  name: string;
  serverConfigId: number | null;
};

export type PlaylistNameKeyCompatibilityResult = {
  playlistCount: number;
  conflicts: PlaylistNameConflictRow[];
  emptyNormalized: PlaylistEmptyNormalizedRow[];
  /** False when finalisation / uniqueness install would refuse. */
  compatible: boolean;
  report: string;
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
 * Read playlist id/name/scope (and nameKey when present) without Prisma model
 * selects that require the nameKey column. Safe on legacy v1.11.x databases and
 * on already-upgraded schemas. Read-only.
 */
export async function loadPlaylistRowsForNameKeyCompatibility(db: NameLookupDb): Promise<PlaylistRow[]> {
  if (!db.$queryRawUnsafe) {
    return db.playlist.findMany({
      where: { id: { gte: 0 } },
      select: { id: true, name: true, serverConfigId: true, nameKey: true },
    });
  }
  const tables = await db.$queryRawUnsafe(
    `SELECT name AS name FROM sqlite_master WHERE type = 'table' AND name = 'Playlist'`,
  ) as Array<{ name: string }>;
  if (!tables.length) return [];

  const cols = await db.$queryRawUnsafe(
    `PRAGMA table_info("Playlist")`,
  ) as Array<{ name: string }>;
  const hasNameKey = cols.some((c) => c.name === 'nameKey');
  if (hasNameKey) {
    return await db.$queryRawUnsafe(
      `SELECT "id" AS id, "name" AS name, "serverConfigId" AS serverConfigId, "nameKey" AS nameKey FROM "Playlist"`,
    ) as PlaylistRow[];
  }
  return await db.$queryRawUnsafe(
    `SELECT "id" AS id, "name" AS name, "serverConfigId" AS serverConfigId FROM "Playlist"`,
  ) as PlaylistRow[];
}

/**
 * Project JS nameKeys and report every condition that would make finalisation refuse:
 * same-scope duplicates, shared↔server collisions, and blank / whitespace-only names
 * (empty normalised keys). Never mutates rows.
 */
export function assessPlaylistNameKeyCompatibility(rows: PlaylistRow[]): PlaylistNameKeyCompatibilityResult {
  const projected = rows.map((row) => ({
    ...row,
    nameKey: normalizePlaylistNameKey(row.name),
  }));
  const emptyNormalized: PlaylistEmptyNormalizedRow[] = projected
    .filter((row) => !row.nameKey)
    .map((row) => ({
      id: row.id,
      name: row.name,
      serverConfigId: row.serverConfigId,
    }));
  const conflicts = collectPlaylistNameConflicts(projected);
  const compatible = conflicts.length === 0 && emptyNormalized.length === 0;
  return {
    playlistCount: rows.length,
    conflicts,
    emptyNormalized,
    compatible,
    report: formatPlaylistNameKeyCompatibilityReport(conflicts, emptyNormalized),
  };
}

export function formatPlaylistNameKeyCompatibilityReport(
  conflicts: PlaylistNameConflictRow[],
  emptyNormalized: PlaylistEmptyNormalizedRow[] = [],
): string {
  const parts: string[] = [];
  if (conflicts.length) {
    parts.push(formatPlaylistNameConflictReport(conflicts));
  }
  if (emptyNormalized.length) {
    parts.push(
      emptyNormalized.map((row) => {
        const scope = row.serverConfigId == null ? 'shared' : `serverConfigId=${row.serverConfigId}`;
        return `empty_normalized ${scope} id=${row.id} name=${JSON.stringify(row.name)}`;
      }).join('\n'),
    );
  }
  if (!parts.length) return 'No playlist nameKey conflicts.';
  return parts.join('\n');
}

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
  const rows = await loadPlaylistRowsForNameKeyCompatibility(db);
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

/**
 * Read-only pre-upgrade / pre-push compatibility check.
 * Uses raw SQL so legacy databases without nameKey are safe to inspect.
 * Never writes nameKey values, never installs constraints, never alters schema.
 */
export async function preflightPlaylistNameKeyCompatibility(
  db: NameLookupDb,
): Promise<PlaylistNameKeyCompatibilityResult> {
  const rows = await loadPlaylistRowsForNameKeyCompatibility(db);
  return assessPlaylistNameKeyCompatibility(rows);
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

/**
 * Non-destructive preview: projects JS nameKeys and reports every refusal
 * condition (conflicts + empty/whitespace-only names). Does not write nameKey
 * values or install constraints. Safe on legacy DBs without a nameKey column.
 */
export async function previewPlaylistNameKeyMigration(db: NameLookupDb): Promise<{
  playlistCount: number;
  wouldBackfill: number;
  constraintsReady: boolean;
  conflicts: PlaylistNameConflictRow[];
  emptyNormalized: PlaylistEmptyNormalizedRow[];
  compatible: boolean;
  report: string;
}> {
  const rows = await loadPlaylistRowsForNameKeyCompatibility(db);
  const assessment = assessPlaylistNameKeyCompatibility(rows);
  const wouldBackfill = rows.filter(
    (row) => (row.nameKey ?? '') !== normalizePlaylistNameKey(row.name),
  ).length;
  const constraintsReady = await playlistNameKeyConstraintsReady(db);
  return {
    playlistCount: assessment.playlistCount,
    wouldBackfill,
    constraintsReady,
    conflicts: assessment.conflicts,
    emptyNormalized: assessment.emptyNormalized,
    compatible: assessment.compatible,
    report: assessment.report,
  };
}

