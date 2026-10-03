import { Router, Request, Response, type RequestHandler } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';
import { avatarImageType, saveBotAvatar, readBotAvatar, MAX_AVATAR_BYTES, type BotAvatarMode } from '../utils/bot-avatar-storage.js';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import type { VoiceBot } from '../voice/voice-bot.js';
import { serializeCommandChannelIds, parseCommandChannelIds } from '../voice/music-command-channels.js';
import { playerWidgetToken } from './widget-public.routes.js';
import { parseStreamStartOptions } from '../voice/streaming/start-options.js';
import { parseReplaceSessionIds } from '../voice/media-session.js';
import { runMediaAudited } from './media-audit.js';
import { defaultMediaUrlDeps, runMediaUrlPipeline, type MediaUrlPipelineDeps } from '../voice/media-url-pipeline.js';
import type { QueueItem } from '../voice/playlist/queue.js';
import type { BotMediaOverview } from '@ts6/common';

export const musicBotRoutes: Router = Router();

/**
 * TeamSpeak refuses a nickname outside 3-30 characters at connect (error 1541),
 * so a bot saved with one could never start. Returns the trimmed nickname.
 */
function validNickname(nickname: unknown): string | undefined {
  if (nickname == null) return undefined;
  const trimmed = String(nickname).trim();
  if (trimmed.length < 3 || trimmed.length > 30) {
    throw new AppError(400, 'Bot nickname must be 3-30 characters (TeamSpeak limit)');
  }
  return trimmed;
}

/**
 * Parse a 0–100 volume. 0 is a real level (mute), not a missing value. Only a
 * number or a whole numeric string counts: parseInt would read "20abc" as 20.
 */
function parseVolume(raw: unknown): number {
  const vol = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
  if (!Number.isFinite(vol)) throw new AppError(400, 'volume must be a number from 0 to 100');
  return Math.max(0, Math.min(100, Math.round(vol)));
}

/** Per-bot chain of volume writes, so they reach the database in request order. */
const volumeSaveTails = new Map<number, Promise<void>>();

/**
 * Save a bot volume after any earlier save for the same bot finishes. The
 * in-memory level is set in request order, but concurrent database writes can
 * complete in any order; queueing keeps the newest level as the last write.
 */
function saveBotVolume(prisma: any, id: number, volume: number): Promise<void> {
  const prev = volumeSaveTails.get(id) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* the earlier request reported its own failure */ })
    .then(() => prisma.musicBot.update({ where: { id }, data: { volume } }))
    .then(() => {});
  volumeSaveTails.set(id, next);
  const forget = () => { if (volumeSaveTails.get(id) === next) volumeSaveTails.delete(id); };
  next.then(forget, forget);
  return next;
}

/**
 * Apply a volume to a live bot and save it. The in-memory level changes before
 * a running stream restarts, so it is saved even when that restart fails;
 * otherwise the next bot start would come back at the old level.
 */
async function applyAndSaveVolume(prisma: any, bot: VoiceBot | undefined, id: number, vol: number): Promise<void> {
  try {
    if (bot) await bot.applyVolume(vol);
  } finally {
    // A newer request may have changed the level while this one waited on the
    // restart; saving now would put the older level back in the database.
    if (!bot || bot.currentConfig.volume === vol) {
      await saveBotVolume(prisma, id, vol);
    }
  }
}

/** Cancels stale background playlist expansions when a newer play-url starts for the same bot. */
const playlistExpandGeneration = new Map<number, number>();

function invalidatePlaylistExpansion(botId: number): void {
  playlistExpandGeneration.set(botId, (playlistExpandGeneration.get(botId) ?? 0) + 1);
}

