import { EventEmitter } from 'events';
import { readBotAvatar, type BotAvatarMode } from '../utils/bot-avatar-storage.js';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { WebSocketServer } from 'ws';
import { broadcastScoped } from '../ws/ws-session.js';
import { VoiceBot, type VoiceBotConfig, type VoiceBotStatus, type VideoStreamStartOptions } from './voice-bot.js';
import type { MediaSessionInfo, MediaStopInfo } from '@ts6/common';
import { MediaSessionConflictError } from './media-session.js';
import { generateIdentity, generateIdentityAsync, restoreIdentity, type IdentityData } from './tslib/index.js';
import type { QueueItem } from './playlist/queue.js';
import type { MusicCommandHandler } from './music-command-handler.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { sweepStreamTempFiles } from './streaming/video-download.js';
import { loadMaxVideoDuration, loadVideoStreamingSettings, loadYoutubeDirectStream } from '../utils/app-settings.js';
import { serializeCommandChannelIds } from './music-command-channels.js';
import { reconnectAttemptBusy, type ReconnectAttemptState } from './reconnect-state.js';
import { parseAutoStopEmptySeconds } from './streaming/lifecycle.js';
import { VideoQueueController, type VideoQueueItem, type VideoQueueSessionOptions } from './streaming/video-queue.js';
import { createVideoQueueStore } from './streaming/video-queue-store.js';

type SavedVideoQueue = { items: VideoQueueItem[]; options: VideoQueueSessionOptions | null };

const PROGRESS_INTERVAL_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 30000;
const RECONNECT_GRACE_PERIOD_MS = 5000;

/**
 * Security level of the identity a new bot gets until the level-23 one is
 * ready. A TeamSpeak server refuses anything below its required level (8 by
 * default) with "error id=519 could not validate client identity", which the
 * client only sees as a 15 s connection timeout: a bot started right after it
 * was created failed once and came up on the reconnect. Level 8 takes a few
 * milliseconds to generate, so the placeholder can afford it.
 */
export const PLACEHOLDER_IDENTITY_LEVEL = 8;

export class VoiceBotManager extends EventEmitter {
  private bots = new Map<number, VoiceBot>();
  private botServerConfigIds = new Map<number, number>();
  private progressTimers = new Map<number, ReturnType<typeof setInterval>>();
  private reconnectState = new Map<number, ReconnectAttemptState>();
  /** In-flight security-level-23 identity jobs keyed by bot id (create returns before these finish). */
  private identityJobs = new Map<number, Promise<void>>();
  private musicCmdHandler: MusicCommandHandler | null = null;
  /** Each bot's video lane (queued videos), kept for the bot's lifetime. */
  private videoQueues = new Map<number, VideoQueueController>();

  constructor(
    private prisma: PrismaClient,
    private wss: WebSocketServer,
  ) {
    super();
  }

  setMusicCommandHandler(handler: MusicCommandHandler): void {
    this.musicCmdHandler = handler;
    // Register all existing bots
    for (const [id, bot] of this.bots) {
      handler.registerBot(id, bot);
    }
  }

  async refreshMusicCommandChannels(botId: number): Promise<void> {
    if (this.musicCmdHandler) {
      await this.musicCmdHandler.refreshBotChannels(botId);
    }
  }

