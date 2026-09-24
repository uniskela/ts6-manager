import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { buildServerLogPage, parseLogQuery } from './logs-page.js';

export const logRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId), 10));
};
const getSid = (req: Request) => parseInt(String(req.params.sid), 10);

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
    const raw = await getClient(req).execute(querySid, 'logview', params);
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
