/**
 * Explicit production SQLite target allowlist for Discord guild-binding ops.
 * Separate from isolated-db-target (which refuses production basenames).
 * There is no --allow-any-database bypass on this path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSqliteFilePath } from './isolated-db-target.js';

/** Only these exact basenames may be written by production guild-bind tooling. */
export const PROD_GUILD_BIND_BASENAMES = new Set(['ts6webui.db']);

export type ProdDbTargetAssessment = {
  ok: boolean;
  databaseUrl: string;
  filePath: string | null;
  resolvedPath: string | null;
  realPath: string | null;
  basename: string | null;
  errors: string[];
};

export function assessProdGuildBindDatabaseUrl(
  databaseUrl: string,
  opts: { cwd?: string } = {},
): ProdDbTargetAssessment {
  const errors: string[] = [];
  const cwd = opts.cwd ?? process.cwd();
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

  if (!PROD_GUILD_BIND_BASENAMES.has(basename)) {
    errors.push(
      `basename must be one of ${[...PROD_GUILD_BIND_BASENAMES].join(', ')} (got ${basename})`,
    );
  }

  try {
    if (fs.existsSync(resolvedPath)) {
      realPath = fs.realpathSync(resolvedPath);
      const realBase = path.basename(realPath);
      if (!PROD_GUILD_BIND_BASENAMES.has(realBase)) {
        errors.push(`realpath basename not allowlisted: ${realBase}`);
      }
    }
  } catch {
    errors.push('could not resolve realpath for database file');
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

export function formatProdDbTarget(assessment: ProdDbTargetAssessment): string {
  return [
    `targetUrl=${assessment.databaseUrl}`,
    `resolvedPath=${assessment.resolvedPath ?? '(n/a)'}`,
    `realpath=${assessment.realPath ?? '(file not present yet)'}`,
    `basename=${assessment.basename ?? '(n/a)'}`,
    `ok=${assessment.ok}`,
    `errors=${assessment.errors.length ? assessment.errors.join('; ') : '(none)'}`,
  ].join('\n');
}