  async start(): Promise<void> {
    sweepStreamTempFiles();
    const maxVideoDurationSec = await loadMaxVideoDuration(this.prisma);
    const parsedAutoStop = parseAutoStopEmptySeconds(process.env.BOT_AUTO_STOP_EMPTY_SECONDS);

    const dbBots = await this.prisma.musicBot.findMany({
      include: { serverConfig: true },
    });

    console.log(`[VoiceBotManager] Loading ${dbBots.length} music bot(s)...`);
    const savedVideoQueues = await Promise.all(dbBots.map((dbBot) => this.loadVideoQueue(dbBot.id)));

    for (const [i, dbBot] of dbBots.entries()) {
      let identity: IdentityData | undefined;
      if (dbBot.identityData) {
        // H8: Decrypt identity data before parsing
        const parsed = JSON.parse(decrypt(dbBot.identityData));
        // Reconstruct KeyObjects from serialized scalar data
        identity = restoreIdentity(parsed);
      }
      const config: VoiceBotConfig = {
        id: dbBot.id,
        serverConfigId: dbBot.serverConfigId,
        name: dbBot.name,
        serverHost: dbBot.serverConfig.host,
        serverPort: dbBot.voicePort ?? 9987,
        nickname: dbBot.nickname,
        serverPassword: dbBot.serverPassword ?? undefined,
        defaultChannel: dbBot.defaultChannel ?? undefined,
        channelPassword: dbBot.channelPassword ?? undefined,
        volume: dbBot.volume,
        avatarMode: dbBot.avatarMode as BotAvatarMode,
        avatarFile: dbBot.avatarFile,
        avatarMd5: dbBot.avatarMd5,
        identity,
        sidecarBinaryPath: process.env.SIDECAR_BINARY_PATH,
        sidecarPort: (dbBot as any).sidecarPort ?? 9800,
        streamPreset: (dbBot as any).streamPreset ?? '720p',
        maxVideoDurationSec,
        autoStopEmptySeconds: parsedAutoStop,
      };

      const bot = this.createBotInstance(config, savedVideoQueues[i]);
      this.bots.set(dbBot.id, bot);
      this.botServerConfigIds.set(dbBot.id, dbBot.serverConfigId);

      if (dbBot.autoStart) {
        bot.start().catch((err) => {
          console.error(`[VoiceBotManager] Auto-start failed for bot ${dbBot.id}: ${err.message}`);
        });
      }
    }
  }

  /** A saved lane comes back as kept items; nothing starts until an admin plays it. */
  private async loadVideoQueue(botId: number): Promise<SavedVideoQueue | undefined> {
    try {
      return await createVideoQueueStore(this.prisma, botId).load();
    } catch (err: any) {
      console.error(`[VoiceBotManager] Could not load the video queue for bot ${botId}: ${err?.message || err}`);
      return undefined;
    }
  }

