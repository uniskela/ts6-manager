import type { Router } from 'express';
import { z } from 'zod';
import { appendForListener, arrivalSnapshot } from './append.js';
import { resolveListenerLink } from './link.js';
import { authenticate, body, endpoint, fail } from './shared.js';

/** Queue a library song (`POST /queue`) or request a pasted link (`POST /requests`). */
export function registerRequestRoutes(router: Router): void {
  router.post('/queue', endpoint(async (req, res) => {
    const { songId } = body(req, z.object({ songId: z.number().int().positive().safe() }).strict());
    const arrival = arrivalSnapshot(req);
    const binding = await authenticate(req);
    await appendForListener(req, binding, async () => {
      const song = await req.app.locals.prisma.song.findFirst({ where: { id: songId, serverConfigId: binding.serverConfigId } });
      if (!song) fail(404, 'not_found', 'Song not found.');
      return {
        id: String(song.id), title: song.title, artist: song.artist ?? undefined,
        duration: song.duration ?? undefined, filePath: song.filePath, source: song.source,
        sourceUrl: song.sourceUrl ?? undefined,
      };
    }, 'listener.remote.queue_add', arrival);
    res.json({ ok: true });
  }));

  router.post('/requests', endpoint(async (req, res) => {
    const { url } = body(req, z.object({ url: z.string().max(2048).url() }).strict());
    const arrival = arrivalSnapshot(req);
    const binding = await authenticate(req);
    await appendForListener(req, binding, () => resolveListenerLink(req, binding, url), 'listener.remote.request', arrival);
    res.json({ ok: true });
  }));
}
