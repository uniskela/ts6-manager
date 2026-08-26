import type { PrismaClient } from '../../generated/prisma/index.js';
import { VoiceBotManager } from './voice-bot-manager.js';
import type { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import {
  downloadYouTube,
  resolveSpotifyToYouTube,
  expandYouTubeToWatchUrls,
  isYouTubeHostUrl,
  parseYouTubeUrl,
} from './audio/youtube.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';
const CMD_PREFIX = '!';
const PLAYLIST_CAP = 25;

/** Cancels stale background playlist expansions for chat !play / !queue. */
const chatPlaylistGeneration = new Map<number, number>();

function invalidateChatPlaylistExpansion(botId: number): void {
  chatPlaylistGeneration.set(botId, (chatPlaylistGeneration.get(botId) ?? 0) + 1);
}

const MUSIC_COMMANDS = new Set([
  'radio', 'play', 'stop', 'pause', 'skip', 'next', 'prev',
  'vol', 'volume', 'np', 'nowplaying', 'queue', 'add',
  'stream', 'stopstream', 'viewers',
]);

function isSpotifyShareUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'open.spotify.com' ||
      host === 'spotify.com' ||
      host.endsWith('.spotify.com') ||
      host === 'spotify.link'
    );
  } catch {
    return false;
  }
}
/**
 * Handles text-based music commands (!radio, !play, !stop, etc.)
 * by listening directly on each VoiceBot's TS3 connection.
 *
 * The bot receives `notifytextmessage` in its own channel —
 * no SSH EventBridge needed.
 */