  private createBotInstance(config: VoiceBotConfig, savedVideoQueue?: SavedVideoQueue): VoiceBot {
    // The bot's config needs the queue's hook and the queue needs the bot.
    let videoQueue: VideoQueueController | undefined;
    // Streaming defaults are read when a stream starts, so admin changes apply
    // to the next stream without restarting bots.
    const bot = new VoiceBot({
      ...config,
      loadVideoSettings: config.loadVideoSettings
        ?? (() => loadVideoStreamingSettings(this.prisma, config.serverConfigId)),
      loadYoutubeDirectStream: config.loadYoutubeDirectStream
        ?? (() => loadYoutubeDirectStream(this.prisma)),
      videoSourceFinished: async (reason, detail) => videoQueue?.onSourceFinished(reason, detail) ?? false,
    });

    videoQueue = new VideoQueueController(
      {
        bot,
        start: (source, options) => this.startVideoStream(bot, source, options),
        store: createVideoQueueStore(this.prisma, config.id),
        onChange: (state) => this.broadcast('music:bot:videoQueueChanged', { botId: config.id, state }),
      },
      savedVideoQueue,
    );
    this.videoQueues.set(config.id, videoQueue);
    const queue = videoQueue;

    bot.on('statusChange', (status: VoiceBotStatus) => {
      this.broadcast('music:bot:status', { botId: config.id, status });

      if (status === 'playing') {
        this.startProgressBroadcast(config.id);
      } else {
        this.stopProgressBroadcast(config.id);
      }
    });

    bot.on('error', (err: Error) => {
      console.error(`[VoiceBotManager] Bot ${config.id} error: ${err.message}`);
    });

    bot.on('avatarChange', (data) => this.broadcast('music:bot:avatar', { botId: config.id, ...data }));

    bot.on('nowPlaying', (item: QueueItem) => {
      const progress = bot.playbackProgress;
      this.broadcast('music:bot:nowPlaying', {
        botId: config.id,
        song: { id: item.id, title: item.title, artist: item.artist, duration: item.duration, source: item.source },
        progress: progress ? { position: progress.position, duration: progress.duration } : null,
      });
    });

    bot.on(
      'mediaCached',
      (payload: {
        songId: string;
        filePath: string;
        fileSize?: number;
        title?: string;
        artist?: string;
        duration?: number;
      }) => {
        const songId = parseInt(payload.songId, 10);
        if (!Number.isFinite(songId)) return;
        this.prisma.song
          .update({
            where: { id: songId },
            data: {
              filePath: payload.filePath,
              ...(payload.fileSize != null ? { fileSize: payload.fileSize } : {}),
              ...(payload.title ? { title: payload.title } : {}),
              ...(payload.artist ? { artist: payload.artist } : {}),
              ...(payload.duration != null ? { duration: payload.duration } : {}),
            },
          })
          .catch((err: Error) => {
            console.error(
              `[VoiceBotManager] Failed to persist cached media for song ${songId}: ${err.message}`,
            );
          });
      },
    );

    bot.on('trackEnd', (item: QueueItem | null) => {
      this.broadcast('music:bot:trackEnd', { botId: config.id, songId: item?.id ?? null });
    });

    bot.on('volumeChange', (volume: number) => {
      this.broadcast('music:bot:volumeChange', { botId: config.id, volume });
    });

    bot.on('metadataChange', (item: QueueItem) => {
      this.broadcast('music:bot:nowPlaying', {
        botId: config.id,
        song: { id: item.id, title: item.title, artist: item.artist, duration: item.duration, source: item.source },
        progress: null,
      });
    });

    bot.on('disconnected', async () => {
      // A stream cannot outlive the connection: release the sidecar source and
      // timers before reconnecting. The video queue keeps its items.
      if (bot.videoStreaming) {
        try {
          await bot.stopVideoStream('server_disconnect', 'Disconnected from the TeamSpeak server');
        } catch (err: any) {
          console.error(`[VoiceBotManager] Bot ${config.id}: could not stop the video stream after a disconnect: ${err?.message || err}`);
        }
      }
      if (!bot.manuallyStopped) {
        console.log(`[VoiceBotManager] Bot ${config.id}: unexpected disconnect, scheduling reconnect`);
        this.scheduleReconnect(config.id);
      }
    });

    // A confirmed switch stopped one of this bot's sessions (media audit listens).
    bot.on('mediaSessionReplaced', (session: MediaSessionInfo) => {
      this.emit('mediaSessionReplaced', session);
    });

    // Video streaming events
    bot.on('videoStreamStarted', (data: any) => {
      this.broadcast('music:bot:videoStreamStarted', { botId: config.id, ...data });
    });

    bot.on('videoStreamStopped', (lastStop?: MediaStopInfo | null) => {
      this.broadcast('music:bot:videoStreamStopped', { botId: config.id, lastStop: lastStop ?? null });
      queue.onStreamStopped(lastStop ?? null).catch((err: Error) => {
        console.error(`[VoiceBotManager] Bot ${config.id}: video queue stop handling failed: ${err.message}`);
      });
    });

    bot.on('videoViewerJoined', (viewer: any) => {
      this.broadcast('music:bot:videoViewerJoined', { botId: config.id, viewer });
    });

    bot.on('videoViewerLeft', (clid: number) => {
      this.broadcast('music:bot:videoViewerLeft', { botId: config.id, clid });
    });

    bot.on('videoSourceChanged', (source: string) => {
      this.broadcast('music:bot:videoSourceChanged', { botId: config.id, source });
    });

    bot.on('fatalError', (msg: string) => {
      console.error(`[VoiceBotManager] Bot ${config.id}: fatal error — ${msg}. No reconnect.`);
      this.clearReconnect(config.id);
      this.broadcast('music:bot:error', { botId: config.id, error: msg });
    });

    // Register for music text commands
    if (this.musicCmdHandler) {
      this.musicCmdHandler.registerBot(config.id, bot);
    }

    return bot;
  }

