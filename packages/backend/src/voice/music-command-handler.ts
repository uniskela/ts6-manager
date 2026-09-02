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
import { isYouTubePlaylistUrl } from './audio/playlist-import-plan.js';
import { fetchLyrics, cleanTrackTitle, chunkLyrics, lyricsInputFromTrack } from './lyrics.js';
import {
  appleMusicTrackToYouTubeUrl,
  isAppleMusicShareUrl,
  resolveAppleMusicTracks,
  type AppleMusicTrack,
} from './audio/apple-music.js';
import { BUILTIN_COMMAND_HELP, BUILTIN_CHAT_COMMANDS } from './chat-commands.js';
import {
  formatHelpMessage,
  formatNowPlayingMessage,
  formatQueueMessage,
  formatRadioListMessage,
} from './ts6-chat-format.js';
import type { EventBridge } from '../bot-engine/event-bridge.js';
import {
  channelListenerKey,
  parseCommandChannelIds,
} from './music-command-channels.js';

interface BotChannelConfig {
  serverConfigId: number;
  virtualServerId: number;
  defaultChannel: string | null;
  commandChannelIds: string[];
}

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';
const CMD_PREFIX = '!';
const PLAYLIST_CAP = 25;

/** Cancels stale background playlist expansions for chat !play / !queue. */
const chatPlaylistGeneration = new Map<number, number>();

function invalidateChatPlaylistExpansion(botId: number): void {
  chatPlaylistGeneration.set(botId, (chatPlaylistGeneration.get(botId) ?? 0) + 1);
}

const MUSIC_COMMANDS = new Set<string>(BUILTIN_CHAT_COMMANDS);

/** Per bot+user cooldown for !help / custom replies (ms). */
const CHAT_REPLY_COOLDOWN_MS = 2500;
const chatReplyCooldownUntil = new Map<string, number>();

function chatReplyCooldownKey(botId: number, clid: number): string {
  return `${botId}:${clid}`;
}

function isChatReplyCoolingDown(botId: number, clid: number): boolean {
  const until = chatReplyCooldownUntil.get(chatReplyCooldownKey(botId, clid)) ?? 0;
  return Date.now() < until;
}

function markChatReplyCooldown(botId: number, clid: number): void {
  chatReplyCooldownUntil.set(chatReplyCooldownKey(botId, clid), Date.now() + CHAT_REPLY_COOLDOWN_MS);
}

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
 * The bot receives `notifytextmessage` in its home channel on the voice connection.
 * Additional channels use SSH query listeners (EventBridge) when configured.
 */
