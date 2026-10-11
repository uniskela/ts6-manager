import { Router, Request, Response, NextFunction } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { parseReplaceSessionIds } from '../voice/media-session.js';
import { runMediaAudited } from './media-audit.js';
import { createPlayUrlHandler } from './music-bots.routes.js';
import { defaultMediaUrlDeps } from '../voice/media-url-pipeline.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import type { QueueItem } from '../voice/playlist/queue.js';
import {
  MEDIA_UNAVAILABLE,
  MUSIC_REQUEST_HISTORY_LIMIT,
  PUBLIC_MUSIC_REQUEST_SELECT,
  isUnavailableMusicRequestError,
  markMusicRequestUnavailable,
  musicRequestListWhere,
  musicHistoryErrorCode,
  pruneMusicRequests,
  pruneOrphanMusicRequests,
  recordMusicRequest,
  replayReference,
} from '../voice/music-request-history.js';

export const musicRequestRoutes: Router = Router({ mergeParams: true });

musicRequestRoutes.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configId = Number(req.params.configId);
    if (!Number.isSafeInteger(configId) || configId <= 0) return res.status(400).json({ error: 'Invalid config id' });
    const botId = req.query.botId == null ? undefined : Number(req.query.botId);
    if (botId !== undefined && (typeof req.query.botId !== 'string' || !Number.isSafeInteger(botId) || botId <= 0)) return res.status(400).json({ error: 'Invalid bot id' });

    await pruneMusicRequests(req.app.locals.prisma, configId, 0);
    await pruneOrphanMusicRequests(req.app.locals.prisma, configId);

    const requests = await req.app.locals.prisma.musicRequest.findMany({
      where: musicRequestListWhere(configId, botId),
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: MUSIC_REQUEST_HISTORY_LIMIT,
      select: PUBLIC_MUSIC_REQUEST_SELECT,
    });
    res.json(requests);
  } catch (error) {
    next(error);
  }
});

musicRequestRoutes.post('/:id/replay', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configId = Number(req.params.configId);
    const requestId = Number(req.params.id);
    const botId = req.body?.botId;
    const enqueue = Boolean(req.body?.enqueue);
    if (![configId, requestId, botId].every((id) => Number.isSafeInteger(id) && id > 0)
      || (req.body?.enqueue !== undefined && typeof req.body.enqueue !== 'boolean')) {
      throw new AppError(400, 'Invalid replay request');
    }

    const prisma = req.app.locals.prisma;
    const row = await prisma.musicRequest.findFirst({ where: { id: requestId, serverConfigId: configId } });
    if (!row) throw new AppError(404, 'Request not found');

    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(botId);
    if (bot?.currentConfig.serverConfigId !== configId) throw new AppError(404, 'Music bot not found');

    const serverPort = bot.currentConfig.serverPort;
    const assertCurrentBot = () => {
      if (manager.getBot(botId) !== bot || bot.currentConfig.serverConfigId !== configId
        || bot.currentConfig.serverPort !== serverPort) throw new AppError(409, 'Bot changed during replay. Try again.');
    };
    const ref = await replayReference(row);
    assertCurrentBot();
    if (!ref.ok) {
      await markMusicRequestUnavailable(prisma, row.id);
      throw new AppError(410, MEDIA_UNAVAILABLE);
    }

    if (ref.kind === 'url') {
      req.body = { url: ref.url, enqueue, replaceSessionIds: req.body?.replaceSessionIds };
      req.params.id = String(botId);
      const deps = req.app.locals.mediaUrlPipelineDeps ?? defaultMediaUrlDeps();
      return createPlayUrlHandler({ ...deps, downloadTrack: async (url: string) => {
        try { return await deps.downloadTrack(url); }
        catch (error) {
          if (isUnavailableMusicRequestError(error)) throw new AppError(410, MEDIA_UNAVAILABLE);
          throw error;
        }
      } })(req, res, (err) => {
        if (err instanceof AppError && err.statusCode === 410) {
          void markMusicRequestUnavailable(prisma, row.id).then(
            () => next(new AppError(410, MEDIA_UNAVAILABLE)),
            next,
          );
          return;
        }
        next(err);
      });
    }

    const item: QueueItem = ref.kind === 'local'
      ? { id: `history_${row.id}`, title: row.title, artist: row.artist ?? undefined, duration: row.duration ?? undefined, filePath: ref.filePath, source: 'local' }
      : { id: `history_${row.id}`, title: row.title, artist: row.artist ?? undefined, filePath: '', source: 'radio', streamUrl: ref.url };
    if (bot.status !== 'connected' && bot.status !== 'playing' && bot.status !== 'paused') {
      throw new AppError(400, 'Bot is not connected');
    }
    if (enqueue) {
      bot.queue.add(item);
      await recordReplay();
      res.json({ success: true, queued: 1 });
      return;
    }
    const replaceSessionIds = parseReplaceSessionIds(req.body);
    bot.assertMusicCanStart(replaceSessionIds);
    let started = false;
    await runMediaAudited(req, bot, 'media.music.start', async () => {
      assertCurrentBot();
      bot.queue.add(item);
      bot.queue.playAt(bot.queue.length - 1);
      try {
        if (ref.kind === 'radio') await bot.playStream(item, { replaceSessionIds });
        else await bot.play(item, { replaceSessionIds });
        started = bot.nowPlaying === item;
      } finally {
        if (!started) {
          const index = bot.queue.getAll().indexOf(item);
          if (index >= 0) bot.queue.removeAt(index);
        }
      }
    }, replaceSessionIds);
    if (started) await recordReplay();
    res.json({ success: true, queued: 1 });

    async function recordReplay() {
      try {
        await recordMusicRequest(prisma, { serverConfigId: configId, musicBotId: botId, url: row.url,
          title: row.title, source: row.source, artist: row.artist ?? undefined, duration: row.duration ?? undefined });
      } catch (error) {
        console.error('[music-requests.routes] Failed to save replay history (%s)', musicHistoryErrorCode(error));
      }
    }
  } catch (error) {
    next(error);
  }
});
