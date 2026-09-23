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
  formatCustomCommandsMessage,
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

/** Debounce parking the main SSH helper when humans move between channels. */
const MAIN_HELPER_PARK_DEBOUNCE_MS = 800;

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

function chatInfoReplyKey(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  clid: number,
  command: string,
): string {
  return `${serverConfigId}:${virtualServerId}:${channelId}:${clid}:${command}`;
}

function tryClaimChatInfoReply(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  clid: number,
  command: string,
): boolean {
  const key = chatInfoReplyKey(serverConfigId, virtualServerId, channelId, clid, command);
  const until = chatReplyCooldownUntil.get(key) ?? 0;
  if (Date.now() < until) return false;
  chatReplyCooldownUntil.set(key, Date.now() + CHAT_REPLY_COOLDOWN_MS);
  return true;
}

/** @internal Exported for unit tests. */
export function resetChatReplyCooldownsForTests(): void {
  chatReplyCooldownUntil.clear();
  helpActionUntil.clear();
  helpFlights.clear();
  hereActionUntil.clear();
  hereListCooldownUntil.clear();
}

/** Collapse duplicate !help when several bots hear the same channel message. */
const HELP_ACTION_DEDUP_MS = 2500;
/** Cooldown after a *successful* help post (late arrivals skip). */
const helpActionUntil = new Map<string, number>();
/**
 * In-flight help owners. Waiters await `result`; true = posted, false = failed
 * (waiter may become owner). Prevents mid-send duplicates without silencing voice
 * forever when SSH send fails.
 */
type HelpFlight = {
  result: Promise<boolean>;
  settle: (ok: boolean) => void;
};
const helpFlights = new Map<string, HelpFlight>();

function helpActionKey(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  userClid: number,
): string {
  return `${serverConfigId}:${virtualServerId}:${channelId}:${userClid}`;
}

/**
 * Become help owner, or wait for the current owner.
 * @returns true if this caller should post help; false if another path already posted.
 */
