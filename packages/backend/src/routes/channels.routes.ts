import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';

export const channelRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};
const getSid = (req: Request) => parseInt(String(req.params.sid));
const getConnectionId = (req: Request) => parseInt(String(req.params.configId), 10);

channelRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'channellist', {
      '-topic': '', '-flags': '', '-voice': '', '-limits': '', '-icon': '', '-secondsempty': '',
    }, { priority: 'high' });
    res.json(result);
  } catch (err) { next(err); }
});

channelRoutes.get('/:cid', async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'channelinfo', { cid: String(req.params.cid) });
    res.json(result);
  } catch (err) { next(err); }
});

channelRoutes.post('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    // Never audit channelcreate body (name, password, topic, description, …)
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel.create',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel' },
      },
      () => getClient(req).execute(sid, 'channelcreate', req.body),
      {
        resolveTargetId: (r) => {
          const cid = Array.isArray(r) ? (r as Array<{ cid?: unknown }>)[0]?.cid : undefined;
          return cid != null ? String(cid) : null;
        },
      },
    );
    res.status(201).json(result);
  } catch (err) { next(err); }
});

channelRoutes.put('/:cid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cid = String(req.params.cid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel.update',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel', id: cid },
      },
      () => getClient(req).execute(sid, 'channeledit', { cid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

channelRoutes.delete('/:cid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cid = String(req.params.cid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel.delete',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel', id: cid },
      },
      () => getClient(req).execute(sid, 'channeldelete', {
        cid, force: req.query.force || 1,
      }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

channelRoutes.post('/:cid/move', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cid = String(req.params.cid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel.move',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel', id: cid },
      },
      () => getClient(req).execute(sid, 'channelmove', { cid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

channelRoutes.get('/:cid/permissions', async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'channelpermlist', {
      cid: String(req.params.cid), '-permsid': '',
    });
    res.json(result);
  } catch (err) { next(err); }
});

channelRoutes.put('/:cid/permissions', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cid = String(req.params.cid);
    // Never audit permission values / names from body
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel.permission_add',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel', id: cid },
      },
      () => getClient(req).execute(sid, 'channeladdperm', { cid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

channelRoutes.delete('/:cid/permissions', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cid = String(req.params.cid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel.permission_delete',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel', id: cid },
      },
      () => getClient(req).execute(sid, 'channeldelperm', { cid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});