// All routes require admin role
musicBotRoutes.use(requireRole('admin'));

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 0 } }).single('file');
// Avatar audits record saving the selected image/mode. A TS6 refusal does not
// undo that saved selection; applyAvatar exposes it separately as avatarError.
const avatarWrites = new Map<number, Promise<unknown>>();
async function serializeAvatar<T>(id: number, write: () => Promise<T>): Promise<T> {
  const next = (avatarWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(write);
  avatarWrites.set(id, next);
  try { return await next; } finally { if (avatarWrites.get(id) === next) avatarWrites.delete(id); }
}
async function avatarBot(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid bot ID');
  const bot = await req.app.locals.prisma.musicBot.findUnique({ where: { id } });
  if (!bot) throw new AppError(404, 'Music bot not found');
  return bot;
}

musicBotRoutes.get('/:id/avatar', async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const image = await readBotAvatar(await avatarBot(req));
    if (!image) throw new AppError(404, 'Bot has no avatar');
    res.type(avatarImageType(image).mime).send(image);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') next(new AppError(404, 'Bot avatar not found'));
    else next(error);
  }
});

musicBotRoutes.put('/:id/avatar', (req, res, next) => {
  avatarUpload(req, res, (error) => {
    if (error) return next(new AppError(400, error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'Avatar must be at most 200 KB' : 'Upload exactly one PNG, JPEG or GIF image'));
    next();
  });
}, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'Upload exactly one PNG, JPEG or GIF image');
    avatarImageType(req.file.buffer);
    const existing = await avatarBot(req);
    await serializeAvatar(existing.id, () => runRemoteAudited(req.app.locals.prisma, {
      actor: actorFromRequest(req.user), action: 'music_bot.avatar_update', connectionId: existing.serverConfigId,
      target: { type: 'music_bot', id: existing.id },
    }, async () => {
      const saved = await saveBotAvatar(existing.id, req.file!.buffer);
      const data = { ...saved, avatarMode: 'custom' as const };
      await req.app.locals.prisma.musicBot.update({ where: { id: existing.id, serverConfigId: existing.serverConfigId }, data });
      await req.app.locals.voiceBotManager.getBot(existing.id)?.applyAvatar(data);
    }));
    res.json({ success: true });
  } catch (error) { next(error); }
});

musicBotRoutes.put('/:id/avatar/mode', async (req, res, next) => {
  try {
    const mode = req.body.mode as BotAvatarMode;
    if (!['custom', 'default', 'none'].includes(mode)) throw new AppError(400, 'mode must be custom, default or none');
    const existing = await avatarBot(req);
    await serializeAvatar(existing.id, async () => {
      const current = await avatarBot(req);
      if (mode === 'custom' && !current.avatarFile) throw new AppError(400, 'Upload a custom avatar first');
      const image = await readBotAvatar({ ...current, avatarMode: mode });
      const data = { avatarMode: mode, avatarFile: current.avatarFile, avatarMd5: image ? createHash('md5').update(image).digest('hex') : null };
      await runRemoteAudited(req.app.locals.prisma, {
        actor: actorFromRequest(req.user), action: 'music_bot.avatar_update', connectionId: current.serverConfigId,
        target: { type: 'music_bot', id: current.id },
      }, async () => {
        await req.app.locals.prisma.musicBot.update({ where: { id: current.id, serverConfigId: current.serverConfigId }, data });
        await req.app.locals.voiceBotManager.getBot(current.id)?.applyAvatar(data);
      });
    });
    res.json({ success: true });
  } catch (error) { next(error); }
});

// GET / — List all music bots
musicBotRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const dbBots = await prisma.musicBot.findMany({
      include: { serverConfig: { select: { id: true, name: true, host: true } } },
      orderBy: { id: 'asc' },
    });

    const runtimeInfo = manager.listBots();
    const runtimeMap = new Map(runtimeInfo.map((b: any) => [b.id, b]));

    res.json(dbBots.map((b: any) => {
      const runtime = runtimeMap.get(b.id);
      return {
        id: b.id,
        name: b.name,
        serverConfigId: b.serverConfigId,
        serverConfig: b.serverConfig,
        nickname: b.nickname,
        defaultChannel: b.defaultChannel,
        commandChannelIds: parseCommandChannelIds(b.commandChannelIds),
        virtualServerId: b.virtualServerId,
        voicePort: b.voicePort,
        volume: b.volume,
        autoStart: b.autoStart,
        avatarMode: b.avatarMode ?? 'none',
        avatarMd5: b.avatarMd5 ?? null,
        avatarError: manager.getBot(b.id)?.avatarError ?? null,
        status: runtime?.status ?? 'stopped',
        nowPlaying: runtime?.nowPlaying ?? null,
        createdAt: b.createdAt,
      };
    }));
  } catch (err) { next(err); }
});

