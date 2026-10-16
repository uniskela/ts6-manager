import type { Router } from 'express';
import { z } from 'zod';
import { authenticate, body, endpoint, liveIdentity, service } from './shared.js';

/** Token exchange (`POST /exchange`) and listener sign-out (`DELETE /session`). */
export function registerSessionRoutes(router: Router): void {
  router.post('/exchange', endpoint(async (req, res) => {
    const { token } = body(req, z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict());
    const result = await service(req).exchange(token, async binding => Boolean(await liveIdentity(req, binding)));
    res.json({ session: result.session, expiresAt: new Date(result.expiresAt).toISOString(), botId: result.binding.botId });
  }));

  router.delete('/session', endpoint(async (req, res) => {
    const binding = await authenticate(req);
    service(req).revoke(binding.botId, binding.uid);
    res.json({ ok: true });
  }));
}