  async createBot(data: {
    name: string;
    serverConfigId: number;
    nickname?: string;
    serverPassword?: string;
    defaultChannel?: string;
    channelPassword?: string;
    commandChannelIds?: string[];
    virtualServerId?: number;
    voicePort?: number;
    volume?: number;
    autoStart?: boolean;
    avatarMode?: BotAvatarMode;
  }): Promise<{ id: number }> {
    // Enforce bot limit
    const limitSetting = await this.prisma.appSetting.findUnique({ where: { key: 'max_music_bots' } });
    const limit = parseInt(limitSetting?.value ?? '10') || 10;
    const currentCount = await this.prisma.musicBot.count();
    if (currentCount >= limit) {
      throw new Error(`Music bot limit reached (${limit}). Adjust the limit in Settings.`);
    }

    // Get server config for host
    const serverConfig = await this.prisma.tsServerConfig.findUnique({ where: { id: data.serverConfigId } });
    if (!serverConfig) throw new Error('Server config not found');

    // Fast placeholder identity. Level-23 upgrade runs in the background so create
    // can return 201 before the cold ~5–30s keygen that was causing proxy/client
    // 499 on first create.
    const quickIdentity = generateIdentity(PLACEHOLDER_IDENTITY_LEVEL);
    const quickIdentityData = encrypt(JSON.stringify(quickIdentity, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ));

    const avatarMode = data.avatarMode ?? 'none';
    const avatarImage = avatarMode === 'default' ? await readBotAvatar({ id: 1, avatarMode }) : null;
    const avatarMd5 = avatarImage ? createHash('md5').update(avatarImage).digest('hex') : null;
    const dbBot = await this.prisma.musicBot.create({
      data: {
        name: data.name,
        serverConfigId: data.serverConfigId,
        nickname: data.nickname ?? 'MediaBot',
        serverPassword: data.serverPassword,
        defaultChannel: data.defaultChannel,
        channelPassword: data.channelPassword,
        commandChannelIds: serializeCommandChannelIds(data.commandChannelIds ?? []),
        virtualServerId: data.virtualServerId ?? 1,
        voicePort: data.voicePort ?? 9987,
        volume: data.volume ?? 50,
        autoStart: data.autoStart ?? false,
        avatarMode,
        avatarMd5,
        identityData: quickIdentityData,
      },
    });

    const config: VoiceBotConfig = {
      id: dbBot.id,
      serverConfigId: data.serverConfigId,
      name: dbBot.name,
      serverHost: serverConfig.host,
      serverPort: dbBot.voicePort ?? 9987,
      nickname: dbBot.nickname,
      serverPassword: dbBot.serverPassword ?? undefined,
      defaultChannel: dbBot.defaultChannel ?? undefined,
      channelPassword: dbBot.channelPassword ?? undefined,
      volume: dbBot.volume,
      avatarMode,
      avatarMd5,
      identity: quickIdentity,
      sidecarBinaryPath: process.env.SIDECAR_BINARY_PATH,
      sidecarPort: 9800,
      streamPreset: '720p',
      maxVideoDurationSec: await loadMaxVideoDuration(this.prisma),
      autoStopEmptySeconds: parseAutoStopEmptySeconds(process.env.BOT_AUTO_STOP_EMPTY_SECONDS),
    };

    const bot = this.createBotInstance(config);
    this.bots.set(dbBot.id, bot);
    this.botServerConfigIds.set(dbBot.id, dbBot.serverConfigId);

    this.scheduleIdentityUpgrade(dbBot.id, bot);

    // Do not await SSH listener sync on the create HTTP path.
    if (this.musicCmdHandler) {
      void this.musicCmdHandler.refreshBotChannels(dbBot.id).catch((err: any) => {
        console.warn(
          `[VoiceBotManager] Background command-channel refresh after create ${dbBot.id}: ${err?.message || err}`,
        );
      });
    }

    return { id: dbBot.id };
  }

