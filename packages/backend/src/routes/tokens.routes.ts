import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';

export const tokenRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};
const getSid = (req: Request) => parseInt(String(req.params.sid));
const getConnectionId = (req: Request) => parseInt(String(req.params.configId), 10);

tokenRoutes.get('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try { res.json(await getClient(req).execute(getSid(req), 'privilegekeylist')); } catch (err) { next(err); }
});

tokenRoutes.post('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    // Never audit body or resolve token string from TeamSpeak response
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'privilege_key.create',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'privilege_key' },
      },
      () => getClient(req).execute(sid, 'privilegekeyadd', req.body),
    );
    res.status(201).json(result);
  } catch (err) { next(err); }
});

tokenRoutes.delete('/:token', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const token = String(req.params.token);
    // Token is a secret in the URL path — never store it as targetId
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'privilege_key.delete',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'privilege_key' },
      },
      () => getClient(req).execute(sid, 'privilegekeydelete', { token }),
    );
    res.json(result);
  } catch (err) { next(err); }
});
