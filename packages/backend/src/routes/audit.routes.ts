import { Router, type Request, type Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { listAuditEvents } from '../audit/index.js';

export const auditRoutes: Router = Router();

auditRoutes.use(requireRole('admin'));

/**
 * GET /api/audit — Admin-only administrative audit history.
 * Cursor pagination; retention metadata included in every response.
 */
auditRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const result = await listAuditEvents(prisma, {
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: req.query.limit != null ? parseInt(String(req.query.limit), 10) : undefined,
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
      actorUserId: req.query.actorUserId != null ? parseInt(String(req.query.actorUserId), 10) : undefined,
      connectionId: req.query.connectionId != null ? parseInt(String(req.query.connectionId), 10) : undefined,
      virtualServerId: req.query.virtualServerId != null ? parseInt(String(req.query.virtualServerId), 10) : undefined,
      outcome: typeof req.query.outcome === 'string' ? req.query.outcome : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