  /**
   * Upgrade placeholder identity to security level 23 off the HTTP path.
   * Only attaches to the in-memory bot while it is still stopped — a running
   * connection already used the placeholder keys.
   */
  private scheduleIdentityUpgrade(botId: number, bot: VoiceBot): void {
    const job = (async () => {
      try {
        const identity = await generateIdentityAsync(23);
        const identityData = encrypt(JSON.stringify(identity, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        ));
        await this.prisma.musicBot.update({
          where: { id: botId },
          data: { identityData },
        });
        // Always refresh config.identity for the next start(); setIdentity keeps
        // the live connection keys if the bot is already running.
        bot.setIdentity(identity);
        console.log(`[VoiceBotManager] Identity upgraded to level 23 for bot ${botId}`);
      } catch (err: any) {
        console.warn(
          `[VoiceBotManager] Background identity upgrade for bot ${botId}: ${err?.message || err}`,
        );
      } finally {
        this.identityJobs.delete(botId);
      }
    })();
    this.identityJobs.set(botId, job);
  }

  /** Serializes the check-and-claim part of video starts across bots. */
  private videoClaimLock: Promise<void> = Promise.resolve();

  /** Every bot's active media session (cheap: no sidecar or TeamSpeak calls). */
  listMediaSessions(): MediaSessionInfo[] {
    const sessions: MediaSessionInfo[] = [];
    for (const bot of this.bots.values()) {
      const session = bot.mediaSession;
      if (session) sessions.push(session);
    }
    return sessions;
  }

  /**
   * Throw MediaSessionConflictError unless every session a video start on
   * `bot` would replace is confirmed. Returns the other bots whose video will
   * be replaced. Synchronous, so routes can check before auditing.
   */
  assertVideoCanStart(bot: VoiceBot, replaceSessionIds: string[] = []): VoiceBot[] {
    const confirmed = new Set(replaceSessionIds);
    const otherVideo = [...this.bots.values()]
      .filter((b) => b !== bot)
      .map((b) => ({ bot: b, session: b.videoSessionInfo() }))
      .filter((x): x is { bot: VoiceBot; session: MediaSessionInfo } => x.session != null);
    const ownMusic = bot.musicSessionInfo();
    const conflicts = [...otherVideo.map((x) => x.session), ...(ownMusic ? [ownMusic] : [])];
    if (conflicts.some((c) => c.state === 'starting' || !confirmed.has(c.id))) {
      throw new MediaSessionConflictError('video', conflicts);
    }
    return otherVideo.map((x) => x.bot);
  }

  /**
   * Start video on `bot` under the single-session rules: only one video stream
   * runs at a time (the sidecar is shared) and a bot never plays music and video
   * together. Any session that would be replaced must be named in
   * `replaceSessionIds`; otherwise this throws MediaSessionConflictError listing
   * every conflict so one confirmation covers them all.
   *
   * Returns the sessions actually replaced under `videoClaimLock` (other bots'
   * video and this bot's music), so callers can audit stops without a stale
   * pre-dispatch snapshot. `alreadyRunning` is set when this bot is already
   * streaming the same source with the same settings (idempotent start).
   */
  async startVideoStream(
    bot: VoiceBot,
    source: string,
    options: VideoStreamStartOptions = {},
  ): Promise<{ replaced: MediaSessionInfo[]; alreadyRunning: boolean }> {
    const replaced: MediaSessionInfo[] = [];
    let started!: Promise<{ alreadyRunning: boolean }>;
    const release = this.videoClaimLock;
    let unlock!: () => void;
    this.videoClaimLock = new Promise<void>((resolve) => { unlock = resolve; });
    await release;
    try {
      const otherVideo = this.assertVideoCanStart(bot, options.replaceSessionIds);
      for (const other of otherVideo) {
        const session = other.videoSessionInfo();
        await other.stopVideoStream('replaced_by_video', `Replaced by a stream on ${bot.currentConfig.name}`);
        if (session) {
          replaced.push(session);
          this.emit('mediaSessionReplaced', session);
        }
      }
      const ownMusic = bot.musicSessionInfo();
      if (ownMusic) replaced.push(ownMusic);
      // startVideoStream claims its session synchronously, so the lock can be
      // released before the (possibly long) download and sidecar start.
      started = bot.startVideoStream(source, options);
    } finally {
      unlock();
    }
    const outcome = await started;
    return { replaced: outcome.alreadyRunning ? [] : replaced, alreadyRunning: outcome.alreadyRunning };
  }