// GET /media — Bot hub overview: every bot's media session. Cheap enough to
// poll (in-memory state only; never calls the sidecar or TeamSpeak Query).
musicBotRoutes.get('/media', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const dbBots = await prisma.musicBot.findMany({
      select: { id: true, name: true, serverConfigId: true, avatarMode: true, avatarMd5: true, serverConfig: { select: { name: true } } },
      orderBy: { id: 'asc' },
    });
    const overview: BotMediaOverview[] = dbBots.map((b: any) => {
      const bot = manager.getBot(b.id);
      const base = {
        botName: b.name as string,
        avatarMode: b.avatarMode ?? 'none',
        avatarMd5: b.avatarMd5 ?? null,
        avatarError: bot?.avatarError ?? null,
        serverConfigId: b.serverConfigId as number,
        serverName: (b.serverConfig?.name as string | undefined) ?? null,
      };
      if (!bot) {
        return {
          ...base, botId: b.id, status: 'stopped', channelId: null, channelName: null, session: null,
          music: null, video: null, lastMusicStop: null, lastVideoStop: null,
        };
      }
      return { ...base, ...bot.mediaOverview() };
    });
    res.json(overview);
  } catch (err) { next(err); }
});

// GET /:id — Get bot details + runtime status
musicBotRoutes.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const dbBot = await prisma.musicBot.findUnique({
      where: { id },
      include: { serverConfig: { select: { id: true, name: true, host: true } } },
    });
    if (!dbBot) throw new AppError(404, 'Music bot not found');

    const bot = manager.getBot(id);
    res.json({
      ...dbBot,
      identityData: undefined, // don't expose identity
      status: bot?.status ?? 'stopped',
      nowPlaying: bot?.nowPlaying ?? null,
      playbackProgress: bot?.playbackProgress ?? null,
      avatarError: bot?.avatarError ?? null,
    });
  } catch (err) { next(err); }
});

