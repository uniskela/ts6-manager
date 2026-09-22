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

/** Per bot+user cooldown for custom replies (ms). */
const CHAT_REPLY_COOLDOWN_MS = 2500;
const chatReplyCooldownUntil = new Map<string, number>();

/** Collapse duplicate !help when several bots hear the same channel message. */
const HELP_ACTION_DEDUP_MS = 2500;
const helpActionUntil = new Map<string, number>();

/** Collapse duplicate !here lists when several bots hear the same channel message. */
const HERE_LIST_COOLDOWN_MS = 2000;
const hereListCooldownUntil = new Map<string, number>();

/**
 * One chat line can hit SSH cmd-listener and/or several voice bots in the same
 * channel. Claim the summon/list action once so we do not announce+join twice.
 */
const HERE_ACTION_DEDUP_MS = 1500;
const hereActionUntil = new Map<string, number>();

/** Cap auto-discovered SSH command listeners when commandChannelIds is empty. */
const MAX_AUTO_COMMAND_CHANNELS = 24;

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

function helpActionKey(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  userClid: number,
): string {
  return `${serverConfigId}:${virtualServerId}:${channelId}:${userClid}`;
}

/** Returns true if this caller should post !help; false if a duplicate. */
function claimHelpAction(key: string): boolean {
  const until = helpActionUntil.get(key) ?? 0;
  if (Date.now() < until) return false;
  helpActionUntil.set(key, Date.now() + HELP_ACTION_DEDUP_MS);
  return true;
}

function isHelpActionClaimed(key: string): boolean {
  const until = helpActionUntil.get(key) ?? 0;
  return Date.now() < until;
}

function isBotSummonable(bot: VoiceBot): boolean {
  return bot.status !== 'stopped' && bot.status !== 'error' && bot.status !== 'starting';
}

function hereActionKey(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  userClid: number,
  args: string,
): string {
  return `${serverConfigId}:${virtualServerId}:${channelId}:${userClid}:${args}`;
}

/** Returns true if this caller should run the !here action; false if a duplicate. */
function claimHereAction(key: string): boolean {
  const until = hereActionUntil.get(key) ?? 0;
  if (Date.now() < until) return false;
  hereActionUntil.set(key, Date.now() + HERE_ACTION_DEDUP_MS);
  return true;
}

