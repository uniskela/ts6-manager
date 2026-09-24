import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';

export const channelGroupRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};
const getSid = (req: Request) => parseInt(String(req.params.sid));
const getConnectionId = (req: Request) => parseInt(String(req.params.configId), 10);

channelGroupRoutes.get('/', async (req: Request, res: Response, next) => {
  try { res.json(await getClient(req).execute(getSid(req), 'channelgrouplist', undefined, { priority: 'high' })); } catch (err) { next(err); }
});

channelGroupRoutes.post('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel_group.create',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel_group' },
      },
      () => getClient(req).execute(sid, 'channelgroupadd', req.body),
      {
        resolveTargetId: (r) => {
          const cgid = Array.isArray(r) ? (r as Array<{ cgid?: unknown }>)[0]?.cgid : undefined;
          return cgid != null ? String(cgid) : null;
        },
      },
    );
    res.status(201).json(result);
  } catch (err) { next(err); }
});

channelGroupRoutes.put('/:cgid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cgid = String(req.params.cgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel_group.update',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel_group', id: cgid },
      },
      () => getClient(req).execute(sid, 'channelgrouprename', { cgid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

channelGroupRoutes.delete('/:cgid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cgid = String(req.params.cgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel_group.delete',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel_group', id: cgid },
      },
      () => getClient(req).execute(sid, 'channelgroupdel', { cgid, force: 1 }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

channelGroupRoutes.get('/:cgid/clients', async (req: Request, res: Response, next) => {
  try {
    res.json(await getClient(req).execute(getSid(req), 'channelgroupclientlist', { cgid: String(req.params.cgid) }));
  } catch (err) { next(err); }
});

channelGroupRoutes.post('/:cgid/assign', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cgid = String(req.params.cgid);
    // Body may include cldbid/cid — record group id only
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel_group.assign',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel_group', id: cgid },
      },
      () => getClient(req).execute(sid, 'setclientchannelgroup', { cgid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

channelGroupRoutes.get('/:cgid/permissions', async (req: Request, res: Response, next) => {
  try {
    res.json(await getClient(req).execute(getSid(req), 'channelgrouppermlist', { cgid: String(req.params.cgid), '-permsid': '' }));
  } catch (err) { next(err); }
});

channelGroupRoutes.put('/:cgid/permissions', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cgid = String(req.params.cgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel_group.permission_add',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel_group', id: cgid },
      },
      () => getClient(req).execute(sid, 'channelgroupaddperm', { cgid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

channelGroupRoutes.delete('/:cgid/permissions', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const cgid = String(req.params.cgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'channel_group.permission_delete',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'channel_group', id: cgid },
      },
      () => getClient(req).execute(sid, 'channelgroupdelperm', { cgid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});
