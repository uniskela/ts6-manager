import type { Router } from 'express';
import { z } from 'zod';
import { clearListenerSearchResults } from './search-cache.js';
import { authenticate, body, endpoint, fail, liveIdentity, service } from './shared.js';
import {
  clearListenerRemoteCookies,
  newCsrfToken,
  sessionCredentialFromRequest,
  setListenerRemoteCookies,
} from './cookies.js';

/** Token exchange (`POST /exchange`), session probe (`GET /session`), sign-out (`DELETE /session`). */
export function registerSessionRoutes(router: Router): void {
  router.post('/exchange', endpoint(async (req, res) => {
    const { token, remember } = body(req, z.object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      remember: z.boolean().optional(),
    }).strict());
    const result = await service(req).exchange(
      token,
      async binding => Boolean(await liveIdentity(req, binding)),
      { remember: remember === true },
    );
    const csrfToken = newCsrfToken();
    setListenerRemoteCookies(req, res, result.session, csrfToken, result.expiresAt);
    // Never return the session credential to JavaScript — HttpOnly cookie only.
    res.json({
      expiresAt: new Date(result.expiresAt).toISOString(),
      botId: result.binding.botId,
      csrfToken,
      remember: result.remember,
    });
  }));

  router.get('/session', endpoint(async (req, res) => {
    const binding = await authenticate(req);
    const credential = sessionCredentialFromRequest(req);
    const expiresAt = service(req).peekSessionExpiry(credential);
    if (expiresAt == null) fail(401, 'invalid_access', 'Remote access is invalid or expired');
    res.json({ expiresAt: new Date(expiresAt).toISOString(), botId: binding.botId });
  }));

  router.delete('/session', endpoint(async (req, res) => {
    const binding = await authenticate(req);
    const remote = service(req);
    clearListenerSearchResults(remote, binding);
    remote.revoke(binding.botId, binding.uid);
    clearListenerRemoteCookies(req, res);
    res.json({ ok: true });
  }));
}