/** Test helper: clear !here / !help dedupe/list cooldowns between cases. */
export function resetHereDedupForTests(): void {
  hereActionUntil.clear();
  hereListCooldownUntil.clear();
  helpActionUntil.clear();
  chatReplyCooldownUntil.clear();
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
  /** Auto-discovered command channels when bots have none configured (key: configId:sid). */
  private autoCommandChannels = new Map<string, number[]>();

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
        if (!listenerCid) {
          // Main SSH connection text events have no channel marker — music cmds need CMD listeners.
          const preview = (data.msg || '').slice(0, 40);
          console.log(
            `[MusicCmd] SSH textmessage without cmd-listener marker ignored ` +
              `(config=${configId} sid=${sid} msg=${JSON.stringify(preview)})`,
          );
          return;
        }
        console.log(
          `[MusicCmd] SSH cmd-listener textmessage config=${configId} sid=${sid} ` +
            `cid=${listenerCid} clid=${data.invokerid || '?'} msg=${JSON.stringify((data.msg || '').slice(0, 60))}`,
        );
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

    if (commandChannelIds.length === 0) {
      console.warn(
        `[MusicCmd] Bot ${botId}: no commandChannelIds configured — ` +
          `will auto-discover channels via SSH when available (same-channel voice cmds still work)`,
      );
    } else {
      console.log(
        `[MusicCmd] Bot ${botId}: command channels=[${commandChannelIds.join(',')}] ` +
          `vs=${cfg.virtualServerId} config=${cfg.serverConfigId}`,
      );
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
    if (!this.eventBridge) {
      console.warn(
        `[MusicCmd] syncCommandListeners skipped ${configId}:${sid}: no eventBridge`,
      );
      return;
    }

    const needed = new Set(this.getNeededCommandChannelIds(configId, sid));
    const pairKey = `${configId}:${sid}`;
    const hasExplicit = this.pairHasExplicitCommandChannels(configId, sid);

    if (!hasExplicit) {
      const discovered = await this.discoverChannelsForCommands(configId, sid);
      this.autoCommandChannels.set(pairKey, discovered);
      for (const channelId of discovered) {
        needed.add(channelId);
      }
      this.mapBotsToAutoChannels(configId, sid, discovered);
      if (discovered.length === 0) {
        console.warn(
          `[MusicCmd] No SSH command listeners for ${pairKey}: ` +
            `empty commandChannelIds and channel discovery returned none ` +
            `(check SSH credentials; !commands only work in the bot's current voice channel)`,
        );
      } else {
        console.log(
          `[MusicCmd] Auto command channels for ${pairKey}: [${discovered.join(',')}]`,
        );
      }
    } else {
      this.autoCommandChannels.delete(pairKey);
    }

    const existing = new Set(this.eventBridge.getCommandListenerChannelIds(configId, sid));
    console.log(
      `[MusicCmd] Syncing SSH cmd listeners ${pairKey}: needed=[${[...needed].join(',')}] ` +
        `existing=[${[...existing].join(',')}]`,
    );

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

  private pairHasExplicitCommandChannels(configId: number, sid: number): boolean {
    for (const cfg of this.botChannelConfig.values()) {
      if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
      if (cfg.commandChannelIds.length > 0) return true;
    }
    return false;
  }

  private mapBotsToAutoChannels(configId: number, sid: number, channelIds: number[]): void {
    const botIds: number[] = [];
    for (const [botId, cfg] of this.botChannelConfig) {
      if (cfg.serverConfigId === configId && cfg.virtualServerId === sid) {
        botIds.push(botId);
      }
    }
    for (const channelId of channelIds) {
      const key = channelListenerKey(configId, sid, channelId);
      if (!this.channelToBots.has(key)) this.channelToBots.set(key, new Set());
      for (const botId of botIds) {
        this.channelToBots.get(key)!.add(botId);
      }
    }
  }

  private async discoverChannelsForCommands(
    configId: number,
    sid: number,
  ): Promise<number[]> {
    if (!this.eventBridge) return [];
    try {
      const raw = await this.eventBridge.executeCommand(configId, sid, 'channellist');
      const { parseQueryResponse } = await import('@ts6/common');
      const ids: number[] = [];
      for (const line of raw.split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('error ')) continue;
        for (const entry of parseQueryResponse(trimmed)) {
          const cid = parseInt(entry.cid || '0', 10);
          if (cid > 0 && !ids.includes(cid)) ids.push(cid);
        }
      }
      ids.sort((a, b) => a - b);
      if (ids.length > MAX_AUTO_COMMAND_CHANNELS) {
        console.warn(
          `[MusicCmd] Auto-discover capped at ${MAX_AUTO_COMMAND_CHANNELS} channels ` +
            `(found ${ids.length} on ${configId}:${sid}); configure commandChannelIds to target specific ones`,
        );
        return ids.slice(0, MAX_AUTO_COMMAND_CHANNELS);
      }
      return ids;
    } catch (err: any) {
      console.warn(
        `[MusicCmd] Channel discovery failed for ${configId}:${sid}: ${err.message}`,
      );
      return [];
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
    if (this.registeredBots.has(botId)) {
      console.log(`[MusicCmd] Bot ${botId} already registered for text commands`);
      return;
    }
    this.registeredBots.add(botId);

    bot.on('textMessage', (data: Record<string, string>) => {
      console.log(
        `[MusicCmd] Voice textmessage bot=${botId} clid=${data.invokerid || '?'} ` +
          `homeCid=${bot.getCurrentChannelId()} msg=${JSON.stringify((data.msg || '').slice(0, 60))}`,
      );
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
      // Always request SSH for music bots so command listeners / auto-discovery can run.
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
    if (!botIds || botIds.size === 0) {
      console.warn(
        `[MusicCmd] Cross-channel text in cid=${channelId} but no bots mapped ` +
          `(config=${configId} sid=${sid}); msg=${JSON.stringify((data.msg || '').slice(0, 40))}`,
      );
      return;
    }

    const msg = (data.msg || '').trim();
    if (msg.startsWith(CMD_PREFIX)) {
      const parts = msg.substring(CMD_PREFIX.length).split(/\s+/);
      const command = (parts[0] || '').toLowerCase();
      if (command === 'here' || command === 'come') {
        // Prefer the in-channel voice path when a music bot is already here —
        // otherwise SSH + voice both announce/join for the same chat line.
        const voiceBotInChannel = [...botIds].some((id) => {
          const bot = this.voiceBotManager.getBot(id);
          return (
            !!bot &&
            isBotSummonable(bot) &&
            bot.getCurrentChannelId() === channelId
          );
        });
        if (voiceBotInChannel) {
          console.log(
            `[MusicCmd] Cross-channel !here skipped: voice bot already in cid=${channelId}`,
          );
          return;
        }
        const rawArgs = parts.slice(1).join(' ').trim();
        await this.handleHereCrossChannel(configId, sid, channelId, data, rawArgs);
        return;
      }
      if (command === 'help') {
        const voiceBotInChannel = [...botIds].some((id) => {
          const bot = this.voiceBotManager.getBot(id);
          return (
            !!bot &&
            isBotSummonable(bot) &&
            bot.getCurrentChannelId() === channelId
          );
        });
        if (voiceBotInChannel) {
          console.log(
            `[MusicCmd] Cross-channel !help skipped: voice bot already in cid=${channelId}`,
          );
          return;
        }
        await this.handleHelpCrossChannel(configId, sid, channelId, data);
        return;
      }
    }

    const botId = [...botIds].find((id) => {
      const bot = this.voiceBotManager.getBot(id);
      if (!bot || bot.status === 'stopped' || bot.status === 'error') return false;
      // Only skip SSH routing when the voice client is *actually* in this channel.
      const homeCid = bot.getCurrentChannelId();
      if (homeCid > 0 && channelId === homeCid) return false;
      return true;
    });
    if (!botId) {
      console.log(
        `[MusicCmd] Cross-channel text cid=${channelId} ignored: all mapped bots are home or stopped`,
      );
      return;
    }

    const bot = this.voiceBotManager.getBot(botId)!;
    await this.onTextMessage(botId, bot, data, channelId);
  }

  /** Channel IDs that need SSH listeners (excludes home channel while voice client is up). */
  getNeededCommandChannelIds(configId: number, sid: number): number[] {
    const ids = new Set<number>();
    for (const [botId, cfg] of this.botChannelConfig) {
      if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
      const bot = this.voiceBotManager.getBot(botId);
      // Use actual presence only — defaultChannel fallback previously skipped SSH listeners
      // when getCurrentChannelId() was still 0, leaving cross-channel commands silent.
      const homeCid = bot?.getCurrentChannelId() || 0;
      for (const cidStr of cfg.commandChannelIds) {
        const channelId = parseInt(cidStr, 10);
        if (!channelId) continue;
        if (
          bot &&
          bot.status !== 'stopped' &&
          bot.status !== 'error' &&
          homeCid > 0 &&
          channelId === homeCid
        ) {
          continue;
        }
        ids.add(channelId);
      }
    }
    // Include previously auto-discovered channels so sync doesn't tear them down mid-flight
    // before rediscovery (explicit configs clear autoCommandChannels in sync).
    const auto = this.autoCommandChannels.get(`${configId}:${sid}`);
    if (auto) {
      for (const channelId of auto) {
        const botHome = [...this.botChannelConfig.entries()].some(([botId, cfg]) => {
          if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) return false;
          const bot = this.voiceBotManager.getBot(botId);
          return !!bot && bot.getCurrentChannelId() === channelId;
        });
        if (!botHome) ids.add(channelId);
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
          case 'here':
          case 'come':
            await this.handleHere(botId, bot, userClid, args);
            break;
          case 'playlist':
          case 'pl':
            await this.handlePlaylist(botId, bot, userClid, args);
            break;
          case 'repeat':
            this.handleRepeat(bot, userClid, args);
            break;
          case 'seek':
            await this.handleSeek(bot, userClid, args);
            break;
          case 'remove':
            this.handleRemove(bot, userClid, args);
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
    const cfg = this.botChannelConfig.get(botId);
    const serverConfigId = cfg?.serverConfigId ?? bot.currentConfig.serverConfigId;
    const virtualServerId = cfg?.virtualServerId ?? 1;
    const channelId =
      this.activeReplyChannel.get(`${botId}:${userClid}`) ||
      bot.getCurrentChannelId() ||
      0;
    const helpKey = helpActionKey(serverConfigId, virtualServerId, channelId, userClid);
    if (!claimHelpAction(helpKey)) {
      console.log(
        `[MusicCmd] !help deduped (bot=${botId} cid=${channelId} clid=${userClid})`,
      );
      return;
    }

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

  /**
   * Cross-channel !help when no music bot is in the requester channel.
   * Posts via SSH Query as "TS6 Helper" (brief channel presence) — not a full voice bot.
   */
  private async handleHelpCrossChannel(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
  ): Promise<void> {
    const userClid = parseInt(data.invokerid || '0', 10);
    if (!userClid || channelId <= 0) return;

    const helpKey = helpActionKey(configId, sid, channelId, userClid);
    // Peek only — claim after a successful post so a failed/missing SSH send never
    // blocks an in-channel voice bot that shares this channel key.
    if (isHelpActionClaimed(helpKey)) {
      console.log(
        `[MusicCmd] Cross-channel !help deduped (cid=${channelId} clid=${userClid})`,
      );
      return;
    }

    console.log(
      `[MusicCmd] Cross-channel !help (config=${configId} sid=${sid} cid=${channelId} clid=${userClid})`,
    );

    let custom: Array<{ name: string; description: string | null }> = [];
    try {
      custom = await this.prisma.chatCommand.findMany({
        where: { serverConfigId: configId, enabled: true },
        orderBy: { name: 'asc' },
        select: { name: true, description: true },
      });
    } catch (err: any) {
      console.warn(`[MusicCmd] !help custom command lookup failed: ${err.message}`);
    }

    const msg = formatHelpMessage(BUILTIN_COMMAND_HELP, custom);
    if (!this.eventBridge) {
      console.warn(`[MusicCmd] Cross-channel !help: no eventBridge (cid=${channelId})`);
      return;
    }
    const ok = await this.eventBridge.sendChannelText(configId, sid, channelId, msg, {
      helperNickname: 'TS6 Helper',
    });
    if (!ok) {
      console.warn(
        `[MusicCmd] Cross-channel !help failed to post in cid=${channelId} (SSH listener?)`,
      );
      return;
    }
    claimHelpAction(helpKey);
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

  /**
   * Send a command reply. When the command came from another channel, prefers the
   * SSH command-channel listener so the user sees the message where they typed.
   * Await this before joinChannel/refreshBotChannels — those disconnect the
   * listener and optimistically change the bot's channel id.
   */
  private async reply(bot: VoiceBot, targetClid: number, msg: string): Promise<void> {
    const botId = bot.currentConfig.id;
    const replyChannelId = this.activeReplyChannel.get(`${botId}:${targetClid}`);
    const cfg = this.botChannelConfig.get(botId);
    // Actual voice presence only — defaultChannel fallback made cross-channel
    // replies take the home-channel path while the bot was still elsewhere.
    const homeCid = bot.getCurrentChannelId() || 0;

    if (
      replyChannelId &&
      cfg &&
      this.eventBridge &&
      (homeCid <= 0 || replyChannelId !== homeCid)
    ) {
      const ok = await this.eventBridge.sendChannelText(
        cfg.serverConfigId,
        cfg.virtualServerId,
        replyChannelId,
        msg,
        { helperNickname: 'TS6 Helper' },
      );
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

  private async listSummonableBots(
    serverConfigId: number,
    virtualServerId: number,
  ): Promise<Array<{ id: number; name: string; bot: VoiceBot }>> {
    const dbBots = await this.prisma.musicBot.findMany({
      where: { serverConfigId },
      select: { id: true, name: true, nickname: true, virtualServerId: true },
      orderBy: { id: 'asc' },
    });

    const result: Array<{ id: number; name: string; bot: VoiceBot }> = [];
    for (const row of dbBots) {
      const sid = row.virtualServerId ?? 1;
      if (sid !== virtualServerId) continue;
      const bot = this.voiceBotManager.getBot(row.id);
      if (!bot || !isBotSummonable(bot)) continue;
      result.push({
        id: row.id,
        name: (row.name || row.nickname || `Bot ${row.id}`).slice(0, 60),
        bot,
      });
    }
    return result;
  }

  private formatHereBotList(
    bots: Array<{ id: number; name: string }>,
    opts?: { busy?: boolean; hereIds?: Set<number>; idleIds?: Set<number> },
  ): string {
    const hereIds = opts?.hereIds;
    const idleIds = opts?.idleIds;
    const lines = bots.map((b) => {
      let tag = '';
      if (hereIds?.has(b.id)) tag = ' (already here)';
      else if (idleIds && !idleIds.has(b.id) && !opts?.busy) tag = ' (busy)';
      return `[${b.id}] ${b.name}${tag}`;
    });
    if (opts?.busy) {
      return (
        `All music bots are busy with other users:\n${lines.join('\n')}\n` +
        `Use !here <id> to move a specific bot (may leave their channel).`
      );
    }
    return `Available bots:\n${lines.join('\n')}\nUse: !here <id>`;
  }

  private shouldSpeakHereList(
    serverConfigId: number,
    virtualServerId: number,
    channelId: number,
    userClid: number,
  ): boolean {
    const key = `${serverConfigId}:${virtualServerId}:${channelId}:${userClid}`;
    const until = hereListCooldownUntil.get(key) ?? 0;
    if (Date.now() < until) return false;
    hereListCooldownUntil.set(key, Date.now() + HERE_LIST_COOLDOWN_MS);
    return true;
  }

  /**
   * Non-disruptive summon selection:
   * 1) sole bot already in channel → "already here"
   * 2) one+ already here AND other idle bots elsewhere → list (do not hide the others)
   * 3) idle bots (no other humans); sole idle → summon; several → list
   * 4) otherwise do not auto-steal — caller lists busy bots
   */
  private async resolveSummonCandidate(
    candidates: Array<{ id: number; name: string; bot: VoiceBot }>,
    channelId: number,
    serverConfigId: number,
    virtualServerId: number,
  ): Promise<
    | { kind: 'summon'; target: { id: number; name: string; bot: VoiceBot } }
    | {
        kind: 'list';
        bots: Array<{ id: number; name: string }>;
        busy: boolean;
        hereIds?: Set<number>;
        idleIds?: Set<number>;
      }
  > {
    const alreadyHere = candidates.filter((c) => c.bot.getCurrentChannelId() === channelId);
    const idle: Array<{ id: number; name: string; bot: VoiceBot }> = [];
    for (const c of candidates) {
      if (await this.isBotIdleForSummon(c.bot, serverConfigId, virtualServerId)) {
        idle.push(c);
      }
    }
    const idleIds = new Set(idle.map((c) => c.id));
    const hereIds = new Set(alreadyHere.map((c) => c.id));
    const idleElsewhere = idle.filter((c) => !hereIds.has(c.id));

    // One bot already here and nobody else idle to offer → confirm presence.
    if (alreadyHere.length === 1 && idleElsewhere.length === 0 && candidates.length === 1) {
      return { kind: 'summon', target: alreadyHere[0] };
    }
    // Someone is here but other idle bots exist — list so the user can pick.
    if (alreadyHere.length >= 1 && idleElsewhere.length > 0) {
      return {
        kind: 'list',
        bots: [...alreadyHere, ...idleElsewhere],
        busy: false,
        hereIds,
        idleIds,
      };
    }
    if (alreadyHere.length > 1 && idleElsewhere.length === 0) {
      return { kind: 'list', bots: alreadyHere, busy: false, hereIds, idleIds };
    }
    // Sole already-here among busy-only others → confirm; user can !here <id> to steal.
    if (alreadyHere.length === 1 && idleElsewhere.length === 0) {
      return { kind: 'summon', target: alreadyHere[0] };
    }

    if (idle.length === 1) {
      return { kind: 'summon', target: idle[0] };
    }
    if (idle.length > 1) {
      return { kind: 'list', bots: idle, busy: false, idleIds };
    }

    return { kind: 'list', bots: candidates, busy: true };
  }

  /**
   * Idle = no other *human* clients in the bot's channel (sibling music bots do not count).
   * Prefer a ServerQuery clientlist snapshot (accurate after join/move); fall back to
   * the voice client's peer set. Unknown channel → not idle (do not steal).
   */
  private async isBotIdleForSummon(
    bot: VoiceBot,
    serverConfigId: number,
    virtualServerId: number,
  ): Promise<boolean> {
    const homeCid = bot.getCurrentChannelId();
    if (homeCid <= 0) return false;

    const musicClids = this.musicBotClidsOnServer(serverConfigId, virtualServerId);
    const fromList = await this.countHumanPeersViaClientList(
      serverConfigId,
      virtualServerId,
      homeCid,
      musicClids,
    );
    if (fromList != null) return fromList === 0;

    try {
      const peers = bot.getHumanChannelPeerClids();
      const humans = peers.filter((clid) => !musicClids.has(clid));
      return humans.length === 0;
    } catch {
      try {
        return bot.getHumanChannelPeerCount() === 0;
      } catch {
        return false;
      }
    }
  }

  /**
   * TS client IDs for music bots on this virtual server that still have a live voice session.
   * Discarded/disconnected bots can leave a leftover `ts3ClientId`; that clid may later be
   * reused by a human, so only exclude clids while the bot is actually connected.
   */
  private musicBotClidsOnServer(serverConfigId: number, virtualServerId: number): Set<number> {
    const clids = new Set<number>();
    for (const [botId, cfg] of this.botChannelConfig) {
      if (cfg.serverConfigId !== serverConfigId || cfg.virtualServerId !== virtualServerId) {
        continue;
      }
      const b = this.voiceBotManager.getBot(botId);
      if (!b || !isBotSummonable(b)) continue;
      const clid = b.ts3ClientId || 0;
      if (clid > 0) clids.add(clid);
    }
    return clids;
  }

  /**
   * Returns human (non-query, non-music-bot) clients in channel, or null if unknown.
   * `excludeClids` should include all known music-bot voice clids on this server.
   */
  private async countHumanPeersViaClientList(
    configId: number,
    sid: number,
    channelId: number,
    excludeClids: Set<number>,
  ): Promise<number | null> {
    if (!this.eventBridge || channelId <= 0) return null;
    try {
      const raw = await this.eventBridge.executeCommand(configId, sid, 'clientlist');
      const { parseQueryResponse } = await import('@ts6/common');
      let count = 0;
      for (const line of raw.split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('error ')) continue;
        for (const entry of parseQueryResponse(trimmed)) {
          const cid = parseInt(entry.cid || '0', 10);
          const clid = parseInt(entry.clid || '0', 10);
          if (cid !== channelId || !clid || excludeClids.has(clid)) continue;
          if (String(entry.client_type || '0') === '1') continue;
          count++;
        }
      }
      return count;
    } catch (err: any) {
      console.warn(
        `[MusicCmd] clientlist occupancy check failed for ${configId}:${sid} cid=${channelId}: ${err.message}`,
      );
      return null;
    }
  }

  private async summonBotToChannel(
    target: { id: number; name: string; bot: VoiceBot },
    channelId: number,
    replyBot: VoiceBot,
    userClid: number,
  ): Promise<void> {
    if (!channelId || channelId <= 0) {
      await this.reply(replyBot, userClid, 'Could not determine this channel.');
      return;
    }

    if (target.bot.getCurrentChannelId() === channelId) {
      await this.reply(
        replyBot,
        userClid,
        `${target.name} [#${target.id}] is already here.`,
      );
      return;
    }

    if (!isBotSummonable(target.bot) || !target.bot.ts3ClientId) {
      await this.reply(
        replyBot,
        userClid,
        `Could not move ${target.name} [#${target.id}]: bot is not fully connected.`,
      );
      return;
    }

    // Announce *before* joinChannel / refreshBotChannels. joinChannel
    // optimistically sets currentChannelId, and refresh disconnects the SSH
    // command-channel listener once that channel looks like "home" — so a
    // post-move reply often never reaches the channel where the user typed.
    await this.reply(
      replyBot,
      userClid,
      `${target.name} [#${target.id}] is joining.`,
    );

    try {
      target.bot.joinChannel(channelId);
      if (target.bot.getCurrentChannelId() !== channelId) {
        await this.reply(
          replyBot,
          userClid,
          `Could not move ${target.name} [#${target.id}]: move did not apply.`,
        );
        return;
      }
      console.log(
        `[MusicCmd] Bot ${target.id}: summoned to channel ${channelId} by clid=${userClid}`,
      );
      await this.refreshBotChannels(target.id);
    } catch (err: any) {
      console.warn(`[MusicCmd] Bot ${target.id}: summon failed: ${err.message}`);
      await this.reply(
        replyBot,
        userClid,
        `Could not move ${target.name} [#${target.id}]: ${err.message}`,
      );
    }
  }

  /**
   * Resolve the channel the user typed in. Prefer an explicit reply/listener cid,
   * then the bot's tracked home channel, then SSH clientlist for the invoker.
   */
  private async resolveCommandChannelId(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    hintChannelId?: number,
  ): Promise<number> {
    if (hintChannelId && hintChannelId > 0) return hintChannelId;

    const homeCid = bot.getCurrentChannelId();
    if (homeCid > 0) return homeCid;

    const cfg = this.botChannelConfig.get(botId);
    if (!cfg || !this.eventBridge || userClid <= 0) return 0;

    try {
      const raw = await this.eventBridge.executeCommand(
        cfg.serverConfigId,
        cfg.virtualServerId,
        'clientlist',
      );
      const { parseQueryResponse } = await import('@ts6/common');
      for (const line of raw.split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('error ')) continue;
        for (const entry of parseQueryResponse(trimmed)) {
          const clid = parseInt(entry.clid || '0', 10);
          if (clid !== userClid) continue;
          const cid = parseInt(entry.cid || '0', 10);
          if (cid > 0) return cid;
        }
      }
    } catch (err: any) {
      console.warn(
        `[MusicCmd] Invoker channel lookup failed for bot=${botId} clid=${userClid}: ${err.message}`,
      );
    }
    return 0;
  }

  private async handleHere(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    args: string,
  ): Promise<void> {
    const cfg = this.botChannelConfig.get(botId);
    const serverConfigId = cfg?.serverConfigId ?? bot.currentConfig.serverConfigId;
    const virtualServerId = cfg?.virtualServerId ?? 1;
    const hinted =
      this.activeReplyChannel.get(`${botId}:${userClid}`) ||
      bot.getCurrentChannelId() ||
      0;
    const channelId = await this.resolveCommandChannelId(
      botId,
      bot,
      userClid,
      hinted > 0 ? hinted : undefined,
    );

    if (channelId > 0) {
      this.activeReplyChannel.set(`${botId}:${userClid}`, channelId);
    }

    // Unknown command channel → do not claim with cid=0 (would miss SSH dedupe).
    // Soft notice only when SSH cannot own the line; otherwise the cmd-listener
    // still summons and a "could not determine" message races the join announce.
    if (channelId <= 0) {
      console.warn(
        `[MusicCmd] !here skipped on voice bot=${botId}: unknown channel (homeCid=${bot.getCurrentChannelId()})`,
      );
      if (this.eventBridge) {
        return;
      }
      const softKey = hereActionKey(serverConfigId, virtualServerId, 0, userClid, `unknown:${args}`);
      if (!claimHereAction(softKey)) return;
      try {
        bot.sendChannelMessage(
          'Could not determine this channel yet. Wait a second and try !here again.',
        );
      } catch (err: any) {
        console.warn(`[MusicCmd] !here unknown-channel notice failed: ${err.message}`);
      }
      return;
    }

    if (
      !claimHereAction(hereActionKey(serverConfigId, virtualServerId, channelId, userClid, args))
    ) {
      console.log(
        `[MusicCmd] !here deduped (bot=${botId} cid=${channelId} clid=${userClid} args=${JSON.stringify(args)})`,
      );
      return;
    }

    const candidates = await this.listSummonableBots(serverConfigId, virtualServerId);
    if (candidates.length === 0) {
      await this.reply(bot, userClid, 'No music bots are available right now.');
      return;
    }

    if (!args) {
      if (candidates.length === 1) {
        await this.summonBotToChannel(candidates[0], channelId, bot, userClid);
        return;
      }
      const resolved = await this.resolveSummonCandidate(
        candidates,
        channelId,
        serverConfigId,
        virtualServerId,
      );
      if (resolved.kind === 'summon') {
        await this.summonBotToChannel(resolved.target, channelId, bot, userClid);
        return;
      }
      if (!this.shouldSpeakHereList(serverConfigId, virtualServerId, channelId, userClid)) {
        console.log(
          `[MusicCmd] !here list suppressed by cooldown (config=${serverConfigId} cid=${channelId} clid=${userClid})`,
        );
        return;
      }
      await this.reply(
        bot,
        userClid,
        this.formatHereBotList(resolved.bots, {
          busy: resolved.busy,
          hereIds: resolved.hereIds,
          idleIds: resolved.idleIds,
        }),
      );
      return;
    }

    const targetId = parseInt(args, 10);
    if (isNaN(targetId) || String(targetId) !== args.trim()) {
      await this.reply(bot, userClid, 'Usage: !here [id] — Use !here to list bots.');
      return;
    }

    const target = candidates.find((c) => c.id === targetId);
    if (!target) {
      await this.reply(
        bot,
        userClid,
        `Bot #${targetId} is not available. Use !here to list bots.`,
      );
      return;
    }

    // Explicit id = intentional, even if the bot is busy with other users.
    await this.summonBotToChannel(target, channelId, bot, userClid);
  }

  /** Cross-channel !here: list/summon any running bot on this virtual server. */
  private async handleHereCrossChannel(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
    args: string,
  ): Promise<void> {
    const userClid = parseInt(data.invokerid || '0', 10);
    if (!userClid) {
      console.warn(
        `[MusicCmd] Cross-channel !here ignored: missing invokerid (cid=${channelId})`,
      );
      return;
    }

    if (channelId <= 0) {
      console.warn(`[MusicCmd] Cross-channel !here ignored: invalid cid=${channelId}`);
      return;
    }

    if (!claimHereAction(hereActionKey(configId, sid, channelId, userClid, args))) {
      console.log(
        `[MusicCmd] Cross-channel !here deduped (cid=${channelId} clid=${userClid} args=${JSON.stringify(args)})`,
      );
      return;
    }

    console.log(
      `[MusicCmd] Cross-channel !here ${args} (config=${configId} sid=${sid} cid=${channelId} clid=${userClid})`,
    );

    const candidates = await this.listSummonableBots(configId, sid);
    if (candidates.length === 0) {
      const noneMsg = 'No music bots are available right now.';
      if (this.eventBridge) {
        const ok = await this.eventBridge.sendChannelText(
          configId,
          sid,
          channelId,
          noneMsg,
          { helperNickname: 'TS6 Helper' },
        );
        if (!ok) {
          console.warn(
            `[MusicCmd] !here: no summonable bots; failed to reply in cid=${channelId}`,
          );
        }
      } else {
        console.warn(
          `[MusicCmd] !here: no summonable bots and no eventBridge to reply (cid=${channelId})`,
        );
      }
      return;
    }

    const replyBot = candidates[0].bot;
    // Route replies through a summonable bot while tagging the command channel.
    this.activeReplyChannel.set(`${replyBot.currentConfig.id}:${userClid}`, channelId);
    try {
      if (!args) {
        if (candidates.length === 1) {
          await this.summonBotToChannel(candidates[0], channelId, replyBot, userClid);
          return;
        }
        const resolved = await this.resolveSummonCandidate(
          candidates,
          channelId,
          configId,
          sid,
        );
        if (resolved.kind === 'summon') {
          await this.summonBotToChannel(resolved.target, channelId, replyBot, userClid);
          return;
        }
        if (!this.shouldSpeakHereList(configId, sid, channelId, userClid)) {
          console.log(
            `[MusicCmd] Cross-channel !here list suppressed by cooldown (cid=${channelId} clid=${userClid})`,
          );
          return;
        }
        await this.reply(
          replyBot,
          userClid,
          this.formatHereBotList(resolved.bots, {
            busy: resolved.busy,
            hereIds: resolved.hereIds,
            idleIds: resolved.idleIds,
          }),
        );
        return;
      }

      const targetId = parseInt(args, 10);
      if (isNaN(targetId) || String(targetId) !== args.trim()) {
        await this.reply(replyBot, userClid, 'Usage: !here [id] — Use !here to list bots.');
        return;
      }

      const target = candidates.find((c) => c.id === targetId);
      if (!target) {
        await this.reply(
          replyBot,
          userClid,
          `Bot #${targetId} is not available. Use !here to list bots.`,
        );
        return;
      }

      await this.summonBotToChannel(target, channelId, replyBot, userClid);
    } finally {
      this.activeReplyChannel.delete(`${replyBot.currentConfig.id}:${userClid}`);
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

  private async handlePlaylist(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void> {
    const serverConfigId = bot.currentConfig.serverConfigId;
    if (!serverConfigId) { this.reply(bot, userClid, 'No server configured.'); return; }
    const where = { serverConfigId, OR: [{ musicBotId: botId }, { musicBotId: null }] };
    const playlists = await this.prisma.playlist.findMany({
      where, select: { id: true, name: true }, orderBy: { name: 'asc' },
    });
    const query = args.trim().toLowerCase();
    if (!query) {
      this.reply(bot, userClid, playlists.length
        ? 'Playlists (first 10):\n' + playlists.slice(0, 10).map(p => `[${p.id}] ${p.name.slice(0, 60)}`).join('\n')
        : 'No playlists configured for this bot/server.');
      return;
    }
    const byId = /^\d+$/.test(query) ? playlists.filter(p => p.id === Number(query)) : [];
    const exact = playlists.filter(p => p.name.toLowerCase() === query);
    const matches = byId.length ? byId : exact.length ? exact : playlists.filter(p => p.name.toLowerCase().includes(query));
    if (matches.length !== 1) {
      this.reply(bot, userClid, matches.length
        ? 'Ambiguous playlist; use an ID: ' + matches.slice(0, 5).map(p => `[${p.id}] ${p.name.slice(0, 60)}`).join(', ')
        : 'Playlist not found. Use !playlist to list.');
      return;
    }
    const playlist = await this.prisma.playlist.findFirst({
      where: { ...where, id: matches[0].id },
      include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
    });
    if (!playlist?.songs.length) { this.reply(bot, userClid, 'Playlist is empty.'); return; }
    const items: QueueItem[] = playlist.songs.map(({ song }) => ({
      id: String(song.id), title: song.title, artist: song.artist ?? undefined,
      duration: song.duration ?? undefined, filePath: song.filePath,
      source: song.source as QueueItem['source'], sourceUrl: song.sourceUrl ?? undefined,
    }));
    bot.queue.addMany(items);
    if (bot.status === 'connected' && !bot.nowPlaying) {
      const first = bot.queue.playAt(bot.queue.index < 0 ? 0 : bot.queue.index + 1);
      if (first) await bot.play(first); // VoiceBot owns local/stream playlist resolution.
    }
    this.reply(bot, userClid, `Queued playlist "${playlist.name.slice(0, 60)}" (${items.length} tracks).`);
  }

  private handleRepeat(bot: VoiceBot, userClid: number, args: string): void {
    const mode = args.trim().toLowerCase();
    if (mode && mode !== 'off' && mode !== 'track' && mode !== 'queue') {
      this.reply(bot, userClid, 'Usage: !repeat [off|track|queue]'); return;
    }
    if (mode === 'off' || mode === 'track' || mode === 'queue') bot.queue.setRepeat(mode);
    this.reply(bot, userClid, `Repeat mode: ${bot.queue.repeat}`);
  }

  private async handleSeek(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(args) || !Number.isFinite(Number(args))) {
      this.reply(bot, userClid, 'Usage: !seek <seconds|+seconds|-seconds>'); return;
    }
    if (!bot.canSeek) {
      this.reply(bot, userClid, 'Current source cannot be seeked. Play a local/downloaded track first.'); return;
    }
    const progress = bot.playbackProgress;
    const relative = /^[+-]/.test(args);
    const target = Math.max(0, Math.min((relative ? (progress?.position ?? 0) : 0) + Number(args),
      progress?.duration || bot.nowPlaying?.duration || Infinity));
    await bot.seek(target);
    this.reply(bot, userClid, `Seeked to ${Math.floor(target)} seconds.`);
  }

  private handleRemove(bot: VoiceBot, userClid: number, args: string): void {
    const query = args.trim().toLowerCase();
    if (!query) { this.reply(bot, userClid, 'Usage: !remove <text>'); return; }
    const upcoming = bot.queue.getAll().map((item, index) => ({ item, index }))
      .filter(({ index }) => index > bot.queue.index);
    const exact = upcoming.filter(({ item }) => item.title.toLowerCase() === query || item.artist?.toLowerCase() === query);
    const matches = exact.length ? exact : upcoming.filter(({ item }) =>
      item.title.toLowerCase().includes(query) || item.artist?.toLowerCase().includes(query));
    if (matches.length !== 1) {
      this.reply(bot, userClid, matches.length
        ? 'Multiple matches; use !queue remove <n>: ' + matches.slice(0, 5).map(({ item, index }) => `#${index + 1} ${item.title.slice(0, 60)}`).join(', ')
        : 'No upcoming track matches.');
      return;
    }
    bot.queue.removeAt(matches[0].index);
    this.reply(bot, userClid, `Removed: ${matches[0].item.title.slice(0, 100)}`);
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
      const idx = (/^[1-9]\d*$/.test(args.substring(7).trim()) ? Number(args.substring(7).trim()) : NaN) - 1; // 1-based to 0-based
      const items = bot.queue.getAll();
      if (isNaN(idx) || idx < 0 || idx >= items.length) {
        this.reply(bot, userClid, `Invalid index. Queue has ${items.length} tracks.`);
        return;
      }
      const removed = items[idx];
      bot.queue.removeAt(idx);
      this.reply(bot, userClid, `Removed #${idx + 1}: ${removed.title}`);
      return;
    }

    // !queue play <index>
    if (args.toLowerCase().startsWith('play ')) {
      const idx = (/^[1-9]\d*$/.test(args.substring(5).trim()) ? Number(args.substring(5).trim()) : NaN) - 1; // 1-based to 0-based
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