// POST / — Create bot
musicBotRoutes.post('/', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const { name, serverConfigId, nickname, serverPassword, defaultChannel, channelPassword, commandChannelIds, virtualServerId, voicePort, volume, autoStart } = req.body;
    if (!name || !serverConfigId) throw new AppError(400, 'name and serverConfigId are required');
    const checkedNickname = validNickname(nickname);

    const parsedCommandChannels = Array.isArray(commandChannelIds)
      ? commandChannelIds.map(String)
      : typeof commandChannelIds === 'string'
        ? commandChannelIds.split(/[\s,]+/).filter(Boolean)
        : undefined;

    const result = await manager.createBot({
      name,
      serverConfigId: parseInt(serverConfigId),
      nickname: checkedNickname,
      serverPassword,
      defaultChannel,
      channelPassword,
      commandChannelIds: parsedCommandChannels,
      virtualServerId: virtualServerId != null ? parseInt(virtualServerId, 10) : undefined,
      voicePort: voicePort != null ? parseInt(voicePort) : undefined,
      volume: volume != null ? parseInt(volume) : undefined,
      autoStart: autoStart ?? false,
      avatarMode: 'default',
    });

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// PUT /:id — Update bot config
musicBotRoutes.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const { name, serverPassword, defaultChannel, channelPassword, commandChannelIds, virtualServerId, voicePort, volume, autoStart } = req.body;
    const nickname = validNickname(req.body.nickname);

    const commandChannelData =
      commandChannelIds !== undefined
        ? {
            commandChannelIds: serializeCommandChannelIds(
              Array.isArray(commandChannelIds)
                ? commandChannelIds.map(String)
                : String(commandChannelIds)
                    .split(/[\s,]+/)
                    .filter(Boolean),
            ),
          }
        : {};

    const dbBot = await prisma.musicBot.update({
      where: { id },
      data: {
        ...(name != null && { name }),
        ...(nickname != null && { nickname }),
        ...(serverPassword !== undefined && { serverPassword }),
        ...(defaultChannel !== undefined && { defaultChannel }),
        ...(channelPassword !== undefined && { channelPassword }),
        ...commandChannelData,
        ...(virtualServerId != null && { virtualServerId: parseInt(virtualServerId, 10) }),
        ...(voicePort != null && { voicePort: parseInt(voicePort) }),
        ...(volume != null && { volume: parseInt(volume) }),
        ...(autoStart != null && { autoStart }),
      },
    });

    await manager.refreshMusicCommandChannels(id);

    // Update runtime config if bot is loaded
    const bot = manager.getBot(id);
    if (bot) {
      bot.updateConfig({
        ...(name != null && { name }),
        ...(nickname != null && { nickname }),
        ...(serverPassword !== undefined && { serverPassword: serverPassword || undefined }),
        ...(defaultChannel !== undefined && { defaultChannel: defaultChannel || undefined }),
        ...(channelPassword !== undefined && { channelPassword: channelPassword || undefined }),
        ...(voicePort != null && { serverPort: parseInt(voicePort) }),
        ...(volume != null && { volume: parseInt(volume) }),
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /:id — Delete bot
musicBotRoutes.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    await manager.removeBot(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/start — Start bot
musicBotRoutes.post('/:id/start', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    await manager.startBot(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stop — Stop bot
musicBotRoutes.post('/:id/stop', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    invalidatePlaylistExpansion(id);
    await manager.stopBot(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/restart — Restart bot
musicBotRoutes.post('/:id/restart', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const bot = manager.getBot(id);
    if (!bot) throw new AppError(404, 'Music bot not found');
    await bot.restart();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// === Playback Control ===

// POST /:id/play — Play a song
musicBotRoutes.post('/:id/play', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const { songId } = req.body;
    if (!songId) throw new AppError(400, 'songId is required');

    const bot = manager.getBot(id);
    if (!bot) throw new AppError(404, 'Music bot not found');
    const replaceSessionIds = parseReplaceSessionIds(req.body);
    bot.assertMusicCanStart(replaceSessionIds);
    if (bot.status !== 'connected' && bot.status !== 'playing' && bot.status !== 'paused') {
      throw new AppError(400, 'Bot is not connected');
    }

    const song = await prisma.song.findUnique({ where: { id: parseInt(songId) } });
    if (!song) throw new AppError(404, 'Song not found');

    const queueItem = {
      id: String(song.id),
      title: song.title,
      artist: song.artist ?? undefined,
      duration: song.duration ?? undefined,
      filePath: song.filePath,
      source: song.source as 'local' | 'youtube' | 'url',
      sourceUrl: song.sourceUrl ?? undefined,
    };

    // Add to queue so repeat modes work, then play
    bot.queue.add(queueItem);
    bot.queue.playAt(bot.queue.length - 1);
    await runMediaAudited(req, bot, 'media.music.start', () => bot.play(queueItem, { replaceSessionIds }), replaceSessionIds);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/play-url — Play a YouTube/direct URL (single video or playlist).
// Body `{ enqueue: true }` appends without interrupting current playback (Requests tab Enqueue).
export function createPlayUrlHandler(deps: MediaUrlPipelineDeps = defaultMediaUrlDeps()): RequestHandler {
  return async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const { url } = req.body;
    const enqueueOnly = Boolean(req.body?.enqueue);
    if (!url) throw new AppError(400, 'url is required');

    const bot = manager.getBot(id);
    if (!bot) throw new AppError(404, 'Music bot not found');
    const replaceSessionIds = parseReplaceSessionIds(req.body);
    if (!enqueueOnly) bot.assertMusicCanStart(replaceSessionIds);
    if (bot.status !== 'connected' && bot.status !== 'playing' && bot.status !== 'paused') {
      throw new AppError(400, 'Bot is not connected');
    }

    const saveHistory = async (sourceUrl: string, title: string) => {
      try {
        const prisma = req.app.locals.prisma;
        if (!bot.currentConfig.serverConfigId) return;
        await prisma.musicRequest.upsert({
          where: {
            serverConfigId_url: {
              serverConfigId: bot.currentConfig.serverConfigId,
              url: sourceUrl,
            },
          },
          update: {
            requestedAt: new Date(),
            title: title || 'Unknown Title',
          },
          create: {
            serverConfigId: bot.currentConfig.serverConfigId,
            url: sourceUrl,
            title: title || 'Unknown Title',
            requestedAt: new Date(),
          },
        });
      } catch (saveErr) {
        console.error('[music-bots.routes] Failed to save music request history:', saveErr);
      }
    };

    const generation = (playlistExpandGeneration.get(id) ?? 0) + 1;
    playlistExpandGeneration.set(id, generation);

    let firstCall = true;
    let pipelineResult: Awaited<ReturnType<typeof runMediaUrlPipeline>>;
    try {
      pipelineResult = await runMediaUrlPipeline(
        deps,
        {
          play: async (item: QueueItem, opts) => {
            const isFirst = firstCall;
            firstCall = false;
            const live = manager.getBot(id);
            if (!live || playlistExpandGeneration.get(id) !== generation) return;
            live.queue.add(item);
            if (isFirst || !enqueueOnly) {
              live.queue.playAt(live.queue.length - 1);
              if (isFirst && opts.replaceSessionIds !== undefined) {
                await runMediaAudited(
                  req,
                  live,
                  'media.music.start',
                  () => live.play(item, { replaceSessionIds: opts.replaceSessionIds }),
                  opts.replaceSessionIds,
                );
              } else {
                await live.play(item).catch((err) => {
                  console.error('[music-bots.routes] Failed to resume playlist playback:', err);
                });
              }
            }
            if (item.sourceUrl) await saveHistory(item.sourceUrl, item.title);
          },
          enqueue: (item: QueueItem) => {
            if (playlistExpandGeneration.get(id) !== generation) return;
            const live = manager.getBot(id);
            if (!live || live.status === 'stopped' || live.status === 'error') return;
            live.queue.add(item);
            if (item.sourceUrl) void saveHistory(item.sourceUrl, item.title);
          },
          isIdle: () => {
            const live = manager.getBot(id);
            return Boolean(live && live.status === 'connected' && !live.nowPlaying);
          },
          isCancelled: () => playlistExpandGeneration.get(id) !== generation,
        },
        { url, enqueueOnly },
        {
          replaceSessionIds,
          onBackgroundError: (err, label) => {
            console.error('[music-bots.routes] Failed to queue %s:', label, err);
          },
        },
      );
    } catch (err: any) {
      if (err instanceof AppError || typeof err?.statusCode === 'number') throw err;
      const message = err?.message ?? String(err);
      const isResolutionError =
        message === 'Could not resolve any tracks from that Apple Music URL'
        || message.startsWith('No YouTube match for Apple Music track:')
        || message === 'Could not resolve any videos from that playlist URL'
        || message === 'Could not resolve that YouTube URL';
      throw new AppError(isResolutionError ? 502 : 500, isResolutionError ? message : `Failed to play URL: ${message}`);
    }

    res.json({
      success: true,
      queued: 1 + pipelineResult.queuedInBackground,
      playlist: pipelineResult.queuedInBackground > 0,
      playlistTitle: pipelineResult.playlistTitle,
      queueItem: { id: pipelineResult.first.id, title: pipelineResult.first.title },
    });
  } catch (err) { next(err); }
  };
}

musicBotRoutes.post('/:id/play-url', createPlayUrlHandler());

// POST /:id/play-radio — Play a radio station (streaming)
musicBotRoutes.post('/:id/play-radio', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const { stationId } = req.body;
    if (!stationId) throw new AppError(400, 'stationId is required');

    const bot = manager.getBot(id);
    if (!bot) throw new AppError(404, 'Music bot not found');
    const replaceSessionIds = parseReplaceSessionIds(req.body);
    bot.assertMusicCanStart(replaceSessionIds);
    if (bot.status !== 'connected' && bot.status !== 'playing' && bot.status !== 'paused') {
      throw new AppError(400, 'Bot is not connected');
    }

    const station = await prisma.radioStation.findUnique({ where: { id: parseInt(stationId) } });
    if (!station) throw new AppError(404, 'Radio station not found');

    const queueItem = {
      id: `radio_${station.id}`,
      title: station.name,
      artist: station.genre ?? 'Radio',
      filePath: '',
      source: 'radio' as const,
      streamUrl: station.url,
    };

    await runMediaAudited(req, bot, 'media.music.start', () => bot.playStream(queueItem, { replaceSessionIds }), replaceSessionIds);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/pause
musicBotRoutes.post('/:id/pause', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    bot.pause();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/resume
musicBotRoutes.post('/:id/resume', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    bot.resume();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stop-playback
musicBotRoutes.post('/:id/stop-playback', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const bot = manager.getBot(id);
    if (!bot) throw new AppError(404, 'Music bot not found');
    invalidatePlaylistExpansion(id);
    await runMediaAudited(req, bot, 'media.music.stop', async () => bot.stopAudio());
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/skip
musicBotRoutes.post('/:id/skip', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const replaceSessionIds = parseReplaceSessionIds(req.body);
    bot.assertMusicCanStart(replaceSessionIds);
    bot.skip({ replaceSessionIds });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/previous
musicBotRoutes.post('/:id/previous', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const replaceSessionIds = parseReplaceSessionIds(req.body);
    bot.assertMusicCanStart(replaceSessionIds);
    bot.previous({ replaceSessionIds });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/seek
musicBotRoutes.post('/:id/seek', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { seconds } = req.body;
    bot.seek(parseFloat(seconds) || 0);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/volume
musicBotRoutes.post('/:id/volume', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const vol = parseVolume(req.body?.volume);
    await applyAndSaveVolume(prisma, manager.getBot(id), id, vol);

    res.json({ success: true, volume: vol });
  } catch (err) { next(err); }
});

// GET /:id/state — Full playback state
musicBotRoutes.get('/:id/state', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');

    const progress = bot.playbackProgress;
    res.json({
      status: bot.status,
      nowPlaying: bot.nowPlaying,
      position: progress?.position ?? 0,
      duration: progress?.duration ?? 0,
      volume: bot.currentConfig.volume,
      queue: bot.queue.getAll(),
      currentIndex: bot.queue.index,
      shuffle: bot.queue.shuffle,
      repeat: bot.queue.repeat,
      isStreaming: bot.isStreaming,
      videoStream: bot.videoStreamStatus,
    });
  } catch (err) { next(err); }
});

// === Queue ===

// GET /:id/queue
musicBotRoutes.get('/:id/queue', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    res.json({
      items: bot.queue.getAll(),
      shuffle: bot.queue.shuffle,
      repeat: bot.queue.repeat,
    });
  } catch (err) { next(err); }
});

// POST /:id/queue — Enqueue a song
musicBotRoutes.post('/:id/queue', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');

    const { songId } = req.body;
    const song = await prisma.song.findUnique({ where: { id: parseInt(songId) } });
    if (!song) throw new AppError(404, 'Song not found');

    bot.queue.add({
      id: String(song.id),
      title: song.title,
      artist: song.artist ?? undefined,
      duration: song.duration ?? undefined,
      filePath: song.filePath,
      source: song.source as any,
      sourceUrl: song.sourceUrl ?? undefined,
    });

    res.json({ success: true, queueLength: bot.queue.length });
  } catch (err) { next(err); }
});

// POST /:id/queue/playlist — Load playlist into queue
musicBotRoutes.post('/:id/queue/playlist', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const replaceSessionIds = parseReplaceSessionIds(req.body);

    const { playlistId, clearFirst, autoplay } = req.body;
    const playlist = await prisma.playlist.findUnique({
      where: { id: parseInt(playlistId) },
      include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
    });
    if (!playlist) throw new AppError(404, 'Playlist not found');

    const items = playlist.songs.map((ps: any) => ({
      id: String(ps.song.id),
      title: ps.song.title,
      artist: ps.song.artist ?? undefined,
      duration: ps.song.duration ?? undefined,
      filePath: ps.song.filePath,
      source: ps.song.source as any,
      sourceUrl: ps.song.sourceUrl ?? undefined,
    }));

    const shouldAutoplay = autoplay ?? clearFirst;
    // Only require a session replace when this load will actually start playback.
    if (shouldAutoplay && items.length > 0) bot.assertMusicCanStart(replaceSessionIds);

    if (clearFirst) bot.queue.clear();
    bot.queue.addMany(items);

    let playError: string | undefined;
    if (shouldAutoplay && items.length > 0) {
      const playIndex = clearFirst ? 0 : bot.queue.length - items.length;
      const item = bot.queue.playAt(playIndex);
      if (item) {
        try {
          if (item.streamUrl) await runMediaAudited(req, bot, 'media.music.start', () => bot.playStream(item, { replaceSessionIds }), replaceSessionIds);
          else await runMediaAudited(req, bot, 'media.music.start', () => bot.play(item, { replaceSessionIds }), replaceSessionIds);
        } catch (err: any) {
          playError = err.message || String(err);
          console.error('[music-bots.routes] Autoplay after playlist load failed:', playError);
        }
      }
    }

    res.json({ success: true, queueLength: bot.queue.length, playError });
  } catch (err) { next(err); }
});

// DELETE /:id/queue/:index — Remove from queue
musicBotRoutes.delete('/:id/queue/:index', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');

    const items = bot.queue.getAll();
    const index = parseInt(req.params.index as string);
    if (index >= 0 && index < items.length) {
      bot.queue.remove(items[index].id);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /:id/queue — Clear queue and stop current playback
musicBotRoutes.delete('/:id/queue', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const bot = manager.getBot(id);
    if (!bot) throw new AppError(404, 'Music bot not found');
    invalidatePlaylistExpansion(id);
    bot.queue.clear();
    bot.clearPlayback();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/queue/shuffle
musicBotRoutes.post('/:id/queue/shuffle', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    bot.queue.setShuffle(req.body.enabled ?? true);
    res.json({ success: true, shuffle: bot.queue.shuffle });
  } catch (err) { next(err); }
});

// POST /:id/queue/repeat
musicBotRoutes.post('/:id/queue/repeat', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const mode = req.body.mode ?? 'off';
    if (!['off', 'track', 'queue'].includes(mode)) throw new AppError(400, 'Invalid repeat mode');
    bot.queue.setRepeat(mode);
    res.json({ success: true, repeat: bot.queue.repeat });
  } catch (err) { next(err); }
});

// POST /:id/queue/:index/play — Play track at queue index
musicBotRoutes.post('/:id/queue/:index/play', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const replaceSessionIds = parseReplaceSessionIds(req.body);
    bot.assertMusicCanStart(replaceSessionIds);

    const index = parseInt(req.params.index as string);
    const item = bot.queue.playAt(index);
    if (!item) throw new AppError(400, 'Invalid queue index');

    if (item.streamUrl) {
      await runMediaAudited(req, bot, 'media.music.start', () => bot.playStream(item, { replaceSessionIds }), replaceSessionIds);
    } else {
      await runMediaAudited(req, bot, 'media.music.start', () => bot.play(item, { replaceSessionIds }), replaceSessionIds);
    }
    res.json({ success: true, nowPlaying: { title: item.title, artist: item.artist } });
  } catch (err) { next(err); }
});

// PUT /:id/queue/move — Move queue item from one position to another
musicBotRoutes.put('/:id/queue/move', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');

    const { from, to } = req.body;
    if (typeof from !== 'number' || typeof to !== 'number') throw new AppError(400, 'from and to are required');
    const moved = bot.queue.move(from, to);
    if (!moved) throw new AppError(400, 'Invalid indices');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// === Video Streaming ===

/** Allow http(s) URLs or a bare MUSIC_DIR filename (no path separators). */
function assertVideoSource(source: unknown): string {
  if (typeof source !== 'string' || !source.trim()) {
    throw new AppError(400, 'source is required');
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
    } catch {
      throw new AppError(400, 'Invalid video source URL');
    }
    return trimmed;
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..') || trimmed.includes('\0')) {
    throw new AppError(400, 'Local video source must be a filename under the music directory');
  }
  return trimmed;
}

// POST /:id/stream/start — Start video stream
musicBotRoutes.post('/:id/stream/start', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const safeSource = assertVideoSource(req.body?.source);
    const parsed = parseStreamStartOptions(req.body);
    if (!parsed.ok) throw new AppError(400, parsed.error);
    // Conflicts answer 409 before an audit row exists; only real starts are audited.
    manager.assertVideoCanStart(bot, parsed.options.replaceSessionIds);
    await runMediaAudited(
      req, bot, 'media.video.start',
      () => manager.startVideoStream(bot, safeSource, parsed.options),
      parsed.options.replaceSessionIds,
    );
    if (parsed.options.volume != null) {
      const prisma = req.app.locals.prisma;
      await saveBotVolume(prisma, bot.currentConfig.id, bot.currentConfig.volume);
    }
    res.json({ success: true, status: bot.videoStreamStatus });
  } catch (err) { next(err); }
});

// POST /:id/stream/stop — Stop video stream
musicBotRoutes.post('/:id/stream/stop', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    await runMediaAudited(req, bot, 'media.video.stop', () => bot.stopVideoStream('manual', 'Stopped from the web UI'));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stream/source — Change video source
musicBotRoutes.post('/:id/stream/source', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { source } = req.body;
    const volume = req.body?.volume != null ? parseVolume(req.body.volume) : undefined;
    const safeSource = assertVideoSource(source);
    const parsed = parseStreamStartOptions({ sourceMode: req.body?.sourceMode });
    if (!parsed.ok) throw new AppError(400, parsed.error);
    try {
      await runMediaAudited(req, bot, 'media.video.source_change', () => bot.setVideoSource(safeSource, volume, parsed.options.sourceMode));
    } finally {
      // Same rule as /stream/volume: once the bot took the level, save it.
      if (volume != null && bot.currentConfig.volume === volume) {
        const prisma = req.app.locals.prisma;
        await saveBotVolume(prisma, bot.currentConfig.id, volume);
      }
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stream/volume — Adjust video stream volume
musicBotRoutes.post('/:id/stream/volume', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { volume } = req.body;
    if (volume == null) throw new AppError(400, 'volume is required');
    const vol = parseVolume(volume);
    const prisma = req.app.locals.prisma;
    try {
      await bot.setVideoStreamVolume(vol);
    } finally {
      // setVideoStreamVolume refuses before changing anything when no stream
      // runs; once it has changed the level, save it even if the restart fails.
      if (bot.currentConfig.volume === vol) {
        await saveBotVolume(prisma, bot.currentConfig.id, vol);
      }
    }
    res.json({ success: true, volume: vol });
  } catch (err) { next(err); }
});

// GET /:id/stream/status — Get video stream status
musicBotRoutes.get('/:id/stream/status', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    res.json(bot.videoStreamStatus);
  } catch (err) { next(err); }
});

