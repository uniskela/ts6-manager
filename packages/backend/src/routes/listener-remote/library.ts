import type { Router } from 'express';
import { z } from 'zod';
import { authorizeMediaCommand } from '../../voice/media-command-permissions.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { authenticate, authorized, deny, endpoint, fail } from './shared.js';

function track(item: QueueItem | null) {
  return item ? { id: item.id, title: item.title, artist: item.artist ?? null, duration: item.duration ?? null } : null;
}

/** Player state (`GET /state`) and the server's song library (`GET /library`). */
export function registerLibraryRoutes(router: Router): void {
  router.get('/state', endpoint(async (req, res) => {
    const { binding, bot, policy, identity } = await authorized(req, 'np');
    if (!authorizeMediaCommand(policy, 'queue', identity)) deny(req, 'queue');
    const canAdd = authorizeMediaCommand(policy, 'add', identity, 'request');
    res.json({
      bot: { id: binding.botId, name: bot.currentConfig.name, status: bot.status },
      nowPlaying: track(bot.nowPlaying), upNext: bot.queue.upcoming(50).map(item => track(item)),
      upNextCount: bot.queue.upcomingCount,
      permissions: { searchLibrary: true, addToQueue: canAdd, requestUrl: canAdd },
    });
  }));

  router.get('/library', endpoint(async (req, res) => {
    const query = z.object({ search: z.string().max(200).default(''), page: z.coerce.number().int().min(1).max(10000).default(1) }).strict().safeParse(req.query);
    if (!query.success) fail(400, 'invalid_request', 'Invalid listener request.');
    const { binding } = await authorized(req, 'queue');
    const { search, page } = query.data;
    const songs = await req.app.locals.prisma.song.findMany({
      where: { serverConfigId: binding.serverConfigId, OR: [{ title: { contains: search } }, { artist: { contains: search } }] },
      select: { id: true, title: true, artist: true, duration: true },
      orderBy: { id: 'asc' }, skip: (page - 1) * 25, take: 25,
    });
    await authenticate(req);
    res.json({ songs, page, pageSize: 25 });
  }));
}
