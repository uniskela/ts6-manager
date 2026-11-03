/**
 * Disposable SQLite target checks for Discord integration tooling.
 * A path substring is not enough — basename, resolved path, and symlink realpath matter.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Only this exact basename is accepted without --allow-any-database. */
export const ISOLATED_DB_BASENAME = 'discord-int-test.db';

/** Always refused for writes (even with --allow-any-database). */
const FORBIDDEN_BASENAME_RE = /^(ts6webui|prod|production)(\.db)?$/i;

export type IsolatedDbTargetAssessment = {
  ok: boolean;
  databaseUrl: string;
  filePath: string | null;
  resolvedPath: string | null;
  realPath: string | null;
  basename: string | null;
  errors: string[];
};

export function parseSqliteFilePath(databaseUrl: string, cwd = process.cwd()): string | null {
  const trimmed = databaseUrl.trim();
  const m = /^file:(.+)$/i.exec(trimmed);
  if (!m) return null;
  // Strip query/fragment — file:./x.db?discord-int-test must not trust the query.
  let filePath = m[1].split('?')[0].split('#')[0];
  if (filePath.startsWith('//')) {
    // file:///absolute or file://localhost/…
    filePath = filePath.replace(/^\/\/(localhost)?/i, '');
  }
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(cwd, filePath);
}

function isForbiddenBasename(basename: string): boolean {
  return FORBIDDEN_BASENAME_RE.test(basename) || basename.toLowerCase() === 'ts6webui.db';
}

/**
 * Assess whether a DATABASE_URL is an explicitly disposable Discord integration DB.
 * @param allowAnyDatabase — permits non-standard basenames (e.g. tmp test files) but
 *   never permits forbidden production basenames / realpaths.
 */
export function assessIsolatedSqliteTarget(
  databaseUrl: string,
  opts: { cwd?: string; allowAnyDatabase?: boolean } = {},
): IsolatedDbTargetAssessment {
  const errors: string[] = [];
  const cwd = opts.cwd ?? process.cwd();
  const allowAny = opts.allowAnyDatabase === true;
  const url = databaseUrl.trim();

  if (!url) {
    return {
      ok: false,
      databaseUrl: url,
      filePath: null,
      resolvedPath: null,
      realPath: null,
      basename: null,
      errors: ['DATABASE_URL is required'],
    };
  }

  if (!/^file:/i.test(url)) {
    return {
      ok: false,
      databaseUrl: url,
      filePath: null,
      resolvedPath: null,
      realPath: null,
      basename: null,
      errors: ['DATABASE_URL must be a file: SQLite URL'],
    };
  }

  const filePath = parseSqliteFilePath(url, cwd);
  if (!filePath) {
    return {
      ok: false,
      databaseUrl: url,
      filePath: null,
      resolvedPath: null,
      realPath: null,
      basename: null,
      errors: ['DATABASE_URL file path could not be parsed'],
    };
  }

  const resolvedPath = path.normalize(filePath);
  const basename = path.basename(resolvedPath);
  let realPath: string | null = null;

  if (isForbiddenBasename(basename)) {
    errors.push(`refusing forbidden database basename: ${basename}`);
  }

  try {
    if (fs.existsSync(resolvedPath)) {
      realPath = fs.realpathSync(resolvedPath);
      const realBase = path.basename(realPath);
      if (isForbiddenBasename(realBase)) {
        errors.push(`refusing symlink/realpath to forbidden database: ${realBase}`);
      }
      if (!allowAny && realBase !== ISOLATED_DB_BASENAME) {
        errors.push(
          `realpath basename must be ${ISOLATED_DB_BASENAME} (got ${realBase})`,
        );
      }
    }
  } catch {
    errors.push('could not resolve realpath for database file');
  }

  if (!allowAny && basename !== ISOLATED_DB_BASENAME) {
    errors.push(
      `basename must be exactly ${ISOLATED_DB_BASENAME} (substring markers are not enough)`,
    );
  }

  // Query-string smuggling: marker only in query must fail basename check above.
  if (/\?.*discord-int-test/i.test(url) && basename !== ISOLATED_DB_BASENAME) {
    errors.push('discord-int-test in query string is ignored; basename must match');
  }

  return {
    ok: errors.length === 0,
    databaseUrl: url,
    filePath,
    resolvedPath,
    realPath,
    basename,
    errors,
  };
}

/** True when the URL is an accepted disposable Discord integration SQLite target. */
export function assertSafeDatabaseUrlLabel(
  databaseUrl: string,
  opts?: { cwd?: string; allowAnyDatabase?: boolean },
): boolean {
  return assessIsolatedSqliteTarget(databaseUrl, opts).ok;
}

export function formatIsolatedDbTarget(assessment: IsolatedDbTargetAssessment): string {
  return [
    `targetUrl=${assessment.databaseUrl}`,
    `resolvedPath=${assessment.resolvedPath ?? '(n/a)'}`,
    `realpath=${assessment.realPath ?? '(file not present yet)'}`,
    `basename=${assessment.basename ?? '(n/a)'}`,
    `ok=${assessment.ok}`,
    `errors=${assessment.errors.length ? assessment.errors.join('; ') : '(none)'}`,
  ].join('\n');
}