export class MusicCommandHandler {
  private registeredBots = new Set<number>();
  private eventBridge: EventBridge | null = null;
  private eventBridgeListening = false;
  private botChannelConfig = new Map<number, BotChannelConfig>();
  private channelToBots = new Map<string, Set<number>>();
  private activeReplyChannel = new Map<string, number>();

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
  ) {}

  setEventBridge(bridge: EventBridge): void {
    this.eventBridge = bridge;
    if (!this.eventBridgeListening) {
      this.eventBridgeListening = true;
      bridge.on('tsEvent', (configId, sid, eventName, data) => {
        if (eventName !== 'notifytextmessage') return;
        const listenerCid = data.__cmd_listener_channel_id;
        if (!listenerCid) return;
        this.onCrossChannelTextMessage(configId, sid, parseInt(listenerCid, 10), data).catch(
          (err) => {
            console.error(`[MusicCmd] Cross-channel message error: ${err.message}`);
          },
        );
      });
    }
  }

  async refreshAllBotChannels(): Promise<void> {
    const bots = await this.prisma.musicBot.findMany({ select: { id: true } });
    for (const b of bots) {
      await this.refreshBotChannels(b.id);
    }
  }

  async refreshBotChannels(botId: number): Promise<void> {
    const prevCfg = this.botChannelConfig.get(botId);

    const dbBot = await this.prisma.musicBot.findUnique({ where: { id: botId } });
    if (!dbBot) {
      this.unregisterBotChannels(botId);
      if (prevCfg) {
        await this.syncCommandListenersForPair(prevCfg.serverConfigId, prevCfg.virtualServerId);
      }
      return;
    }

    this.unregisterBotChannels(botId);

    const commandChannelIds = parseCommandChannelIds(dbBot.commandChannelIds);
    const cfg: BotChannelConfig = {
      serverConfigId: dbBot.serverConfigId,
      virtualServerId: dbBot.virtualServerId ?? 1,
      defaultChannel: dbBot.defaultChannel,
      commandChannelIds,
    };
    this.botChannelConfig.set(botId, cfg);

    for (const cidStr of commandChannelIds) {
      const channelId = parseInt(cidStr, 10);
      if (!channelId) continue;
      const key = channelListenerKey(cfg.serverConfigId, cfg.virtualServerId, channelId);
      if (!this.channelToBots.has(key)) this.channelToBots.set(key, new Set());
      this.channelToBots.get(key)!.add(botId);
    }

    await this.syncCommandListenersForPair(cfg.serverConfigId, cfg.virtualServerId);
    if (
      prevCfg &&
      (prevCfg.serverConfigId !== cfg.serverConfigId ||
        prevCfg.virtualServerId !== cfg.virtualServerId)
    ) {
      await this.syncCommandListenersForPair(prevCfg.serverConfigId, prevCfg.virtualServerId);
    }
  }

  /** Connect/disconnect SSH textchannel listeners to match active command-channel config. */
  async syncCommandListenersForPair(configId: number, sid: number): Promise<void> {
    if (!this.eventBridge) return;

    const needed = new Set(this.getNeededCommandChannelIds(configId, sid));
    const existing = new Set(this.eventBridge.getCommandListenerChannelIds(configId, sid));

    for (const channelId of needed) {
      if (existing.has(channelId)) continue;
      try {
        await this.eventBridge.connectCommandListener(configId, sid, channelId);
      } catch (err: any) {
        console.warn(
          `[MusicCmd] Command listener connect ${configId}:${sid}:${channelId}: ${err.message}`,
        );
      }
    }

    for (const channelId of existing) {
      if (needed.has(channelId)) continue;
      try {
        await this.eventBridge.disconnectCommandListener(configId, sid, channelId);
      } catch {
        /* ignore */
      }
    }
  }

  private unregisterBotChannels(botId: number): void {
    this.botChannelConfig.delete(botId);
    for (const bots of this.channelToBots.values()) {
      bots.delete(botId);
    }
  }

  /**
   * Register text message listener on a VoiceBot instance.
   * Called by VoiceBotManager whenever a bot is created/started.
   */
  registerBot(botId: number, bot: VoiceBot): void {
    if (this.registeredBots.has(botId)) return;
    this.registeredBots.add(botId);

    bot.on('textMessage', (data: Record<string, string>) => {
      const replyCid = bot.getCurrentChannelId();
      this.onTextMessage(botId, bot, data, replyCid > 0 ? replyCid : undefined).catch(err => {
        console.error(`[MusicCmd] Error processing text message on bot ${botId}: ${err.message}`);
      });
    });

    void this.refreshBotChannels(botId);

    console.log(`[MusicCmd] Registered text command listener on bot ${botId}`);
  }

  unregisterBot(botId: number): void {
    const prevCfg = this.botChannelConfig.get(botId);
    this.registeredBots.delete(botId);
    this.unregisterBotChannels(botId);
    if (prevCfg) {
      void this.syncCommandListenersForPair(prevCfg.serverConfigId, prevCfg.virtualServerId);
    }
  }

  /** Virtual-server pairs that need SSH for cross-channel music commands. */
  getNeededServerPairs(): string[] {
    const pairs = new Set<string>();
    for (const cfg of this.botChannelConfig.values()) {
      if (cfg.commandChannelIds.length === 0) continue;
      pairs.add(`${cfg.serverConfigId}:${cfg.virtualServerId}`);
    }
    return Array.from(pairs);
  }

  private async onCrossChannelTextMessage(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
  ): Promise<void> {
    const key = channelListenerKey(configId, sid, channelId);
    const botIds = this.channelToBots.get(key);
    if (!botIds || botIds.size === 0) return;

    const botId = [...botIds].find((id) => {
      const bot = this.voiceBotManager.getBot(id);
      if (!bot || bot.status === 'stopped' || bot.status === 'error') return false;
      const cfg = this.botChannelConfig.get(id);
      const homeCid =
        bot.getCurrentChannelId() || parseInt(cfg?.defaultChannel || '0', 10) || 0;
      if (homeCid > 0 && channelId === homeCid) return false;
      return true;
    });
    if (!botId) return;

    const bot = this.voiceBotManager.getBot(botId)!;
    await this.onTextMessage(botId, bot, data, channelId);
  }

  /** Channel IDs that need SSH listeners (excludes home channel while voice client is up). */
  getNeededCommandChannelIds(configId: number, sid: number): number[] {
    const ids = new Set<number>();
    for (const [botId, cfg] of this.botChannelConfig) {
      if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
      const bot = this.voiceBotManager.getBot(botId);
      const homeCid =
        bot?.getCurrentChannelId() || parseInt(cfg.defaultChannel || '0', 10) || 0;
      for (const cidStr of cfg.commandChannelIds) {
        const channelId = parseInt(cidStr, 10);
        if (!channelId) continue;
        if (bot && bot.status !== 'stopped' && bot.status !== 'error' && channelId === homeCid) {
          continue;
        }
        ids.add(channelId);
      }
    }
    return Array.from(ids);
  }

  private async onTextMessage(
    botId: number,
    bot: VoiceBot,
    data: Record<string, string>,
    replyChannelId?: number,
  ): Promise<void> {
    const userClid = parseInt(data.invokerid || '0');
    if (!userClid) return;

    const msg = (data.msg || '').trim();
    if (!msg.startsWith(CMD_PREFIX)) return;

    const parts = msg.substring(CMD_PREFIX.length).split(/\s+/);
    const command = parts[0].toLowerCase();
    const rawArgs = parts.slice(1).join(' ').trim();

    const parsedChannelId = parseInt(
      data.target || data.invokerchannelid || data.cid || '0',
      10,
    );
    const commandChannelId =
      replyChannelId ?? (parsedChannelId > 0 ? parsedChannelId : undefined);
    if (commandChannelId && commandChannelId > 0) {
      this.activeReplyChannel.set(`${botId}:${userClid}`, commandChannelId);
    }

    try {

    // TS clients auto-wrap URLs in BBCode: [URL]https://...[/URL]
    const args = rawArgs
      .replace(/\[URL(?:=[^\]]*)?\](.*?)\[\/URL\]/gi, '$1')
      .trim();

    // Ignore messages from ourselves (the bot)
    if (userClid === bot.ts3ClientId) return;

    // Built-in commands
    if (MUSIC_COMMANDS.has(command)) {
      console.log(`[MusicCmd] Bot ${botId}: !${command} ${args} (from clid=${userClid})`);
      try {
        switch (command) {
          case 'help':
            await this.handleHelp(botId, bot, userClid);
            break;
          case 'radio':
            await this.handleRadio(botId, bot, userClid, args);
            break;
          case 'play':
            await this.handlePlay(botId, bot, userClid, args);
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
            await this.handleQueue(botId, bot, userClid, args);
            break;
          case 'shuffle':
            this.handleShuffle(bot, userClid, args);
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
          case 'channels':
            await this.handleChannels(bot, userClid, args);
            break;
          case 'tv':
          case 'iptv':
            await this.handleTv(bot, userClid, args);
            break;
          case 'lyrics':
            await this.handleLyrics(bot, userClid, args);
            break;
        }
      } catch (err: any) {
        console.error(`[MusicCmd] Error handling !${command}: ${err.message}`);
        this.reply(bot, userClid, `Error: ${err.message}`);
      }
      return;
    }

    // Admin-defined custom commands for this bot's server
    await this.handleCustomCommand(botId, bot, userClid, command);
    } finally {
      if (userClid) this.activeReplyChannel.delete(`${botId}:${userClid}`);
    }
  }

  private async handleHelp(botId: number, bot: VoiceBot, userClid: number): Promise<void> {
    if (isChatReplyCoolingDown(botId, userClid)) return;
    markChatReplyCooldown(botId, userClid);

    const dbBot = await this.prisma.musicBot.findUnique({
      where: { id: botId },
      select: { serverConfigId: true },
    });

    let custom: Array<{ name: string; description: string | null }> = [];
    if (dbBot) {
      custom = await this.prisma.chatCommand.findMany({
        where: { serverConfigId: dbBot.serverConfigId, enabled: true },
        orderBy: { name: 'asc' },
        select: { name: true, description: true },
      });
    }

    this.reply(bot, userClid, formatHelpMessage(BUILTIN_COMMAND_HELP, custom));
  }

  private async handleCustomCommand(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    command: string,
  ): Promise<void> {
    if (isChatReplyCoolingDown(botId, userClid)) return;

    const dbBot = await this.prisma.musicBot.findUnique({
      where: { id: botId },
      select: { serverConfigId: true },
    });
    if (!dbBot) return;

    const custom = await this.prisma.chatCommand.findUnique({
      where: {
        serverConfigId_name: { serverConfigId: dbBot.serverConfigId, name: command },
      },
    });
    if (!custom || !custom.enabled) return;

    markChatReplyCooldown(botId, userClid);
    console.log(`[MusicCmd] Bot ${botId}: !${command} (custom, from clid=${userClid})`);
    this.reply(bot, userClid, custom.response);
  }

  private reply(bot: VoiceBot, targetClid: number, msg: string): void {
    const botId = bot.currentConfig.id;
    const replyChannelId = this.activeReplyChannel.get(`${botId}:${targetClid}`);
    const cfg = this.botChannelConfig.get(botId);
    const homeCid =
      bot.getCurrentChannelId() || parseInt(cfg?.defaultChannel || '0', 10) || 0;

    if (
      replyChannelId &&
      cfg &&
      this.eventBridge &&
      replyChannelId !== homeCid
    ) {
      void this.eventBridge
        .sendChannelText(cfg.serverConfigId, cfg.virtualServerId, replyChannelId, msg)
        .then((ok) => {
          if (!ok) {
            console.warn(
              `[MusicCmd] Cross-channel reply failed for bot ${botId} cid=${replyChannelId}, falling back to home channel`,
            );
            try {
              bot.sendChannelMessage(msg);
            } catch (err: any) {
              console.error(`[MusicCmd] Failed to send reply: ${err.message}`);
            }
          }
        });
      return;
    }

    try {
      bot.sendChannelMessage(msg);
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
      this.reply(
        bot,
        userClid,
        formatRadioListMessage(
          stations.map((s: any) => ({ id: s.id, name: s.name, genre: s.genre })),
        ),
      );
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

    await this.joinChannelForCommand(botId, bot, userClid);

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

  private async joinChannelForCommand(botId: number, bot: VoiceBot, userClid: number): Promise<void> {
    const channelId = this.activeReplyChannel.get(`${botId}:${userClid}`);
    if (!channelId || channelId <= 0) return;
    if (bot.getCurrentChannelId() === channelId) return;

    try {
      bot.joinChannel(channelId);
      console.log(
        `[MusicCmd] Bot ${botId}: joined channel ${channelId} for command from clid=${userClid}`,
      );
      await this.refreshBotChannels(botId);
    } catch (err: any) {
      console.warn(`[MusicCmd] Bot ${botId}: could not join channel ${channelId}: ${err.message}`);
    }
  }

  private async handlePlay(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    args: string,
  ): Promise<void> {
    await this.joinChannelForCommand(botId, bot, userClid);

    if (!args) {
      if (bot.status === 'paused') {
        bot.resume();
        this.reply(bot, userClid, 'Resumed.');
        return;
      }
      this.reply(bot, userClid, 'Usage: !play <youtube-url|spotify-url|apple-music-url>');
      return;
    }

    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      this.reply(bot, userClid, 'Please provide a valid URL. Usage: !play <url>');
      return;
    }

    this.reply(bot, userClid, 'Loading...');

    try {
      await this.enqueueMediaUrl(botId, bot, userClid, args);
    } catch (err: any) {
      this.reply(bot, userClid, `Failed to play: ${err.message}`);
    }
  }

  /**
   * Resolve Spotify / Apple Music / YouTube Music / playlist URLs, download the first track,
   * and queue the rest in the background (same approach as play-url).
   */
  private async enqueueMediaUrl(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    rawUrl: string,
  ): Promise<void> {
    await this.joinChannelForCommand(botId, bot, userClid);

    let mediaUrl = rawUrl;
    if (isSpotifyShareUrl(mediaUrl)) {
      mediaUrl = await resolveSpotifyToYouTube(mediaUrl);
    }

    let urlsToPlay = [mediaUrl];
    let playlistTitle: string | undefined;
    let appleMusicPending: AppleMusicTrack[] = [];

    if (isAppleMusicShareUrl(mediaUrl)) {
      const am = await resolveAppleMusicTracks(mediaUrl);
      if (!am.tracks.length) {
        throw new Error('Could not resolve any tracks from that Apple Music URL');
      }
      playlistTitle = am.title;
      const firstYt = await appleMusicTrackToYouTubeUrl(am.tracks[0]);
      if (!firstYt) {
        throw new Error(
          `No YouTube match for Apple Music track: ${am.tracks[0].artist} - ${am.tracks[0].title}`,
        );
      }
      urlsToPlay = [firstYt];
      appleMusicPending = am.tracks.slice(1, PLAYLIST_CAP);
    } else if (isYouTubeHostUrl(mediaUrl)) {
      const parsed = parseYouTubeUrl(mediaUrl);
      if (isYouTubePlaylistUrl(mediaUrl)) {
        try {
          const expanded = await expandYouTubeToWatchUrls(mediaUrl, PLAYLIST_CAP);
          if (expanded.urls.length > 0) {
            urlsToPlay = expanded.urls;
            playlistTitle = expanded.title;
          } else {
            throw new Error('Could not resolve any videos from that playlist URL');
          }
        } catch (err) {
          throw err;
        }
      } else if (parsed.watchUrl) {
        urlsToPlay = [parsed.watchUrl];
      } else {
        throw new Error('Could not resolve that YouTube URL');
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
    const pendingTotal = rest.length + appleMusicPending.length;
    const playlistNote =
      pendingTotal > 0
        ? ` (+${pendingTotal} more from${playlistTitle ? ` "${playlistTitle}"` : ' playlist'})`
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

    if (pendingTotal === 0) return;

    const generation = (chatPlaylistGeneration.get(botId) ?? 0) + 1;
    chatPlaylistGeneration.set(botId, generation);

    void (async () => {
      const enqueueYt = async (itemUrl: string): Promise<boolean> => {
        if (chatPlaylistGeneration.get(botId) !== generation) return false;
        const live = this.voiceBotManager.getBot(botId);
        if (!live || live.status === 'stopped' || live.status === 'error') return false;
        const dl = await downloadYouTube(itemUrl, MUSIC_DIR);
        if (chatPlaylistGeneration.get(botId) !== generation) return false;
        const stillLive = this.voiceBotManager.getBot(botId);
        if (!stillLive || stillLive.status === 'stopped' || stillLive.status === 'error') return false;

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
        return true;
      };

      for (const itemUrl of rest) {
        try {
          const ok = await enqueueYt(itemUrl);
          if (!ok) break;
        } catch (err) {
          console.error('[MusicCmd] Failed to queue playlist track %s:', itemUrl, err);
        }
      }

      for (const track of appleMusicPending) {
        if (chatPlaylistGeneration.get(botId) !== generation) break;
        try {
          const ytUrl = await appleMusicTrackToYouTubeUrl(track);
          if (!ytUrl) {
            console.error(
              '[MusicCmd] No YouTube match for Apple Music track: %s - %s',
              track.artist,
              track.title,
            );
            continue;
          }
          const ok = await enqueueYt(ytUrl);
          if (!ok) break;
        } catch (err) {
          console.error(
            '[MusicCmd] Failed to queue Apple Music track %s - %s:',
            track.artist,
            track.title,
            err,
          );
        }
      }
    })();
  }

  private showQueue(bot: VoiceBot, userClid: number): void {
    const items = bot.queue.getAll();
    const trackLines = items.map((item) => ({
      title: item.title,
      artist: item.artist,
      duration: item.duration,
    }));
    this.reply(
      bot,
      userClid,
      formatQueueMessage(trackLines, bot.queue.index),
    );
  }

  private async handleQueue(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    args: string,
  ): Promise<void> {
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
      await this.enqueueMediaUrl(botId, bot, userClid, args);
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

  private handleShuffle(bot: VoiceBot, userClid: number, args: string): void {
    const arg = args.trim().toLowerCase();
    let enabled: boolean;
    if (!arg) {
      enabled = !bot.queue.shuffle;
    } else if (arg === 'on' || arg === '1' || arg === 'true' || arg === 'yes') {
      enabled = true;
    } else if (arg === 'off' || arg === '0' || arg === 'false' || arg === 'no') {
      enabled = false;
    } else {
      this.reply(bot, userClid, 'Usage: !shuffle [on|off]');
      return;
    }

    bot.queue.setShuffle(enabled);
    this.reply(bot, userClid, enabled ? 'Shuffle on.' : 'Shuffle off.');
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
      this.reply(bot, userClid, '_Nothing is playing._');
      return;
    }

    const progress = bot.playbackProgress;
    const queueItems = bot.queue.getAll();
    const upcoming = queueItems
      .slice(bot.queue.index + 1, bot.queue.index + 6)
      .map((item) => ({
        title: item.title,
        artist: item.artist,
        duration: item.duration,
      }));

    this.reply(
      bot,
      userClid,
      formatNowPlayingMessage({
        title: np.title,
        artist: np.artist,
        position: progress?.position,
        duration: progress?.duration ?? np.duration,
        paused: bot.status === 'paused',
        upcoming,
        totalQueueLength: queueItems.length,
        queueIndex: bot.queue.index,
        includeControls: true,
      }),
    );
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

  private async handleChannels(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    const serverConfigId = bot.currentConfig.serverConfigId;
    if (!serverConfigId) {
      this.reply(bot, userClid, 'No server configured for this bot.');
      return;
    }
    const search = args.trim();
    const channels = await this.prisma.iptvChannel.findMany({
      where: {
        playlist: { serverConfigId },
        ...(search ? { name: { contains: search } } : {}),
      },
      orderBy: { position: 'asc' },
      take: 20,
    });

    if (channels.length === 0) {
      this.reply(bot, userClid, search
        ? `No IPTV channels matching "${search}". Add a playlist in the IPTV page.`
        : 'No IPTV channels found. Add a playlist in the IPTV page.');
      return;
    }

    const list = channels.map((c) => `• ${c.name}`).join('\n');
    this.reply(
      bot,
      userClid,
      `IPTV channels${search ? ` matching "${search}"` : ''} (first ${channels.length}):\n${list}\n\nUse !tv <name> to stream one.`,
    );
  }

  private async handleTv(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    const query = args.trim();
    if (!query) {
      this.reply(bot, userClid, 'Usage: !tv <channel name>  — Use !channels to list.');
      return;
    }
    const serverConfigId = bot.currentConfig.serverConfigId;
    if (!serverConfigId) {
      this.reply(bot, userClid, 'No server configured for this bot.');
      return;
    }

    const channel = await this.prisma.iptvChannel.findFirst({
      where: { playlist: { serverConfigId }, name: { contains: query } },
      orderBy: { position: 'asc' },
    });
    if (!channel) {
      this.reply(bot, userClid, `No channel matching "${query}". Use !channels ${query} to search.`);
      return;
    }

    if (bot.videoStreaming) {
      await bot.setVideoSource(channel.url);
      this.reply(bot, userClid, `Now streaming: ${channel.name}`);
      return;
    }

    this.reply(bot, userClid, `Starting stream: ${channel.name}...`);
    try {
      await bot.startVideoStream(channel.url);
      this.reply(bot, userClid, `Video stream started: ${channel.name}`);
    } catch (err: any) {
      this.reply(bot, userClid, `Failed to start stream: ${err.message}`);
    }
  }

  private async handleLyrics(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    let input: { artist?: string; title?: string; query?: string };
    let label: string;

    if (args.trim()) {
      input = { query: args.trim() };
      label = args.trim();
    } else {
      const np = bot.nowPlaying;
      if (!np) {
        this.reply(bot, userClid, 'Nothing playing. Usage: !lyrics [artist - title]');
        return;
      }
      const parsed = lyricsInputFromTrack({ artist: np.artist, title: np.title });
      input = parsed.input;
      label = parsed.label;
    }

    this.reply(bot, userClid, 'Looking up lyrics…');
    const result = await fetchLyrics(input);
    if (!result) {
      this.reply(bot, userClid, `Lyrics not found for "${label}".`);
      return;
    }
    if (result.instrumental) {
      this.reply(bot, userClid, `♪ ${result.artist} — ${result.title}: instrumental track.`);
      return;
    }

    const header = `🎤 ${result.artist ? `${result.artist} — ` : ''}${result.title}`;
    for (const chunk of chunkLyrics(header, result.lyrics, 900)) {
      this.reply(bot, userClid, chunk);
    }
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
