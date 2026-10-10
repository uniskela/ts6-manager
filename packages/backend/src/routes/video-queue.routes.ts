/**
 * A bot's video queue (#253): queue videos and YouTube playlists on a stream,
 * and manage what is up next. Mounted at `/:id/stream/queue`.
 */

import { Router, type Request, type Response } from 'express';
import type { QueueVideoResponse } from '@ts6/common';
import { AppError } from '../middleware/error-handler.js';
import { expandYouTubeToWatchUrls } from '../voice/audio/youtube.js';
import { isYouTubePlaylistUrl } from '../voice/audio/playlist-import-plan.js';
import { safeSourceLabel } from '../voice/media-session.js';
import { parseStreamStartOptions } from '../voice/streaming/start-options.js';
import {
  VideoQueueFullError,
  type NewVideoQueueItem,
  type VideoQueueController,
} from '../voice/streaming/video-queue.js';
import type { VoiceBot, VideoStreamStartOptions } from '../voice/voice-bot.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import { runMediaAudited } from './media-audit.js';
import { assertVideoSource, saveBotVolume } from './music-bots.routes.js';

/** Most videos one playlist link adds. */
export const VIDEO_PLAYLIST_CAP = 25;

interface QueueContext {
  manager: VoiceBotManager;
  bot: VoiceBot;
  queue: VideoQueueController;
}

function queueContext(req: Request): QueueContext {
  const manager: VoiceBotManager = req.app.locals.voiceBotManager;
  const botId = parseInt(req.params.id as string);
  const bot = manager.getBot(botId);
  const queue = bot ? manager.getVideoQueue(botId) : undefined;
  if (!bot || !queue) throw new AppError(404, 'Music bot not found');
  return { manager, bot, queue };
}

function queueIndex(value: unknown): number {
  const index = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new AppError(400, 'Invalid queue index');
  }
  return index;
}

function startOptions(body: unknown): VideoStreamStartOptions {
  const parsed = parseStreamStartOptions(body as Record<string, unknown> | null | undefined);
  if (!parsed.ok) throw new AppError(400, parsed.error);
  return parsed.options;
}

function noPosition(): AppError {
  return new AppError(404, 'No queued video at that position');
}

