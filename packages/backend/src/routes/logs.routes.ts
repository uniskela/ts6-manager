import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';

export const logRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};
const getSid = (req: Request) => parseInt(String(req.params.sid));

logRoutes.get('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    res.json(await getClient(req).execute(getSid(req), 'logview', {
      lines: req.query.lines || 100,
      reverse: req.query.reverse || 1,
      instance: req.query.instance || 0,
      begin_pos: req.query.begin_pos,
    }));
  } catch (err) { next(err); }
});
