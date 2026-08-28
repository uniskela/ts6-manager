import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import { downloadYouTube, resolveSpotifyToYouTube, expandYouTubeToWatchUrls, isYouTubeHostUrl, parseYouTubeUrl } from '../voice/audio/youtube.js';
import {
  appleMusicTrackToYouTubeUrl,
  isAppleMusicShareUrl,
  resolveAppleMusicTracks,
  type AppleMusicTrack,
} from '../voice/audio/apple-music.js';
import { serializeCommandChannelIds, parseCommandChannelIds } from '../voice/music-command-channels.js';

export const musicBotRoutes: Router = Router();

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

/** Cancels stale background playlist expansions when a newer play-url starts for the same bot. */
const playlistExpandGeneration = new Map<number, number>();

function invalidatePlaylistExpansion(botId: number): void {
  playlistExpandGeneration.set(botId, (playlistExpandGeneration.get(botId) ?? 0) + 1);
}

// All routes require admin role
musicBotRoutes.use(requireRole('admin'));

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
        status: runtime?.status ?? 'stopped',
        nowPlaying: runtime?.nowPlaying ?? null,
        createdAt: b.createdAt,
      };
    }));
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
    });
  } catch (err) { next(err); }
});

// POST / — Create bot
musicBotRoutes.post('/', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const { name, serverConfigId, nickname, serverPassword, defaultChannel, channelPassword, commandChannelIds, virtualServerId, voicePort, volume, autoStart } = req.body;
    if (!name || !serverConfigId) throw new AppError(400, 'name and serverConfigId are required');

    const parsedCommandChannels = Array.isArray(commandChannelIds)
      ? commandChannelIds.map(String)
      : typeof commandChannelIds === 'string'
        ? commandChannelIds.split(/[\s,]+/).filter(Boolean)
        : undefined;

    const result = await manager.createBot({
      name,
      serverConfigId: parseInt(serverConfigId),
      nickname,
      serverPassword,
      defaultChannel,
      channelPassword,
      commandChannelIds: parsedCommandChannels,
      virtualServerId: virtualServerId != null ? parseInt(virtualServerId, 10) : undefined,
      voicePort: voicePort != null ? parseInt(voicePort) : undefined,
      volume: volume != null ? parseInt(volume) : undefined,
      autoStart: autoStart ?? false,
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
    const { name, nickname, serverPassword, defaultChannel, channelPassword, commandChannelIds, virtualServerId, voicePort, volume, autoStart } = req.body;

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
    await bot.play(queueItem);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/play-url — Play a YouTube/direct URL (single video or playlist)
musicBotRoutes.post('/:id/play-url', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const { url } = req.body;
    if (!url) throw new AppError(400, 'url is required');

    const bot = manager.getBot(id);
    if (!bot) throw new AppError(404, 'Music bot not found');
    if (bot.status !== 'connected' && bot.status !== 'playing' && bot.status !== 'paused') {
      throw new AppError(400, 'Bot is not connected');
    }

    let mediaUrl = url;
    if ((() => {
      try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'open.spotify.com' || host === 'spotify.com' || host.endsWith('.spotify.com') || host === 'spotify.link';
      } catch { return false; }
    })()) {
      mediaUrl = await resolveSpotifyToYouTube(mediaUrl);
    }

    // Expand YouTube / YouTube Music playlists (cap downloads).
    // Canonicalizes music.youtube.com → www.youtube.com before yt-dlp.
    const PLAYLIST_CAP = 25;
    let urlsToPlay: string[] = [mediaUrl];
    let playlistTitle: string | undefined;
    /** Apple Music tracks still needing YouTube search (after the first). */
    let appleMusicPending: AppleMusicTrack[] = [];

    if (isAppleMusicShareUrl(mediaUrl)) {
      const am = await resolveAppleMusicTracks(mediaUrl);
      if (!am.tracks.length) {
        throw new AppError(502, 'Could not resolve any tracks from that Apple Music URL');
      }
      playlistTitle = am.title;
      const firstYt = await appleMusicTrackToYouTubeUrl(am.tracks[0]);
      if (!firstYt) {
        throw new AppError(502, `No YouTube match for Apple Music track: ${am.tracks[0].artist} - ${am.tracks[0].title}`);
      }
      urlsToPlay = [firstYt];
      appleMusicPending = am.tracks.slice(1, PLAYLIST_CAP);
    } else if (isYouTubeHostUrl(mediaUrl)) {
      const parsed = parseYouTubeUrl(mediaUrl);
      try {
        const expanded = await expandYouTubeToWatchUrls(mediaUrl, PLAYLIST_CAP);
        if (expanded.urls.length > 0) {
          urlsToPlay = expanded.urls;
          playlistTitle = expanded.title;
        } else if (parsed.watchUrl) {
          urlsToPlay = [parsed.watchUrl];
        } else if (parsed.listId && !parsed.videoId) {
          throw new AppError(502, 'Could not resolve any videos from that playlist URL');
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        // Single-video Music/watch URLs can still download via canonical watch URL.
        if (parsed.watchUrl) {
          urlsToPlay = [parsed.watchUrl];
        } else if (parsed.canonicalUrl && isYouTubeHostUrl(parsed.canonicalUrl) && parsed.videoId) {
          urlsToPlay = [`https://www.youtube.com/watch?v=${parsed.videoId}`];
        } else {
          throw new AppError(502, `Failed to resolve YouTube URL: ${(err as Error).message || err}`);
        }
      }
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

    // Download + play the first track immediately so the request doesn't time out on playlists.
    const generation = (playlistExpandGeneration.get(id) ?? 0) + 1;
    playlistExpandGeneration.set(id, generation);

    const firstUrl = urlsToPlay[0];
    const { filePath, info } = await downloadYouTube(firstUrl, MUSIC_DIR);
    const firstItem = {
      id: `yt_${info.id}`,
      title: info.title,
      artist: info.artist,
      duration: info.duration,
      filePath,
      source: 'youtube' as const,
      sourceUrl: firstUrl,
    };
    bot.queue.add(firstItem);
    bot.queue.playAt(bot.queue.length - 1);
    await bot.play(firstItem);
    await saveHistory(firstUrl, firstItem.title);

    // Queue remaining playlist tracks in the background.
    // If the first track ends before later downloads finish, resume when the next item lands.
    // Apple Music: resolve each remaining track via YouTube search, then download.
    const rest = urlsToPlay.slice(1);
    const pendingTotal = rest.length + appleMusicPending.length;
    if (pendingTotal > 0) {
      void (async () => {
        const enqueueYt = async (itemUrl: string) => {
          if (playlistExpandGeneration.get(id) !== generation) return false;
          const live = manager.getBot(id);
          if (!live || live.status === 'stopped' || live.status === 'error') return false;
          const dl = await downloadYouTube(itemUrl, MUSIC_DIR);
          if (playlistExpandGeneration.get(id) !== generation) return false;
          const stillLive = manager.getBot(id);
          if (!stillLive || stillLive.status === 'stopped' || stillLive.status === 'error') return false;

          const queueItem = {
            id: `yt_${dl.info.id}`,
            title: dl.info.title,
            artist: dl.info.artist,
            duration: dl.info.duration,
            filePath: dl.filePath,
            source: 'youtube' as const,
            sourceUrl: itemUrl,
          };
          stillLive.queue.add(queueItem);
          await saveHistory(itemUrl, queueItem.title);

          // First track may have finished while we were downloading — resume from this item.
          if (stillLive.status === 'connected' && !stillLive.nowPlaying) {
            stillLive.queue.playAt(stillLive.queue.length - 1);
            await stillLive.play(queueItem).catch((err) => {
              console.error('[music-bots.routes] Failed to resume playlist playback:', err);
            });
          }
          return true;
        };

        for (const itemUrl of rest) {
          try {
            const ok = await enqueueYt(itemUrl);
            if (!ok) break;
          } catch (err) {
            console.error('[music-bots.routes] Failed to queue playlist track %s:', itemUrl, err);
          }
        }

        for (const track of appleMusicPending) {
          if (playlistExpandGeneration.get(id) !== generation) break;
          try {
            const ytUrl = await appleMusicTrackToYouTubeUrl(track);
            if (!ytUrl) {
              console.error(
                '[music-bots.routes] No YouTube match for Apple Music track: %s - %s',
                track.artist,
                track.title,
              );
              continue;
            }
            const ok = await enqueueYt(ytUrl);
            if (!ok) break;
          } catch (err) {
            console.error(
              '[music-bots.routes] Failed to queue Apple Music track %s - %s:',
              track.artist,
              track.title,
              err,
            );
          }
        }
      })();
    }

    res.json({
      success: true,
      queued: 1 + pendingTotal,
      playlist: pendingTotal > 0,
      playlistTitle,
      queueItem: { id: firstItem.id, title: firstItem.title },
    });
  } catch (err: any) {
    next(new AppError(500, `Failed to play URL: ${err.message}`));
  }
});

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

    await bot.playStream(queueItem);
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
    bot.stopAudio();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/skip
musicBotRoutes.post('/:id/skip', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    bot.skip();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/previous
musicBotRoutes.post('/:id/previous', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    bot.previous();
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
    const { volume } = req.body;
    const vol = Math.max(0, Math.min(100, parseInt(volume) || 50));

    const bot = manager.getBot(id);
    if (bot) bot.setVolume(vol);
    await prisma.musicBot.update({ where: { id }, data: { volume: vol } });

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

    const { playlistId, clearFirst } = req.body;
    const playlist = await prisma.playlist.findUnique({
      where: { id: parseInt(playlistId) },
      include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
    });
    if (!playlist) throw new AppError(404, 'Playlist not found');

    if (clearFirst) bot.queue.clear();

    const items = playlist.songs.map((ps: any) => ({
      id: String(ps.song.id),
      title: ps.song.title,
      artist: ps.song.artist ?? undefined,
      duration: ps.song.duration ?? undefined,
      filePath: ps.song.filePath,
      source: ps.song.source as any,
      sourceUrl: ps.song.sourceUrl ?? undefined,
    }));

    bot.queue.addMany(items);
    res.json({ success: true, queueLength: bot.queue.length });
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

    const index = parseInt(req.params.index as string);
    const item = bot.queue.playAt(index);
    if (!item) throw new AppError(400, 'Invalid queue index');

    if (item.streamUrl) {
      await bot.playStream(item);
    } else {
      await bot.play(item);
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
    const { source, preset, framerate, bitrate, volume } = req.body;
    const safeSource = assertVideoSource(source);
    await bot.startVideoStream(safeSource, preset, framerate, bitrate, volume);
    res.json({ success: true, status: bot.videoStreamStatus });
  } catch (err) { next(err); }
});

// POST /:id/stream/stop — Stop video stream
musicBotRoutes.post('/:id/stream/stop', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    await bot.stopVideoStream();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stream/source — Change video source
musicBotRoutes.post('/:id/stream/source', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { source, volume } = req.body;
    const safeSource = assertVideoSource(source);
    await bot.setVideoSource(safeSource, volume);
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
    await bot.setVideoStreamVolume(parseInt(volume));
    res.json({ success: true });
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