export function createVideoQueueRoutes(deps: { expandYouTube?: typeof expandYouTubeToWatchUrls } = {}): Router {
  const expandYouTube = deps.expandYouTube ?? expandYouTubeToWatchUrls;
  const router: Router = Router({ mergeParams: true });

  // GET / — the lane: what is playing from the queue and what is up next
  router.get('/', (req: Request, res: Response, next) => {
    try {
      res.json(queueContext(req).queue.snapshot());
    } catch (err) { next(err); }
  });

  // POST / — queue one video, or every video of a bare YouTube playlist URL
  router.post('/', async (req: Request, res: Response, next) => {
    try {
      const { manager, bot, queue } = queueContext(req);
      const source = assertVideoSource(req.body?.source);
      const options = startOptions(req.body);
      const item = (itemSource: string, title?: string, durationSec?: number): NewVideoQueueItem => ({
        source: itemSource,
        title: title?.trim() || (safeSourceLabel(itemSource) ?? itemSource),
        ...(durationSec && durationSec > 0 ? { durationSec: Math.round(durationSec) } : {}),
        sourceMode: options.sourceMode ?? 'auto',
        addedBy: req.user?.username,
      });

      let items: NewVideoQueueItem[];
      let playlistTitle: string | undefined;
      let truncated = false;
      if (isYouTubePlaylistUrl(source)) {
        const cap = Math.min(VIDEO_PLAYLIST_CAP, queue.roomLeft());
        if (cap === 0) throw new VideoQueueFullError();
        // One more than the cap, so a longer playlist can be reported as cut.
        const expanded = await expandYouTube(source, cap + 1);
        if (expanded.urls.length === 0) {
          throw new AppError(422, 'Could not resolve any videos from that playlist URL');
        }
        truncated = expanded.urls.length > cap;
        playlistTitle = expanded.title;
        const details = new Map((expanded.items ?? []).map((entry) => [entry.url, entry]));
        items = expanded.urls.slice(0, cap).map((url) => item(url, details.get(url)?.title, details.get(url)?.durationSec));
      } else {
        items = [item(source)];
      }

      // Nothing streaming means this request starts a stream: same conflict
      // rules and audit action as stream/start.
      const willStart = !bot.videoStreaming;
      const replaceSessionIds = willStart ? options.replaceSessionIds ?? [] : [];
      if (willStart) manager.assertVideoCanStart(bot, replaceSessionIds);
      const result = await runMediaAudited(
        req, bot, willStart ? 'media.video.start' : 'media.video.queue_add',
        () => queue.enqueue(items, options),
        replaceSessionIds,
      );
      if (result.started && options.volume != null) {
        await saveBotVolume(req.app.locals.prisma, bot.currentConfig.id, bot.currentConfig.volume);
      }
      const body: QueueVideoResponse = {
        success: true,
        queued: result.queued,
        started: result.started,
        ...(playlistTitle ? { playlistTitle } : {}),
        ...(truncated || result.queued < items.length ? { truncated: true } : {}),
        state: queue.snapshot(),
      };
      res.json(body);
    } catch (err) { next(err); }
  });

  // POST /play — start the first queued video (a kept queue)
  router.post('/play', async (req: Request, res: Response, next) => {
    try {
      const { manager, bot, queue } = queueContext(req);
      const options = startOptions(req.body);
      const replaceSessionIds = options.replaceSessionIds ?? [];
      if (!bot.videoStreaming) manager.assertVideoCanStart(bot, replaceSessionIds);
      await runMediaAudited(req, bot, 'media.video.start', () => queue.playQueue(options), replaceSessionIds);
      res.json({ success: true, state: queue.snapshot() });
    } catch (err) { next(err); }
  });

  // POST /skip — move to the next queued video, or stop after the last one
  router.post('/skip', async (req: Request, res: Response, next) => {
    try {
      const { bot, queue } = queueContext(req);
      await runMediaAudited(req, bot, 'media.video.skip', () => queue.skip());
      res.json({ success: true, state: queue.snapshot() });
    } catch (err) { next(err); }
  });

  // PUT /move — reorder upcoming videos
  router.put('/move', async (req: Request, res: Response, next) => {
    try {
      const { bot, queue } = queueContext(req);
      const from = queueIndex(req.body?.from);
      const to = queueIndex(req.body?.to);
      await runMediaAudited(req, bot, 'media.video.queue_change', async () => {
        if (!(await queue.move(from, to))) throw noPosition();
      });
      res.json({ success: true, state: queue.snapshot() });
    } catch (err) { next(err); }
  });

  // POST /:index/play — play that upcoming video now
  router.post('/:index/play', async (req: Request, res: Response, next) => {
    try {
      const { manager, bot, queue } = queueContext(req);
      const index = queueIndex(req.params.index);
      if (index >= queue.snapshot().upNext.length) throw noPosition();
      const options = startOptions(req.body);
      const willStart = !bot.videoStreaming;
      const replaceSessionIds = willStart ? options.replaceSessionIds ?? [] : [];
      if (willStart) manager.assertVideoCanStart(bot, replaceSessionIds);
      await runMediaAudited(
        req, bot, willStart ? 'media.video.start' : 'media.video.skip',
        () => queue.playAt(index, options),
        replaceSessionIds,
      );
      res.json({ success: true, state: queue.snapshot() });
    } catch (err) { next(err); }
  });

  // DELETE /:index — remove an upcoming video
  router.delete('/:index', async (req: Request, res: Response, next) => {
    try {
      const { bot, queue } = queueContext(req);
      const index = queueIndex(req.params.index);
      await runMediaAudited(req, bot, 'media.video.queue_change', async () => {
        if (!(await queue.remove(index))) throw noPosition();
      });
      res.json({ success: true, state: queue.snapshot() });
    } catch (err) { next(err); }
  });

  // DELETE / — clear upcoming videos; the current one keeps playing
  router.delete('/', async (req: Request, res: Response, next) => {
    try {
      const { bot, queue } = queueContext(req);
      await runMediaAudited(req, bot, 'media.video.queue_change', () => queue.clear());
      res.json({ success: true, state: queue.snapshot() });
    } catch (err) { next(err); }
  });

  return router;
}
