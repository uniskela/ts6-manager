/**
 * Explicit production SQLite target allowlist for Discord guild-binding ops.
 * Separate from isolated-db-target (which refuses production basenames).
 * There is no --allow-any-database bypass on this path.
 *
 * Trust model: `--operator` is attribution only. Authorisation is OS/container
 * filesystem permission to read/write the target DB. Basename alone is not
 * enough — writes require an existing regular file and an exact realpath confirm.
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
  exists: boolean;
  isFile: boolean;
  errors: string[];
};

export type AssessProdDbOpts = {
  cwd?: string;
  /** When true, the file must already exist as a regular file. */
  requireExisting?: boolean;
  /**
   * Exact canonical path the operator intends to mutate.
   * Compared to fs.realpathSync — blocks wrong-directory same-basename accidents.
   */
  confirmRealpath?: string;
};

export function assessProdGuildBindDatabaseUrl(
  databaseUrl: string,
  opts: AssessProdDbOpts = {},
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
      exists: false,
      isFile: false,
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
      exists: false,
      isFile: false,
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
      exists: false,
      isFile: false,
      errors: ['DATABASE_URL file path could not be parsed'],
    };
  }

  const resolvedPath = path.normalize(filePath);
  const basename = path.basename(resolvedPath);
  let realPath: string | null = null;
  let exists = false;
  let isFile = false;

  if (!PROD_GUILD_BIND_BASENAMES.has(basename)) {
    errors.push(
      `basename must be one of ${[...PROD_GUILD_BIND_BASENAMES].join(', ')} (got ${basename})`,
    );
  }

  try {
    if (fs.existsSync(resolvedPath)) {
      exists = true;
      const st = fs.statSync(resolvedPath);
      isFile = st.isFile();
      if (!isFile) {
        errors.push('DATABASE_URL must point at a regular file');
      }
      realPath = fs.realpathSync(resolvedPath);
      const realBase = path.basename(realPath);
      if (!PROD_GUILD_BIND_BASENAMES.has(realBase)) {
        errors.push(`realpath basename not allowlisted: ${realBase}`);
      }
    }
  } catch {
    errors.push('could not resolve realpath for database file');
  }

  if (opts.requireExisting) {
    if (!exists) {
      errors.push('database file must already exist (refusing create-on-write)');
    } else if (!realPath) {
      errors.push('could not resolve canonical realpath for existing database');
    }
  }

  if (opts.confirmRealpath != null) {
    const expected = path.normalize(opts.confirmRealpath.trim());
    if (!expected) {
      errors.push('confirmRealpath is empty');
    } else if (!realPath) {
      errors.push('confirmRealpath provided but database realpath is unavailable');
    } else if (expected !== realPath) {
      errors.push(
        `confirmRealpath mismatch: expected ${expected} but database realpath is ${realPath}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    databaseUrl: url,
    filePath,
    resolvedPath,
    realPath,
    basename,
    exists,
    isFile,
    errors,
  };
}

export function formatProdDbTarget(assessment: ProdDbTargetAssessment): string {
  return [
    `targetUrl=${assessment.databaseUrl}`,
    `resolvedPath=${assessment.resolvedPath ?? '(n/a)'}`,
    `realpath=${assessment.realPath ?? '(file not present yet)'}`,
    `basename=${assessment.basename ?? '(n/a)'}`,
    `exists=${assessment.exists}`,
    `isFile=${assessment.isFile}`,
    `ok=${assessment.ok}`,
    `errors=${assessment.errors.length ? assessment.errors.join('; ') : '(none)'}`,
  ].join('\n');
}
