import type { Router } from 'express';
import { z } from 'zod';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { appendForListener, arrivalSnapshot } from './append.js';
import { checkListenerUrl, listenerLink } from './link.js';
import { authenticate, body, endpoint, fail } from './shared.js';

/** Queue a library song (`POST /queue`) or request a pasted link (`POST /requests`). */
export function registerRequestRoutes(router: Router): void {
  router.post('/queue', endpoint(async (req, res) => {
    const { songId } = body(req, z.object({ songId: z.number().int().positive().safe() }).strict());
    const arrival = arrivalSnapshot(req);
    const binding = await authenticate(req);
    let item: QueueItem | undefined;
    await appendForListener(req, binding, async () => item!, 'listener.remote.queue_add', arrival, async () => {
      const song = await req.app.locals.prisma.song.findFirst({ where: { id: songId, serverConfigId: binding.serverConfigId } });
      if (!song) fail(404, 'not_found', 'Song not found.');
      item = {
        id: String(song.id), title: song.title, artist: song.artist ?? undefined,
        duration: song.duration ?? undefined, filePath: song.filePath, source: song.source,
        sourceUrl: song.sourceUrl ?? undefined,
      };
    });
    res.json({ ok: true });
  }));

  router.post('/requests', endpoint(async (req, res) => {
    const { url } = body(req, z.object({ url: z.string().max(2048).url() }).strict());
    const arrival = arrivalSnapshot(req);
    // Malformed and plainly disallowed links are refused before any lookup or audit work.
    await checkListenerUrl(url);
    const binding = await authenticate(req);
    const link = listenerLink(req, binding, url);
    try {
      await appendForListener(req, binding, () => link.resolve(), 'listener.remote.request', arrival, () => link.check());
    } finally {
      link.dispose();
    }
    res.json({ ok: true });
  }));
}
