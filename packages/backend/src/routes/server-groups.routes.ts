import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';

export const serverGroupRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};
const getSid = (req: Request) => parseInt(String(req.params.sid));
const getConnectionId = (req: Request) => parseInt(String(req.params.configId), 10);

serverGroupRoutes.get('/', async (req: Request, res: Response, next) => {
  try { res.json(await getClient(req).execute(getSid(req), 'servergrouplist', undefined, { priority: 'high' })); } catch (err) { next(err); }
});

serverGroupRoutes.post('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'server_group.create',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'server_group' },
      },
      () => getClient(req).execute(sid, 'servergroupadd', req.body),
      {
        resolveTargetId: (r) => {
          const sgid = Array.isArray(r) ? (r as Array<{ sgid?: unknown }>)[0]?.sgid : undefined;
          return sgid != null ? String(sgid) : null;
        },
      },
    );
    res.status(201).json(result);
  } catch (err) { next(err); }
});

serverGroupRoutes.put('/:sgid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const sgid = String(req.params.sgid);
    // Never audit rename name from body
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'server_group.update',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'server_group', id: sgid },
      },
      () => getClient(req).execute(sid, 'servergrouprename', { sgid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

serverGroupRoutes.delete('/:sgid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const sgid = String(req.params.sgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'server_group.delete',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'server_group', id: sgid },
      },
      () => getClient(req).execute(sid, 'servergroupdel', { sgid, force: 1 }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

serverGroupRoutes.post('/:sgid/copy', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const sgid = String(req.params.sgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'server_group.copy',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'server_group', id: sgid },
      },
      () => getClient(req).execute(sid, 'servergroupcopy', { ssgid: sgid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

serverGroupRoutes.get('/:sgid/members', async (req: Request, res: Response, next) => {
  try {
    res.json(await getClient(req).execute(getSid(req), 'servergroupclientlist', { sgid: String(req.params.sgid), '-names': '' }));
  } catch (err) { next(err); }
});

serverGroupRoutes.post('/:sgid/members', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const sgid = String(req.params.sgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'server_group.member_add',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'server_group', id: sgid },
      },
      () => getClient(req).execute(sid, 'servergroupaddclient', { sgid, cldbid: req.body.cldbid }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

serverGroupRoutes.delete('/:sgid/members/:cldbid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const sgid = String(req.params.sgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'server_group.member_remove',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'server_group', id: sgid },
      },
      () => getClient(req).execute(sid, 'servergroupdelclient', {
        sgid, cldbid: String(req.params.cldbid),
      }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

serverGroupRoutes.get('/:sgid/permissions', async (req: Request, res: Response, next) => {
  try {
    res.json(await getClient(req).execute(getSid(req), 'servergrouppermlist', { sgid: String(req.params.sgid), '-permsid': '' }));
  } catch (err) { next(err); }
});

serverGroupRoutes.put('/:sgid/permissions', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const sgid = String(req.params.sgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'server_group.permission_add',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'server_group', id: sgid },
      },
      () => getClient(req).execute(sid, 'servergroupaddperm', { sgid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

serverGroupRoutes.delete('/:sgid/permissions', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const sid = getSid(req);
    const sgid = String(req.params.sgid);
    const result = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'server_group.permission_delete',
        connectionId: getConnectionId(req),
        virtualServerId: sid,
        target: { type: 'server_group', id: sgid },
      },
      () => getClient(req).execute(sid, 'servergroupdelperm', { sgid, ...req.body }),
    );
    res.json(result);
  } catch (err) { next(err); }
});
