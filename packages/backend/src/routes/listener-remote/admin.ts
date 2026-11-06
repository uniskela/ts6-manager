import type { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/rbac.js';
import { actorFromRequest, runRemoteAudited } from '../../audit/index.js';
import { clearAllListenerSearchResults, clearListenerSearchResults } from './search-cache.js';
import { body, endpoint, fail, service } from './shared.js';

/** Admin-only revocation of a bot's listener access (`POST /bots/:botId/revoke`). */
export function registerAdminRoutes(router: Router): void {
  router.use(requireRole('admin'));
  router.post('/bots/:botId/revoke', endpoint(async (req, res) => {
    const botId = Number(req.params.botId);
    if (!Number.isSafeInteger(botId) || botId <= 0) fail(400, 'invalid_request', 'Invalid bot ID.');
    const { uid } = body(req, z.object({ uid: z.string().min(1).max(256).optional() }).strict());
    const row = await req.app.locals.prisma.musicBot.findUnique({ where: { id: botId } });
    if (!row) fail(404, 'not_found', 'Bot not found.');
    const remote = service(req);
    const revoked = await runRemoteAudited(req.app.locals.prisma, {
      actor: actorFromRequest(req.user), action: 'listener.remote.revoke',
      connectionId: row.serverConfigId, virtualServerId: row.virtualServerId,
      target: { type: 'music_bot', id: botId },
    }, () => {
      if (uid) clearListenerSearchResults(remote, { botId, uid });
      else clearAllListenerSearchResults(remote);
      return remote.revoke(botId, uid);
    });
    res.json({ revoked });
  }));
}
