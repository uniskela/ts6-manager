import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import {
  AppError,
  isTeamSpeakLogviewIoError,
  TeamSpeakLogviewIoError,
  TSApiError,
} from '../middleware/error-handler.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { buildServerLogPage, parseLogQuery } from './logs-page.js';

export const logRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId), 10));
};
const getSid = (req: Request) => parseInt(String(req.params.sid), 10);

/**
 * Coalesce overlapping logview calls for the same scope so React Query retries /
 * duplicate mounts cannot stampede TeamSpeak (known to surface error 2052 under load).
 */
const inflightLogview = new Map<string, Promise<unknown>>();

function coalesceLogview<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflightLogview.get(key);
  if (existing) return existing as Promise<T>;

  const pending = run().finally(() => {
    if (inflightLogview.get(key) === pending) {
      inflightLogview.delete(key);
    }
  });
  inflightLogview.set(key, pending);
  return pending;
}

/** Test helper — clears coalescing state between unit tests. */
export function resetLogviewInflightForTests(): void {
  inflightLogview.clear();
}

logRoutes.get('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const configId = parseInt(String(req.params.configId), 10);
    const sid = getSid(req);
    if (!Number.isInteger(configId) || configId < 1 || !Number.isInteger(sid) || sid < 1) {
      throw new AppError(400, 'Invalid server context');
    }

    const parsed = parseLogQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      throw new AppError(400, parsed.message);
    }

    const params: Record<string, string | number> = {
      lines: parsed.lines,
      reverse: parsed.reverse,
      instance: parsed.instance,
    };
    if (parsed.beginPos !== undefined) {
      params.begin_pos = parsed.beginPos;
    }

    // Instance logfile is server-wide: use sid=0 (same pattern as instanceinfo).
    // Keep the selected VS sid in the response context for UI labeling only.
    const querySid = parsed.instance === 1 ? 0 : sid;
    const coalesceKey = [
      configId,
      querySid,
      parsed.instance,
      parsed.lines,
      parsed.reverse,
      parsed.beginPos ?? '',
    ].join(':');

    let raw: unknown;
    try {
      raw = await coalesceLogview(coalesceKey, () =>
        getClient(req).execute(querySid, 'logview', params),
      );
    } catch (err) {
      if (isTeamSpeakLogviewIoError(err)) {
        const ts = err instanceof TSApiError ? err : null;
        throw new TeamSpeakLogviewIoError(ts?.code ?? 2052, ts?.message ?? 'file input/output error');
      }
      throw err;
    }

    res.json(buildServerLogPage({
      configId,
      sid,
      lines: parsed.lines,
      reverse: parsed.reverse,
      instance: parsed.instance,
      beginPos: parsed.beginPos,
      raw,
    }));
  } catch (err) { next(err); }
});