async function beginHelpAction(key: string): Promise<boolean> {
  for (;;) {
    const until = helpActionUntil.get(key) ?? 0;
    if (Date.now() < until) return false;

    const flight = helpFlights.get(key);
    if (flight) {
      const ok = await flight.result;
      if (ok) return false;
      // Owner failed — loop and try to claim.
      continue;
    }

    let settle!: (ok: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const entry: HelpFlight = { result, settle };
    helpFlights.set(key, entry);
    // Single-threaded: we own the slot we just created.
    if (helpFlights.get(key) === entry) return true;
  }
}

/** Finish an in-flight help attempt. `posted` true keeps a short success cooldown. */
function completeHelpAction(key: string, posted: boolean): void {
  if (posted) {
    helpActionUntil.set(key, Date.now() + HELP_ACTION_DEDUP_MS);
  }
  const flight = helpFlights.get(key);
  if (!flight) return;
  helpFlights.delete(key);
  flight.settle(posted);
}

/** Collapse duplicate !here lists when several bots hear the same channel message. */
const HERE_LIST_COOLDOWN_MS = 2000;
const hereListCooldownUntil = new Map<string, number>();

/**
 * One chat line can hit SSH cmd-listener and/or several voice bots in the same
 * channel. Claim the summon/list action once so we do not announce+join twice.
 */
const HERE_ACTION_DEDUP_MS = 1500;
const hereActionUntil = new Map<string, number>();

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
  helpFlights.clear();
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
 * Cross-channel commands use the main EventBridge SSH session as a roaming helper
 * (one Query login that moves into the human's channel) — not N persistent CMD listeners.
 */
export class MusicCommandHandler {
  private registeredBots = new Set<number>();
  private eventBridge: EventBridge | null = null;
  private eventBridgeListening = false;
  private botChannelConfig = new Map<number, BotChannelConfig>();
  private channelToBots = new Map<string, Set<number>>();
  private activeReplyChannel = new Map<string, number>();
  /** Channels the roaming helper recently covered (key: configId:sid) — for mapping only. */
  private autoCommandChannels = new Map<string, number[]>();
  private mainHelperParkTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
  ) {}

  setEventBridge(bridge: EventBridge): void {
    this.eventBridge = bridge;
    if (!this.eventBridgeListening) {
      this.eventBridgeListening = true;
      bridge.on('tsEvent', (configId, sid, eventName, data) => {
        // Park the main SSH helper in the human's channel (no second Query login).
        if (
          (eventName === 'notifycliententerview' || eventName === 'notifyclientmoved') &&
          !data.__cmd_listener_channel_id
        ) {
          const cid = parseInt(
            data.ctid || data.cid || data.client_channel_id || '0',
            10,
          );
          if (cid > 0 && String(data.client_type || '0') !== '1') {
            this.scheduleMainHelperPark(configId, sid, cid);
          }
        }
        if (eventName !== 'notifytextmessage') return;

        // Prefer legacy per-channel CMD markers when BotEngine flows still use them.
        let channelId = parseInt(data.__cmd_listener_channel_id || '0', 10);
        if (channelId <= 0) {
          // Main SSH roaming helper — hears chat only in its parked channel.
          channelId = bridge.getMainHelperChannelId(configId, sid);
        }
        if (channelId <= 0) {
          channelId = parseInt(
            data.target || data.invokerchannelid || data.cid || '0',
            10,
          );
        }
        if (channelId <= 0) {
          const preview = (data.msg || '').slice(0, 40);
          console.log(
            `[MusicCmd] SSH textmessage ignored (no helper channel) ` +
              `(config=${configId} sid=${sid} msg=${JSON.stringify(preview)})`,
          );
          return;
        }
        console.log(
          `[MusicCmd] SSH textmessage config=${configId} sid=${sid} ` +
            `cid=${channelId} clid=${data.invokerid || '?'} msg=${JSON.stringify((data.msg || '').slice(0, 60))}`,
        );
        this.onCrossChannelTextMessage(configId, sid, channelId, data).catch(
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
      console.log(
        `[MusicCmd] Bot ${botId}: empty commandChannelIds — ` +
          `same-channel voice cmds + main SSH roaming helper for cross-channel`,
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

  /**
   * Music no longer opens per-channel CMD SSH listeners (Query flood on bot join).
   * Tear down leftovers from older tips and park the main SSH helper where humans are.
   */
  async syncCommandListenersForPair(configId: number, sid: number): Promise<void> {
    if (!this.eventBridge) {
      console.warn(
        `[MusicCmd] syncCommandListeners skipped ${configId}:${sid}: no eventBridge`,
      );
      return;
    }

    const pairKey = `${configId}:${sid}`;
    const previousAuto = this.autoCommandChannels.get(pairKey) || [];
    this.autoCommandChannels.delete(pairKey);

    const musicOwned = new Set<number>(previousAuto);
    for (const cfg of this.botChannelConfig.values()) {
      if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
      for (const cidStr of cfg.commandChannelIds) {
        const n = parseInt(cidStr, 10);
        if (n > 0) musicOwned.add(n);
      }
    }

    const existing = this.eventBridge.getCommandListenerChannelIds(configId, sid);
    // Empty commandChannelIds used to open occupied helpers — drop all leftovers for
    // this pair. Explicit configs only drop music-owned cids (leave BotEngine flows).
    const hasExplicit = this.pairHasExplicitCommandChannels(configId, sid);
    const toDrop = hasExplicit
      ? existing.filter((cid) => musicOwned.has(cid))
      : existing.slice();
    for (const channelId of toDrop) {
      try {
        await this.eventBridge.disconnectCommandListener(configId, sid, channelId);
      } catch {
        /* ignore */
      }
    }
    if (toDrop.length > 0) {
      console.log(
        `[MusicCmd] Disconnected leftover CMD listeners for ${pairKey}: [${toDrop.join(',')}]`,
      );
    }

    // Park main helper in one occupied human channel so cross-channel cmds work
    // without a second Query login. Voice bots already cover their own homes.
    const occupied = await this.discoverOccupiedCommandChannels(configId, sid);
    if (occupied.length > 0) {
      const parkCid = occupied[0]!;
      const ok = await this.eventBridge.ensureHelperInChannel(configId, sid, parkCid);
      if (ok) {
        this.autoCommandChannels.set(pairKey, [parkCid]);
        this.mapBotsToAutoChannels(configId, sid, [parkCid]);
        console.log(
          `[MusicCmd] Main SSH helper parked in cid=${parkCid} for ${pairKey} ` +
            `(occupied=[${occupied.join(',')}]; no CMD listeners)`,
        );
      }
    } else {
      console.log(
        `[MusicCmd] No human-occupied channel to park helper for ${pairKey} yet ` +
          `(will park on cliententer/move)`,
      );
    }
  }

  private scheduleMainHelperPark(configId: number, sid: number, channelId: number): void {
    if (channelId <= 0) return;
    let hasBots = false;
    for (const [botId, cfg] of this.botChannelConfig) {
      if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
      hasBots = true;
      const bot = this.voiceBotManager.getBot(botId);
      // Voice bot already in that channel — it hears chat; don't fight for the cid.
      if (bot && isBotSummonable(bot) && bot.getCurrentChannelId() === channelId) {
        return;
      }
    }
    if (!hasBots || !this.eventBridge) return;

    const pairKey = `${configId}:${sid}`;
    const prev = this.mainHelperParkTimers.get(pairKey);
    if (prev) clearTimeout(prev);
    this.mainHelperParkTimers.set(
      pairKey,
      setTimeout(() => {
        this.mainHelperParkTimers.delete(pairKey);
        void this.parkMainHelper(configId, sid, channelId).catch((err: any) => {
          console.warn(
            `[MusicCmd] Main helper park ${pairKey} cid=${channelId}: ${err?.message || err}`,
          );
        });
      }, MAIN_HELPER_PARK_DEBOUNCE_MS),
    );
  }

  private async parkMainHelper(
    configId: number,
    sid: number,
    channelId: number,
  ): Promise<void> {
    if (!this.eventBridge || channelId <= 0) return;
    // Re-check voice ownership after debounce.
    for (const [botId, cfg] of this.botChannelConfig) {
      if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
      const bot = this.voiceBotManager.getBot(botId);
      if (bot && isBotSummonable(bot) && bot.getCurrentChannelId() === channelId) {
        return;
      }
    }
    const ok = await this.eventBridge.ensureHelperInChannel(configId, sid, channelId);
    if (!ok) return;
    const pairKey = `${configId}:${sid}`;
    this.autoCommandChannels.set(pairKey, [channelId]);
    this.mapBotsToAutoChannels(configId, sid, [channelId]);
    console.log(
      `[MusicCmd] Main SSH helper listening in cid=${channelId} for ${pairKey}`,
    );
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

  /**
   * Discover channels that currently have human clients (not Query clients, not music bots).
   * Used only to park the single main SSH helper — never to open N listeners.
   */
  private async discoverOccupiedCommandChannels(
    configId: number,
    sid: number,
  ): Promise<number[]> {
    if (!this.eventBridge) return [];
    try {
      const botHomes = new Set<number>();
      for (const [botId, cfg] of this.botChannelConfig) {
        if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
        const bot = this.voiceBotManager.getBot(botId);
        const home = bot?.getCurrentChannelId() || 0;
        if (home > 0) botHomes.add(home);
      }
      const musicClids = this.musicBotClidsOnServer(configId, sid);

      const raw = await this.eventBridge.executeCommand(configId, sid, 'clientlist');
      await this.absorbHomeChannelsFromClientList(configId, sid, raw);

      const { parseQueryResponse } = await import('@ts6/common');
      const humanCids = new Set<number>();
      for (const line of raw.split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('error ')) continue;
        for (const entry of parseQueryResponse(trimmed)) {
          if (String(entry.client_type) === '1') continue; // Query / SSH helpers
          const clid = parseInt(entry.clid || '0', 10);
          if (clid > 0 && musicClids.has(clid)) continue; // parked music bots ≠ human occupancy
          const cid = parseInt(entry.cid || entry.client_channel_id || '0', 10);
          if (cid <= 0 || botHomes.has(cid)) continue;
          humanCids.add(cid);
        }
      }
      return Array.from(humanCids).sort((a, b) => a - b);
    } catch (err: any) {
      console.warn(
        `[MusicCmd] Occupied-channel discovery failed for ${configId}:${sid}: ${err.message}`,
      );
      return [];
    }
  }

  /** When voice left homeCid=0, learn each bot's channel from an SSH clientlist snapshot. */
  private async absorbHomeChannelsFromClientList(
    configId: number,
    sid: number,
    raw: string,
  ): Promise<void> {
    const { parseQueryResponse } = await import('@ts6/common');
    const byClid = new Map<number, number>();
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('error ')) continue;
      for (const entry of parseQueryResponse(trimmed)) {
        const clid = parseInt(entry.clid || '0', 10);
        const cid = parseInt(entry.cid || entry.client_channel_id || '0', 10);
        if (clid > 0 && cid > 0) byClid.set(clid, cid);
      }
    }
    for (const [botId, cfg] of this.botChannelConfig) {
      if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
      const bot = this.voiceBotManager.getBot(botId);
      if (!bot || bot.getCurrentChannelId() > 0) continue;
      const clid = bot.ts3ClientId || 0;
      if (clid <= 0) continue;
      const cid = byClid.get(clid);
      if (
        cid &&
        typeof bot.setCurrentChannelIdIfUnknown === 'function' &&
        bot.setCurrentChannelIdIfUnknown(cid)
      ) {
        console.log(`[MusicCmd] Bot ${botId}: learned homeCid=${cid} from SSH clientlist`);
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
    if (this.registeredBots.has(botId)) {
      console.log(`[MusicCmd] Bot ${botId} already registered for text commands`);
      return;
    }
    this.registeredBots.add(botId);

    bot.on('textMessage', (data: Record<string, string>) => {
      void (async () => {
        let replyCid = bot.getCurrentChannelId();
        if (replyCid <= 0) {
          const hinted = parseInt(
            data.invokerchannelid || data.ctid || data.cid || data.target || '0',
            10,
          );
          if (hinted > 0) {
            replyCid = hinted;
            if (typeof bot.setCurrentChannelIdIfUnknown === 'function') {
              bot.setCurrentChannelIdIfUnknown(hinted);
            }
          } else if (typeof bot.ensureHomeChannelDiscovered === 'function') {
            // Same-channel chat proves presence — learn cid via voice socket, not SSH.
            replyCid = await bot.ensureHomeChannelDiscovered();
          }
        }
        console.log(
          `[MusicCmd] Voice textmessage bot=${botId} clid=${data.invokerid || '?'} ` +
            `homeCid=${bot.getCurrentChannelId()} replyCid=${replyCid || 0} ` +
            `msg=${JSON.stringify((data.msg || '').slice(0, 60))}`,
        );
        await this.onTextMessage(
          botId,
          bot,
          data,
          replyCid > 0 ? replyCid : undefined,
        );
      })().catch((err) => {
        console.error(
          `[MusicCmd] Error processing text message on bot ${botId}: ${err.message}`,
        );
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

  /** Virtual-server pairs that need main SSH for send + roaming helper park. */
  getNeededServerPairs(): string[] {
    const pairs = new Set<string>();
    for (const cfg of this.botChannelConfig.values()) {
      // Main SSH only — music never opens per-channel CMD listeners.
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
    let botIds = this.channelToBots.get(key);
    if (!botIds || botIds.size === 0) {
      // Empty commandChannelIds / pre-map race: fall back to every bot on this pair.
      const fallback = new Set<number>();
      for (const [botId, cfg] of this.botChannelConfig) {
        if (cfg.serverConfigId === configId && cfg.virtualServerId === sid) {
          fallback.add(botId);
        }
      }
      if (fallback.size === 0) {
        console.warn(
          `[MusicCmd] Cross-channel text in cid=${channelId} but no bots mapped ` +
            `(config=${configId} sid=${sid}); msg=${JSON.stringify((data.msg || '').slice(0, 40))}`,
        );
        return;
      }
      botIds = fallback;
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

  /**
   * Music never opens per-channel CMD SSH listeners (Query 524 flood).
   * Cross-channel receive uses the single main EventBridge helper parked via
   * ensureHelperInChannel; BotEngine must not merge music cids into needed listeners.
   */
  getNeededCommandChannelIds(_configId: number, _sid: number): number[] {
    return [];
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
          case 'commands':
            await this.handleCustomCommandsList(botId, bot, userClid);
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

  private replyChannelForDedupe(botId: number, userClid: number, bot: VoiceBot): number {
    const active = this.activeReplyChannel.get(`${botId}:${userClid}`);
    if (active && active > 0) return active;
    const home = bot.getCurrentChannelId();
    if (home > 0) return home;
    const cfg = this.botChannelConfig.get(botId);
    return parseInt(cfg?.defaultChannel || '0', 10) || 0;
  }

  private virtualServerIdForBot(botId: number): number {
    return this.botChannelConfig.get(botId)?.virtualServerId ?? 1;
  }

  private async handleCustomCommandsList(
    botId: number,
    bot: VoiceBot,
    userClid: number,
  ): Promise<void> {
    const dbBot = await this.prisma.musicBot.findUnique({
      where: { id: botId },
      select: { serverConfigId: true },
    });
    if (!dbBot) return;
    const channelId = this.replyChannelForDedupe(botId, userClid, bot);
    const sid = this.virtualServerIdForBot(botId);
    if (!tryClaimChatInfoReply(dbBot.serverConfigId, sid, channelId, userClid, 'commands')) return;
    const custom = await this.prisma.chatCommand.findMany({
      where: { serverConfigId: dbBot.serverConfigId, enabled: true },
      orderBy: { name: 'asc' },
      select: { name: true, description: true },
    });
    await this.reply(bot, userClid, formatCustomCommandsMessage(custom));
  }

  private async handleHelp(botId: number, bot: VoiceBot, userClid: number): Promise<void> {
    const cfg = this.botChannelConfig.get(botId);
    const serverConfigId = cfg?.serverConfigId ?? bot.currentConfig.serverConfigId;
    const virtualServerId = cfg?.virtualServerId ?? 1;
    const hinted =
      this.activeReplyChannel.get(`${botId}:${userClid}`) ||
      bot.getCurrentChannelId() ||
      0;

    // When the channel is already known, join the wait-for-owner flight before any
    // await so we either own the post or wait for SSH / another bot's outcome.
    let ownedKey: string | null = null;
    if (hinted > 0) {
      ownedKey = helpActionKey(serverConfigId, virtualServerId, hinted, userClid);
      if (!(await beginHelpAction(ownedKey))) {
        console.log(
          `[MusicCmd] !help deduped (bot=${botId} cid=${hinted} clid=${userClid})`,
        );
        return;
      }
    }

    const channelId = await this.resolveCommandChannelId(
      botId,
      bot,
      userClid,
      hinted > 0 ? hinted : undefined,
    );

    if (channelId > 0) {
      this.activeReplyChannel.set(`${botId}:${userClid}`, channelId);
    }

    // Do not own with cid=0 — that key never matches the SSH helper's parked
    // cid, so voice + cross-channel both post. Align with !here: resolve first; if
    // still unknown, only leave it to SSH when the main helper is parked there
    // (main SSH connected ≠ helper will answer after empty-commandChannelIds).
    if (channelId <= 0) {
      if (ownedKey) completeHelpAction(ownedKey, false);
      console.warn(
        `[MusicCmd] !help skipped on voice bot=${botId}: unknown channel (homeCid=${bot.getCurrentChannelId()})`,
      );
      if (this.sshHelperOwnsChannel(serverConfigId, virtualServerId, channelId)) return;
      // Pure voice, SSH down, or helper not parked for this channel: own cid=0.
    }

    const helpKey = helpActionKey(
      serverConfigId,
      virtualServerId,
      channelId > 0 ? channelId : 0,
      userClid,
    );
    if (ownedKey && ownedKey !== helpKey) {
      completeHelpAction(ownedKey, false);
      ownedKey = null;
    }
    if (!ownedKey) {
      if (!(await beginHelpAction(helpKey))) {
        console.log(
          `[MusicCmd] !help deduped (bot=${botId} cid=${channelId || 0} clid=${userClid})`,
        );
        return;
      }
      ownedKey = helpKey;
    }

    try {
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

      await this.reply(bot, userClid, formatHelpMessage(BUILTIN_COMMAND_HELP, custom));
      completeHelpAction(ownedKey, true);
    } catch (err) {
      completeHelpAction(ownedKey, false);
      throw err;
    }
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
    // Own immediately so concurrent voice waits on our result instead of bailing.
    // completeHelpAction(false) lets that waiter become owner and still reply.
    if (!(await beginHelpAction(helpKey))) {
      console.log(
        `[MusicCmd] Cross-channel !help deduped (cid=${channelId} clid=${userClid})`,
      );
      return;
    }

    let posted = false;
    try {
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
      posted = true;
    } catch (err: any) {
      console.warn(
        `[MusicCmd] Cross-channel !help threw for cid=${channelId}: ${err?.message || err}`,
      );
    } finally {
      // Always settle so waiters are not stuck if sendChannelText throws.
      completeHelpAction(helpKey, posted);
    }
  }

  private async handleCustomCommand(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    command: string,
  ): Promise<void> {
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

    const channelId = this.replyChannelForDedupe(botId, userClid, bot);
    const sid = this.virtualServerIdForBot(botId);
    if (!tryClaimChatInfoReply(dbBot.serverConfigId, sid, channelId, userClid, command)) return;
    console.log(`[MusicCmd] Bot ${botId}: !${command} (custom, from clid=${userClid})`);
    await this.reply(bot, userClid, custom.response);
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
   * the voice client's peer set. Unknown homeCid → try learn from clientlist; if still
   * unknown, treat as idle so bare !here does not falsely report "all busy".
   */
  private async isBotIdleForSummon(
    bot: VoiceBot,
    serverConfigId: number,
    virtualServerId: number,
  ): Promise<boolean> {
    let homeCid = bot.getCurrentChannelId();
    if (homeCid <= 0 && this.eventBridge) {
      try {
        const raw = await this.eventBridge.executeCommand(
          serverConfigId,
          virtualServerId,
          'clientlist',
        );
        await this.absorbHomeChannelsFromClientList(serverConfigId, virtualServerId, raw);
        homeCid = bot.getCurrentChannelId();
      } catch {
        /* flood / timeout — fall through */
      }
    }
    if (homeCid <= 0) return true;

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
        return true;
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
   * True when the main EventBridge SSH helper is parked in this cid.
   * Connected main SSH alone is not enough — it only hears chat where it sits.
   */
  private sshHelperOwnsChannel(configId: number, sid: number, channelId: number): boolean {
    if (channelId <= 0 || !this.eventBridge) return false;
    if (!this.eventBridge.isConnected(configId, sid)) return false;
    try {
      return this.eventBridge.getMainHelperChannelId(configId, sid) === channelId;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the channel the user typed in.
   * Order: hint → voice home → voice ensureHome (no SSH) → SSH invoker clientlist.
   */
  private async resolveCommandChannelId(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    hintChannelId?: number,
  ): Promise<number> {
    if (hintChannelId && hintChannelId > 0) return hintChannelId;

    const homeBefore = bot.getCurrentChannelId();
    if (homeBefore > 0) return homeBefore;

    if (typeof bot.ensureHomeChannelDiscovered === 'function') {
      const voiceHome = await bot.ensureHomeChannelDiscovered();
      if (voiceHome > 0) return voiceHome;
    }

    const cfg = this.botChannelConfig.get(botId);
    if (!cfg || !this.eventBridge || userClid <= 0) return bot.getCurrentChannelId() || 0;

    try {
      const raw = await this.eventBridge.executeCommand(
        cfg.serverConfigId,
        cfg.virtualServerId,
        'clientlist',
      );
      // Learn bot homes for later idle/summon checks, but for THIS message prefer the
      // invoker channel — absorb must not turn a homeCid=0 voice path into "reply at bot home".
      await this.absorbHomeChannelsFromClientList(
        cfg.serverConfigId,
        cfg.virtualServerId,
        raw,
      );

      const { parseQueryResponse } = await import('@ts6/common');
      for (const line of raw.split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('error ')) continue;
        for (const entry of parseQueryResponse(trimmed)) {
          const clid = parseInt(entry.clid || '0', 10);
          if (clid !== userClid) continue;
          const cid = parseInt(entry.cid || entry.client_channel_id || '0', 10);
          if (cid > 0) return cid;
        }
      }
    } catch (err: any) {
      console.warn(
        `[MusicCmd] Invoker channel lookup failed for bot=${botId} clid=${userClid}: ${err.message}`,
      );
    }
    return bot.getCurrentChannelId() || 0;
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
    // Soft notice unless the main helper is parked in this channel (connected
    // main SSH alone is not enough — need ensureHelperInChannel park).
    if (channelId <= 0) {
      console.warn(
        `[MusicCmd] !here skipped on voice bot=${botId}: unknown channel (homeCid=${bot.getCurrentChannelId()})`,
      );
      if (this.sshHelperOwnsChannel(serverConfigId, virtualServerId, channelId)) return;
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