  getBot(id: number): VoiceBot | undefined {
    return this.bots.get(id);
  }

  getVideoQueue(botId: number): VideoQueueController | undefined {
    return this.videoQueues.get(botId);
  }

  async removeBot(id: number): Promise<void> {
    this.clearReconnect(id);
    this.stopProgressBroadcast(id);
    this.identityJobs.delete(id);
    this.musicCmdHandler?.unregisterBot(id);

    const bot = this.bots.get(id);
    if (bot) {
      try {
        await bot.stop();
      } catch (err: any) {
        console.warn(`[VoiceBotManager] stop during removeBot ${id}: ${err.message}`);
      }
      bot.ensureDisconnected();
      this.bots.delete(id);
      this.botServerConfigIds.delete(id);
    }
    this.videoQueues.delete(id);
    try {
      await createVideoQueueStore(this.prisma, id).delete();
    } catch (err: any) {
      console.warn(`[VoiceBotManager] Could not delete the video queue of bot ${id}: ${err?.message || err}`);
    }
    await this.prisma.musicBot.delete({ where: { id } });
  }

  async getBotsForServer(configId: number): Promise<Array<{ botId: number; bot: VoiceBot }>> {
    const dbBots = await this.prisma.musicBot.findMany({
      where: { serverConfigId: configId },
      select: { id: true },
    });
    const result: Array<{ botId: number; bot: VoiceBot }> = [];
    for (const db of dbBots) {
      const bot = this.bots.get(db.id);
      if (bot && bot.status !== 'stopped') {
        result.push({ botId: db.id, bot });
      }
    }
    return result;
  }

  listBots(): Array<{ id: number; status: VoiceBotStatus; nowPlaying: QueueItem | null }> {
    const list: Array<{ id: number; status: VoiceBotStatus; nowPlaying: QueueItem | null }> = [];
    for (const [id, bot] of this.bots) {
      list.push({ id, status: bot.status, nowPlaying: bot.nowPlaying });
    }
    return list;
  }

