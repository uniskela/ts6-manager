import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  ACTIVITY_JOURNAL_RETENTION,
  type ActivityJournalService,
} from '../activity-journal/activity-journal-service.js';

export const activityJournalRoutes: Router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

function getJournal(req: Request): ActivityJournalService | null {
  return (req.app.locals.activityJournal as ActivityJournalService | undefined) || null;
}

activityJournalRoutes.use(requireAdmin);

activityJournalRoutes.get('/retention', (_req: Request, res: Response) => {
  res.json(ACTIVITY_JOURNAL_RETENTION);
});

activityJournalRoutes.get('/targets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const journal = getJournal(req);
    if (!journal) return res.status(503).json({ error: 'Activity journal not ready' });
    const targets = await journal.listTargets();
    res.json({ targets });
  } catch (err) {
    next(err);
  }
});

activityJournalRoutes.put('/targets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const journal = getJournal(req);
    if (!journal) return res.status(503).json({ error: 'Activity journal not ready' });

    const serverConfigId = Number(req.body?.serverConfigId);
    const virtualServerId = Number(req.body?.virtualServerId);
    const enabled = Boolean(req.body?.enabled);

    if (!Number.isInteger(serverConfigId) || serverConfigId <= 0) {
      return res.status(400).json({ error: 'serverConfigId must be a positive integer' });
    }
    if (!Number.isInteger(virtualServerId) || virtualServerId <= 0) {
      return res.status(400).json({ error: 'virtualServerId must be a positive integer' });
    }

    const prisma = req.app.locals.prisma;
    const cfg = await prisma.tsServerConfig.findUnique({ where: { id: serverConfigId } });
    if (!cfg) return res.status(404).json({ error: 'Server config not found' });

    await journal.setTarget(serverConfigId, virtualServerId, enabled);
    const statuses = journal.getStatuses().filter(
      (s) => s.serverConfigId === serverConfigId && s.virtualServerId === virtualServerId,
    );
    res.json({ ok: true, status: statuses[0] || null });
  } catch (err) {
    next(err);
  }
});

activityJournalRoutes.get('/status', (req: Request, res: Response) => {
  const journal = getJournal(req);
  if (!journal) return res.status(503).json({ error: 'Activity journal not ready' });
  res.json({
    statuses: journal.getStatuses(),
    retention: ACTIVITY_JOURNAL_RETENTION,
  });
});

activityJournalRoutes.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const journal = getJournal(req);
    if (!journal) return res.status(503).json({ error: 'Activity journal not ready' });

    const serverConfigId = req.query.serverConfigId
      ? Number(req.query.serverConfigId)
      : undefined;
    const virtualServerId = req.query.virtualServerId
      ? Number(req.query.virtualServerId)
      : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    if (serverConfigId != null && (!Number.isInteger(serverConfigId) || serverConfigId <= 0)) {
      return res.status(400).json({ error: 'Invalid serverConfigId' });
    }
    if (virtualServerId != null && (!Number.isInteger(virtualServerId) || virtualServerId <= 0)) {
      return res.status(400).json({ error: 'Invalid virtualServerId' });
    }

    const result = await journal.listHistory({
      serverConfigId,
      virtualServerId,
      cursor,
      limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
