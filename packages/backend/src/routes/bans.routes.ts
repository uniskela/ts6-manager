import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';

export const banRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};
const getSid = (req: Request) => parseInt(String(req.params.sid));

banRoutes.get('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try { res.json(await getClient(req).execute(getSid(req), 'banlist')); } catch (err) { next(err); }
});

banRoutes.post('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const connectionId = parseInt(String(req.params.configId), 10);
    const sid = getSid(req);
    // Pass-through to TeamSpeak; never audit req.body (may contain ip/uid/reason)
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'ban.create',
        connectionId,
        virtualServerId: sid,
        target: { type: 'ban' },
      },
      () => getClient(req).execute(sid, 'banadd', req.body),
      {
        resolveTargetId: (r) => {
          const banid = Array.isArray(r) ? (r as Array<{ banid?: unknown }>)[0]?.banid : undefined;
          return banid != null ? String(banid) : null;
        },
      },
    );
    res.status(201).json(result);
  } catch (err) { next(err); }
});

banRoutes.delete('/:banid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const connectionId = parseInt(String(req.params.configId), 10);
    const sid = getSid(req);
    const banid = String(req.params.banid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'ban.delete',
        connectionId,
        virtualServerId: sid,
        target: { type: 'ban', id: banid },
      },
      () => getClient(req).execute(sid, 'bandel', { banid }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

banRoutes.delete('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const connectionId = parseInt(String(req.params.configId), 10);
    const sid = getSid(req);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'ban.delete_all',
        connectionId,
        virtualServerId: sid,
        target: { type: 'ban' },
      },
      () => getClient(req).execute(sid, 'bandelall'),
    );
    res.json(result);
  } catch (err) { next(err); }
});