  async startBot(id: number): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Music bot ${id} not found`);
    this.clearReconnect(id);
    // Do not await level-23 upgrade here — create already attached a fast
    // placeholder identity so Start cannot inherit the old create 499 hang.
    await bot.start();
    if (this.musicCmdHandler) {
      await this.musicCmdHandler.refreshBotChannels(id);
    }
  }

  async stopBot(id: number): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Music bot ${id} not found`);
    this.clearReconnect(id);
    await bot.stop();
  }

  async stopAll(): Promise<void> {
    // Clear all reconnect timers first to prevent reconnect during shutdown
    for (const [, state] of this.reconnectState) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.reconnectState.clear();

    const promises: Promise<void>[] = [];
    for (const bot of this.bots.values()) {
      if (bot.status !== 'stopped') {
        promises.push(bot.stop());
      }
    }
    this.progressTimers.forEach((timer) => clearInterval(timer));
    this.progressTimers.clear();
    await Promise.allSettled(promises);
  }

  // --- Auto-reconnect logic ---

  private scheduleReconnect(botId: number): void {
    const bot = this.bots.get(botId);
    if (!bot) return;

    let state = this.reconnectState.get(botId);
    if (!state) {
      state = { attempts: 0, timer: null, inFlight: false };
      this.reconnectState.set(botId, state);
    }

    // Prevent double-scheduling when either a retry timer is pending or an
    // attempt is already awaiting cleanup/start. A disconnect can fire from
    // inside a failed connect(), so timer-only gating is not sufficient.
    if (reconnectAttemptBusy(state)) return;

    if (state.attempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[VoiceBotManager] Bot ${botId}: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
      this.broadcast('music:bot:reconnectFailed', { botId });
      this.reconnectState.delete(botId);
      return;
    }

    const delay = Math.min(Math.pow(2, state.attempts) * 1000, MAX_RECONNECT_DELAY_MS);
    state.attempts++;
    console.log(`[VoiceBotManager] Bot ${botId}: reconnect attempt ${state.attempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s`);

    state.timer = setTimeout(() => this.attemptReconnect(botId), delay);
  }

  private async attemptReconnect(botId: number): Promise<void> {
    const bot = this.bots.get(botId);
    const state = this.reconnectState.get(botId);
    if (!bot || !state) return;

    // Don't reconnect if bot hit a fatal error (wrong password, banned, etc.)
    if (bot.status === 'error') {
      console.log(`[VoiceBotManager] Bot ${botId}: in error state, aborting reconnect`);
      this.reconnectState.delete(botId);
      return;
    }

    state.timer = null;
    state.inFlight = true;

    try {
      // Ensure previous connection is fully cleaned up before reconnecting.
      // This prevents duplicate clients when the TS server restarts.
      bot.ensureDisconnected();
      await new Promise((r) => setTimeout(r, RECONNECT_GRACE_PERIOD_MS));

      // A maintainer may have explicitly stopped/deleted the bot while this
      // attempt was in the grace period. Clearing reconnect state is the
      // cancellation signal; never let an already-running attempt undo it.
      if (this.reconnectState.get(botId) !== state || bot.manuallyStopped) {
        console.log(`[VoiceBotManager] Bot ${botId}: reconnect cancelled during grace period`);
        return;
      }

      await bot.start();
      console.log(`[VoiceBotManager] Bot ${botId}: reconnected successfully after ${state.attempts} attempt(s)`);
      this.reconnectState.delete(botId);
    } catch (err: any) {
      console.error(`[VoiceBotManager] Bot ${botId}: reconnect attempt ${state.attempts} failed: ${err.message}`);
      state.inFlight = false;
      this.scheduleReconnect(botId);
      return;
    }

    state.inFlight = false;
  }

  private clearReconnect(botId: number): void {
    const state = this.reconnectState.get(botId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.reconnectState.delete(botId);
  }

  private startProgressBroadcast(botId: number): void {
    this.stopProgressBroadcast(botId);
    const timer = setInterval(() => {
      const bot = this.bots.get(botId);
      if (!bot || bot.status !== 'playing') {
        this.stopProgressBroadcast(botId);
        return;
      }
      const progress = bot.playbackProgress;
      if (progress) {
        this.broadcast('music:bot:progress', {
          botId,
          position: progress.position,
          duration: progress.duration,
        });
      }
    }, PROGRESS_INTERVAL_MS);
    this.progressTimers.set(botId, timer);
  }

  private stopProgressBroadcast(botId: number): void {
    const timer = this.progressTimers.get(botId);
    if (timer) {
      clearInterval(timer);
      this.progressTimers.delete(botId);
    }
  }

  private broadcast(type: string, payload: any): void {
    const botId = payload.botId as number | undefined;
    const serverConfigId = botId !== undefined
      ? this.botServerConfigIds.get(botId)
      : payload.serverConfigId as number | undefined;
    broadcastScoped(this.wss, type, payload, { serverConfigId });
  }
}