// DELETE /:id/stream/viewer/:clid — Kick a viewer
musicBotRoutes.delete('/:id/stream/viewer/:clid', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    await bot.kickVideoViewer(parseInt(req.params.clid as string));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stream/webrtc/offer — Get WebRTC offer for preview player
musicBotRoutes.post('/:id/stream/webrtc/offer', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const offer = await bot.getWebRtcOffer();
    if (!offer) throw new AppError(400, 'No active video stream');
    res.json(offer);
  } catch (err) { next(err); }
});

// POST /:id/stream/webrtc/answer — Set WebRTC answer from preview player
musicBotRoutes.post('/:id/stream/webrtc/answer', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { sdp } = req.body;
    if (!sdp) throw new AppError(400, 'sdp is required');
    await bot.setWebRtcAnswer(sdp);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stream/webrtc/ice — Add ICE candidate from preview player
musicBotRoutes.post('/:id/stream/webrtc/ice', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { candidate, sdpMid, sdpMLineIndex } = req.body;
    await bot.addWebRtcIceCandidate(candidate, sdpMid, sdpMLineIndex ?? 0);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /:id/player-widget-token — Get the public player widget token for this bot
musicBotRoutes.get('/:id/player-widget-token', async (req: Request, res: Response, next) => {
  try {
    const id = parseInt(req.params.id as string);
    const token = playerWidgetToken(id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      token,
      jsonUrl: `${baseUrl}/api/widget/player/${id}/data?token=${token}`,
      bbcodeUrl: `${baseUrl}/api/widget/player/${id}/bbcode?token=${token}`,
    });
  } catch (err) { next(err); }
});