export class MusicCommandHandler {
  private registeredBots = new Set<number>();

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
  ) {}

  /**
   * Register text message listener on a VoiceBot instance.
   * Called by VoiceBotManager whenever a bot is created/started.
   */
  registerBot(botId: number, bot: VoiceBot): void {
    if (this.registeredBots.has(botId)) return;
    this.registeredBots.add(botId);

    bot.on('textMessage', (data: Record<string, string>) => {
      this.onTextMessage(botId, bot, data).catch(err => {
        console.error(`[MusicCmd] Error processing text message on bot ${botId}: ${err.message}`);
      });
    });

    console.log(`[MusicCmd] Registered text command listener on bot ${botId}`);
  }

  unregisterBot(botId: number): void {
    this.registeredBots.delete(botId);
  }

  private async onTextMessage(botId: number, bot: VoiceBot, data: Record<string, string>): Promise<void> {
    const msg = (data.msg || '').trim();
    if (!msg.startsWith(CMD_PREFIX)) return;

    const parts = msg.substring(CMD_PREFIX.length).split(/\s+/);
    const command = parts[0].toLowerCase();
    if (!MUSIC_COMMANDS.has(command)) return;

    const rawArgs = parts.slice(1).join(' ').trim();
    const userClid = parseInt(data.invokerid || '0');
    if (!userClid) return;

    // TS clients auto-wrap URLs in BBCode: [URL]https://...[/URL]
    const args = rawArgs
      .replace(/\[URL(?:=[^\]]*)?\](.*?)\[\/URL\]/gi, '$1')
      .trim();

    // Ignore messages from ourselves (the bot)
    if (userClid === bot.ts3ClientId) return;

    console.log(`[MusicCmd] Bot ${botId}: !${command} ${args} (from clid=${userClid})`);

    try {
      switch (command) {
        case 'radio':
          await this.handleRadio(botId, bot, userClid, args);
          break;
        case 'play':
          await this.handlePlay(bot, userClid, args);
          break;
        case 'stop':
          this.handleStop(bot, userClid);
          break;
        case 'pause':
          this.handlePause(bot, userClid);
          break;
        case 'skip':
        case 'next':
          await this.handleSkip(bot, userClid);
          break;
        case 'prev':
          await this.handlePrev(bot, userClid);
          break;
        case 'vol':
        case 'volume':
          this.handleVolume(bot, userClid, args);
          break;
        case 'np':
        case 'nowplaying':
          this.handleNowPlaying(bot, userClid);
          break;
        case 'queue':
        case 'add':
          await this.handleQueue(bot, userClid, args);
          break;
        case 'stream':
          await this.handleStream(bot, userClid, args);
          break;
        case 'stopstream':
          await this.handleStopStream(bot, userClid);
          break;
        case 'viewers':
          this.handleViewers(bot, userClid);
          break;
      }
    } catch (err: any) {
      console.error(`[MusicCmd] Error handling !${command}: ${err.message}`);
      this.reply(bot, userClid, `Error: ${err.message}`);
    }
  }

  private reply(bot: VoiceBot, targetClid: number, msg: string): void {
    try {
      bot.sendTextMessage(targetClid, msg);
    } catch (err: any) {
      console.error(`[MusicCmd] Failed to send reply: ${err.message}`);
    }
  }

  // ─── Command Handlers ───────────────────────────────────────

  private async handleRadio(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void> {
    // Get serverConfigId for this bot from DB
    const dbBot = await this.prisma.musicBot.findUnique({ where: { id: botId }, select: { serverConfigId: true } });
    if (!dbBot) {
      this.reply(bot, userClid, 'Bot config not found.');
      return;
    }

    const stations = await this.prisma.radioStation.findMany({
      where: { serverConfigId: dbBot.serverConfigId },
      orderBy: { name: 'asc' },
    });

    if (stations.length === 0) {
      this.reply(bot, userClid, 'No radio stations configured.');
      return;
    }

    // No argument — list stations
    if (!args) {
      const lines = stations.map((s: any) => `[${s.id}] ${s.name}${s.genre ? ` (${s.genre})` : ''}`);
      this.reply(bot, userClid, 'Radio Stations:\n' + lines.join('\n'));
      return;
    }

    // Argument — play station by ID
    const stationId = parseInt(args);
    if (isNaN(stationId)) {
      this.reply(bot, userClid, 'Usage: !radio <id> — Use !radio to list stations.');
      return;
    }

    const station = stations.find((s: any) => s.id === stationId);
    if (!station) {
      this.reply(bot, userClid, `Station #${stationId} not found. Use !radio to list stations.`);
      return;
    }

    const queueItem: QueueItem = {
      id: `radio_${station.id}`,
      title: station.name,
      artist: station.genre ?? 'Radio',
      filePath: '',
      source: 'radio',
      streamUrl: station.url,
    };

    await bot.playStream(queueItem);
    this.reply(bot, userClid, `Now playing: ${station.name}`);
  }

  private async handlePlay(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    if (!args) {
      if (bot.status === 'paused') {
        bot.resume();
        this.reply(bot, userClid, 'Resumed.');
        return;
      }
      this.reply(bot, userClid, 'Usage: !play <youtube-url|spotify-url>');
      return;
    }

    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      this.reply(bot, userClid, 'Please provide a valid URL. Usage: !play <url>');
      return;
    }

    this.reply(bot, userClid, 'Loading...');

    try {
      await this.enqueueMediaUrl(bot, userClid, args);
    } catch (err: any) {
      this.reply(bot, userClid, `Failed to play: ${err.message}`);
    }
  }

  /**
   * Resolve Spotify / YouTube Music / playlist URLs, download the first track,
   * and queue the rest in the background (same approach as play-url).
   */
  private async enqueueMediaUrl(
    bot: VoiceBot,
    userClid: number,
    rawUrl: string,
  ): Promise<void> {
    let mediaUrl = rawUrl;
    if (isSpotifyShareUrl(mediaUrl)) {
      mediaUrl = await resolveSpotifyToYouTube(mediaUrl);
    }

    let urlsToPlay = [mediaUrl];
    let playlistTitle: string | undefined;
    if (isYouTubeHostUrl(mediaUrl)) {
      const parsed = parseYouTubeUrl(mediaUrl);
      try {
        const expanded = await expandYouTubeToWatchUrls(mediaUrl, PLAYLIST_CAP);
        if (expanded.urls.length > 0) {
          urlsToPlay = expanded.urls;
          playlistTitle = expanded.title;
        } else if (parsed.watchUrl) {
          urlsToPlay = [parsed.watchUrl];
        } else if (parsed.listId && !parsed.videoId) {
          throw new Error('Could not resolve any videos from that playlist URL');
        }
      } catch (err) {
        // Single-video URLs can still download via canonical watch URL.
        if (parsed.watchUrl) {
          urlsToPlay = [parsed.watchUrl];
        } else {
          throw err;
        }
      }
    }

    const firstUrl = urlsToPlay[0];
    const { filePath, info } = await downloadYouTube(firstUrl, MUSIC_DIR);

    const firstItem: QueueItem = {
      id: `yt_${info.id}`,
      title: info.title,
      artist: info.artist,
      duration: info.duration,
      filePath,
      source: 'youtube',
      sourceUrl: firstUrl,
    };

    bot.queue.add(firstItem);
    this.saveMusicRequest(bot, firstItem);

    const alreadyPlaying = bot.status === 'playing' || bot.status === 'paused';
    if (!alreadyPlaying) {
      bot.queue.playAt(bot.queue.length - 1);
      await bot.play(firstItem);
    }

    const rest = urlsToPlay.slice(1);
    const playlistNote =
      rest.length > 0
        ? ` (+${rest.length} more from${playlistTitle ? ` "${playlistTitle}"` : ' playlist'})`
        : '';

    if (alreadyPlaying) {
      this.reply(
        bot,
        userClid,
        `Queued: ${info.artist} - ${info.title} (position #${bot.queue.length})${playlistNote}`,
      );
    } else {
      this.reply(bot, userClid, `Now playing: ${info.artist} - ${info.title}${playlistNote}`);
    }

    if (rest.length === 0) return;

    const botId = bot.currentConfig.id;
    const generation = (chatPlaylistGeneration.get(botId) ?? 0) + 1;
    chatPlaylistGeneration.set(botId, generation);

    void (async () => {
      for (const itemUrl of rest) {
        if (chatPlaylistGeneration.get(botId) !== generation) break;
        try {
          const live = this.voiceBotManager.getBot(botId);
          if (!live || live.status === 'stopped' || live.status === 'error') break;
          const dl = await downloadYouTube(itemUrl, MUSIC_DIR);
          if (chatPlaylistGeneration.get(botId) !== generation) break;
          const stillLive = this.voiceBotManager.getBot(botId);
          if (!stillLive || stillLive.status === 'stopped' || stillLive.status === 'error') break;

          const queueItem: QueueItem = {
            id: `yt_${dl.info.id}`,
            title: dl.info.title,
            artist: dl.info.artist,
            duration: dl.info.duration,
            filePath: dl.filePath,
            source: 'youtube',
            sourceUrl: itemUrl,
          };
          stillLive.queue.add(queueItem);
          this.saveMusicRequest(stillLive, queueItem);

          if (stillLive.status === 'connected' && !stillLive.nowPlaying) {
            stillLive.queue.playAt(stillLive.queue.length - 1);
            await stillLive.play(queueItem).catch((err) => {
              console.error('[MusicCmd] Failed to resume playlist playback:', err);
            });
          }
        } catch (err) {
          console.error(`[MusicCmd] Failed to queue playlist track ${itemUrl}:`, err);
        }
      }
    })();
  }

  private showQueue(bot: VoiceBot, userClid: number): void {
    const items = bot.queue.getAll();
    if (items.length === 0) {
      this.reply(bot, userClid, 'Queue is empty.');
      return;
    }

    const currentIdx = bot.queue.index;
    const lines = items.slice(0, 15).map((item, i) => {
      const marker = i === currentIdx ? '▶ ' : '  ';
      const artist = item.artist ? `${item.artist} - ` : '';
      const dur = item.duration ? ` [${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}]` : '';
      return `${marker}${i + 1}. ${artist}${item.title}${dur}`;
    });
    if (items.length > 15) lines.push(`  ... and ${items.length - 15} more`);
    this.reply(bot, userClid, `Queue (${items.length} tracks):\n${lines.join('\n')}`);
  }

  private async handleQueue(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    // No args or "show" — display current queue
    if (!args || args.toLowerCase() === 'show') {
      this.showQueue(bot, userClid);
      return;
    }

    // !queue remove <index>
    if (args.toLowerCase().startsWith('remove ')) {
      const idx = parseInt(args.substring(7).trim()) - 1; // 1-based to 0-based
      const items = bot.queue.getAll();
      if (isNaN(idx) || idx < 0 || idx >= items.length) {
        this.reply(bot, userClid, `Invalid index. Queue has ${items.length} tracks.`);
        return;
      }
      const removed = items[idx];
      bot.queue.remove(removed.id);
      this.reply(bot, userClid, `Removed #${idx + 1}: ${removed.title}`);
      return;
    }

    // !queue play <index>
    if (args.toLowerCase().startsWith('play ')) {
      const idx = parseInt(args.substring(5).trim()) - 1; // 1-based to 0-based
      const item = bot.queue.playAt(idx);
      if (!item) {
        this.reply(bot, userClid, `Invalid index. Queue has ${bot.queue.length} tracks.`);
        return;
      }
      if (item.streamUrl) {
        await bot.playStream(item);
      } else {
        await bot.play(item);
      }
      this.reply(bot, userClid, `Playing #${idx + 1}: ${item.title}`);
      return;
    }

    // !queue clear
    if (args.toLowerCase() === 'clear') {
      invalidateChatPlaylistExpansion(bot.currentConfig.id);
      bot.queue.clear();
      bot.clearPlayback();
      this.reply(bot, userClid, 'Queue cleared.');
      return;
    }

    // URL provided — add to queue without interrupting
    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      this.reply(bot, userClid, 'Usage: !queue [show|play <n>|remove <n>|clear|<url>]');
      return;
    }

    this.reply(bot, userClid, 'Loading...');

    try {
      await this.enqueueMediaUrl(bot, userClid, args);
    } catch (err: any) {
      this.reply(bot, userClid, `Failed to queue: ${err.message}`);
    }
  }

  private handleStop(bot: VoiceBot, userClid: number): void {
    invalidateChatPlaylistExpansion(bot.currentConfig.id);
    bot.stopAudio();
    this.reply(bot, userClid, 'Playback stopped.');
  }

  private handlePause(bot: VoiceBot, userClid: number): void {
    if (bot.status === 'paused') {
      bot.resume();
      this.reply(bot, userClid, 'Resumed.');
    } else if (bot.status === 'playing') {
      bot.pause();
      this.reply(bot, userClid, 'Paused.');
    } else {
      this.reply(bot, userClid, 'Nothing is playing.');
    }
  }

  private async handleSkip(bot: VoiceBot, userClid: number): Promise<void> {
    const next = bot.queue.next();
    if (next) {
      if (next.streamUrl) {
        await bot.playStream(next);
      } else {
        await bot.play(next);
      }
      this.reply(bot, userClid, `Skipped to: ${next.title}`);
    } else {
      bot.stopAudio();
      this.reply(bot, userClid, 'Queue empty — playback stopped.');
    }
  }

  private async handlePrev(bot: VoiceBot, userClid: number): Promise<void> {
    const prev = bot.queue.previous();
    if (prev) {
      if (prev.streamUrl) {
        await bot.playStream(prev);
      } else {
        await bot.play(prev);
      }
      this.reply(bot, userClid, `Previous: ${prev.title}`);
    } else {
      this.reply(bot, userClid, 'No previous track.');
    }
  }

  private handleVolume(bot: VoiceBot, userClid: number, args: string): void {
    if (!args) {
      const vol = bot.currentConfig.volume;
      this.reply(bot, userClid, `Volume: ${vol}%`);
      return;
    }

    const vol = parseInt(args);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      this.reply(bot, userClid, 'Usage: !vol <0-100>');
      return;
    }

    bot.setVolume(vol);
    this.reply(bot, userClid, `Volume set to ${vol}%.`);
  }

  private handleNowPlaying(bot: VoiceBot, userClid: number): void {
    const np = bot.nowPlaying;
    if (!np) {
      this.reply(bot, userClid, 'Nothing is playing.');
      return;
    }

    const artist = np.artist ? `${np.artist} - ` : '';
    this.reply(bot, userClid, `Now playing: ${artist}${np.title}`);
  }

  // ─── Video Streaming Commands ─────────────────────────────

  private async handleStream(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    if (!args) {
      this.reply(bot, userClid, 'Usage: !stream <url> [preset]  — Presets: 480p, 720p, 1080p');
      return;
    }

    const parts = args.split(/\s+/);
    const url = parts[0];
    const preset = parts[1] || undefined;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      this.reply(bot, userClid, 'Please provide a valid URL.');
      return;
    }

    if (bot.videoStreaming) {
      // Change source if already streaming
      try {
        await bot.setVideoSource(url);
        this.reply(bot, userClid, `Stream source changed to: ${url}`);
      } catch (err: any) {
        this.reply(bot, userClid, `Error: ${err.message}`);
      }
      return;
    }

    this.reply(bot, userClid, 'Starting video stream...');
    try {
      await bot.startVideoStream(url, preset);
      this.reply(bot, userClid, `Video stream started: ${url}`);
    } catch (err: any) {
      this.reply(bot, userClid, `Failed to start stream: ${err.message}`);
    }
  }

  private async handleStopStream(bot: VoiceBot, userClid: number): Promise<void> {
    if (!bot.videoStreaming) {
      this.reply(bot, userClid, 'No active video stream.');
      return;
    }
    await bot.stopVideoStream();
    this.reply(bot, userClid, 'Video stream stopped.');
  }

  private handleViewers(bot: VoiceBot, userClid: number): void {
    const status = bot.videoStreamStatus;
    if (!status.streaming) {
      this.reply(bot, userClid, 'No active video stream.');
      return;
    }
    if (status.viewers.length === 0) {
      this.reply(bot, userClid, 'No viewers connected.');
      return;
    }
    const lines = status.viewers.map((v) => {
      const duration = Math.floor((Date.now() - v.joinedAt) / 1000);
      return `  clid=${v.clid} (${duration}s)`;
    });
    this.reply(bot, userClid, `Viewers (${status.viewerCount}):\n${lines.join('\n')}`);
  }

  private saveMusicRequest(bot: VoiceBot, item: QueueItem): void {
    if (!item.sourceUrl || !bot.currentConfig.serverConfigId) return;
    this.prisma.musicRequest.upsert({
      where: {
        serverConfigId_url: {
          serverConfigId: bot.currentConfig.serverConfigId,
          url: item.sourceUrl,
        },
      },
      update: {
        requestedAt: new Date(),
        title: item.title || 'Unknown Title',
      },
      create: {
        serverConfigId: bot.currentConfig.serverConfigId,
        url: item.sourceUrl,
        title: item.title || 'Unknown Title',
        requestedAt: new Date(),
      },
    }).catch((err) => {
      console.error('[MusicCmd] Failed to save music request history:', err.message);
    });
  }
}
