import { EventEmitter } from 'events';
import fs from 'fs';
import type { Readable } from 'stream';
import { Ts3Client, type Ts3ClientOptions, generateIdentity, type IdentityData, buildCommand } from './tslib/index.js';
import { AudioPipeline, FRAME_MS, BYTES_PER_FRAME } from './audio/pipeline.js';
import { PlayQueue, type QueueItem } from './playlist/queue.js';
import { fetchIcyMetadata } from './audio/icy-metadata.js';
import { downloadYouTube, resolveYouTubeAudioStream, isYouTubeHostUrl } from './audio/youtube.js';
import { StreamSignaling, type ActiveStream, type SignalingMessage } from './streaming/stream-signaling.js';
import type {
  BotMediaOverview,
  MediaSessionInfo,
  MediaStopInfo,
  MediaStopReason,
  VideoEncoderCapabilities,
  VideoEncoderRequest,
  VideoQualityRequest,
  VideoStreamEncoderInfo,
  VideoStreamPresetKey,
  VideoStreamQualityInfo,
  VideoStreamSettings,
  VideoSourceMode,
  VideoSourceModeRequest,
  VideoStreamHealth,
} from '@ts6/common';
import { SidecarClient, type SidecarEncoderSession } from './streaming/sidecar-client.js';
import { SidecarProcess, type SidecarConfig } from './streaming/sidecar-process.js';
import { STREAM_PRESETS, DEFAULT_PRESET, type VideoViewerInfo, type VideoStreamStatus } from './streaming/types.js';
import { downloadVideoForStream, safeUnlinkStreamTemp, resolvePathUnderMusicDir } from './streaming/video-download.js';
import { effectiveBitrate, normalizeQualityRequest, resolveQuality } from './streaming/quality.js';
import {
  ENCODER_CODEC,
  encoderDisplayName,
  isEncoderId,
  isHardwareEncoder,
  normalizeEncoderRequest,
  selectEncoder,
} from './streaming/encoders.js';
import { probeSource } from './streaming/source-probe.js';
import {
  belowRealtimeWarning,
  channelEmptyStopDetail,
  classifyEncoderExit,
  noViewersStopDetail,
  resolveSourceMode,
} from './streaming/lifecycle.js';
import { videoStreamingDefaults } from '../utils/app-settings.js';
import { MediaSessionConflictError, newMediaSessionId, safeSourceLabel } from './media-session.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

export type VoiceBotStatus = 'stopped' | 'starting' | 'connected' | 'playing' | 'paused' | 'error';

export interface PlaybackProgress {
  position: number;  // seconds
  duration: number;  // seconds
}

export interface VoiceBotConfig {
  id: number;
  serverConfigId: number;
  name: string;
  serverHost: string;
  serverPort: number;
  nickname: string;
  serverPassword?: string;
  defaultChannel?: string;
  channelPassword?: string;
  volume: number; // 0-100
  identity?: IdentityData;
  sidecarBinaryPath?: string;
  sidecarPort?: number;
  streamPreset?: string;
  autoStopEmptySeconds?: number;
  maxVideoDurationSec?: number;
  videoStreamVolume?: number;
  /** Loads admin video-streaming defaults when a stream starts (falls back to env defaults). */
  loadVideoSettings?: () => Promise<VideoStreamSettings>;
}

/** Per-stream overrides; anything omitted uses the admin defaults. */
export interface VideoStreamStartOptions {
  preset?: VideoQualityRequest | string;
  encoder?: VideoEncoderRequest | string;
  framerate?: number;
  bitrate?: string;
  volume?: number;
  /** One-session no-viewer timeout (seconds, 0 = off); does not change the saved default. */
  noViewerTimeoutSec?: number;
  /** Media session IDs the caller confirmed may be replaced (see media-session.ts). */
  replaceSessionIds?: string[];
  /** live / vod, or auto (detect when the source is probed). Local files are always `file`. */
  sourceMode?: VideoSourceModeRequest;
}

/** How often a running stream's encode health is sampled from the sidecar. */
const VIDEO_HEALTH_INTERVAL_MS = 10_000;

/** Options for starting music; `replaceSessionIds` confirms stopping this bot's video. */
export interface MusicStartOptions {
  replaceSessionIds?: string[];
}

export class VoiceBot extends EventEmitter {
  private client: Ts3Client;
  private pipeline: AudioPipeline;
  readonly queue: PlayQueue;
  private config: VoiceBotConfig;
  private _status: VoiceBotStatus = 'stopped';
  private _lastError: string = '';
  private identity: IdentityData | null = null;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private _nowPlaying: QueueItem | null = null;

  // Local files are decoded incrementally through ffmpeg instead of buffering
  // the entire PCM track in memory before playback starts.
  private fileStdout: Readable | null = null;
  private fileFramesSent = 0;
  private fileBaseSeconds = 0;
  private _fileStreamActive = false;
  private fileFfmpegEnded = false;
  private fileNextDue = 0;
  private fileStreamStartEpoch = 0;
  private loopEpoch = 0;

  private lastVoiceSendAt = 0;       // performance.now() timestamp
  private lastVoiceLogAt = 0;        // rate limit logs

  private statWindowStart = 0;
  private statCount = 0;
  private statDtSum = 0;
  private statDtMin = Number.POSITIVE_INFINITY;
  private statDtMax = 0;

  // Streaming state (radio)
  private _isStreaming: boolean = false;
  private streamKill: (() => void) | null = null;
  private streamChunks: Buffer[] = [];
  private streamChunksSize: number = 0;
  private streamStartTime: number = 0;

  // Nickname "now playing" state
  private _originalNickname: string;

  // ICY metadata polling (radio)
  private icyPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStreamTitle: string = '';

  // Reconnect: distinguishes manual stop from unexpected disconnect
  private _manuallyStopped: boolean = false;

  // Video streaming state
  private signaling: StreamSignaling | null = null;
  private sidecarProc: SidecarProcess | null = null;
  private sidecarHttp: SidecarClient | null = null;
  private _videoStreaming: boolean = false;
  private _activeStreamId: string | null = null;
  private _videoSource: string | null = null;
  private _videoPreset: VideoStreamPresetKey = DEFAULT_PRESET;
  private _videoFramerate: number = STREAM_PRESETS[DEFAULT_PRESET].framerate;
  private _videoBitrate: string = STREAM_PRESETS[DEFAULT_PRESET].bitrate;
  private _videoRequestedFramerate: number | null = null;
  private _videoRequestedBitrate: string | null = null;
  private _videoSettings: VideoStreamSettings = videoStreamingDefaults();
  private _videoQuality: VideoStreamQualityInfo | null = null;
  private _videoEncoder: VideoStreamEncoderInfo | null = null;
  private _videoStopping = false;
  private _lastVideoStop: MediaStopInfo | null = null;
  private _noViewerTimeoutSec = 0;
  private _noViewerTimer: ReturnType<typeof setTimeout> | null = null;
  private _noViewerStopAt: number | null = null;
  private _videoSessionId: string | null = null;
  private _videoSourceModeRequest: VideoSourceModeRequest = 'auto';
  private _videoSourceMode: VideoSourceMode | null = null;
  private _videoLoop = false;
  private _videoHealth: VideoStreamHealth | null = null;
  private _videoHealthTimer: ReturnType<typeof setInterval> | null = null;
  private _videoHealthPolling = false;
  private _videoStarting = false;
  private _musicSessionId: string | null = null;
  private _musicStartedAt: number | null = null;
  private _lastMusicStop: MediaStopInfo | null = null;
  private _videoStartedAt: number | null = null;
  private _viewers: Map<number, VideoViewerInfo> = new Map();
  private _videoTempFile: string | null = null;
  private _videoEndTimer: ReturnType<typeof setTimeout> | null = null;
  private _videoDurationSec: number | null = null;
  private _videoStreamVolume: number = 100;
  private autoStopTimer: ReturnType<typeof setInterval> | null = null;
  private autoStopEmptySince: number | null = null;

  constructor(config: VoiceBotConfig) {
    super();
    this.config = config;
    this._originalNickname = config.nickname;
    this._videoStreamVolume = config.videoStreamVolume ?? 100;
    this.client = new Ts3Client();
    this.pipeline = new AudioPipeline();
    this.queue = new PlayQueue();

    this.client.on('error', (err) => {
      this._status = 'error';
      this.emit('error', err);
      this.emit('statusChange', this._status);
    });

    this.client.on('disconnected', () => {
      this.stopIcyPolling();
      this.stopPlayback();
      this._status = 'stopped';
      this._nowPlaying = null;
      this.emit('statusChange', this._status);
      this.emit('disconnected');
    });

    this.client.on('ts3error', (params: Record<string, string>) => {
      const id = parseInt(params.id || '0');
      const msg = params.msg || 'unknown error';
      this._lastError = `TS3 error ${id}: ${msg}`;
      // Fatal errors that should not trigger reconnect
      // 3329 = banned, 1796 = max clients reached
      // 2568 = insufficient client permissions — operation-level, not fatal
      if (id === 3329 || id === 1796) {
        this._status = 'error';
        this.emit('statusChange', this._status);
        this.emit('fatalError', this._lastError);
      }
    });

    this.client.on('command', (cmd) => {
      this.emit('command', cmd);
    });

    this.client.on('textMessage', (data: Record<string, string>) => {
      this.emit('textMessage', data);
    });
  }

  get id(): number {
    return this.config.id;
  }

  get status(): VoiceBotStatus {
    return this._status;
  }

  get nowPlaying(): QueueItem | null {
    return this._nowPlaying;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get manuallyStopped(): boolean {
    return this._manuallyStopped;
  }

  get playbackProgress(): PlaybackProgress | null {
    if (!this._nowPlaying) return null;
    if (this._isStreaming) {
      return {
        position: (Date.now() - this.streamStartTime) / 1000,
        duration: 0, // Live stream — no known duration
      };
    }
    if (!this._fileStreamActive) return null;
    return {
      position: this.fileBaseSeconds + (this.fileFramesSent * FRAME_MS) / 1000,
      duration: this._nowPlaying.duration ?? 0,
    };
  }

  get lastError(): string {
    return this._lastError;
  }

  get ts3ClientId(): number {
    return this.client.getClientId();
  }

  getCurrentChannelId(): number {
    return this.client.getCurrentChannelId();
  }

  getCurrentChannelName(): string | null {
    const cid = this.client.getCurrentChannelId();
    return cid > 0 ? this.client.getChannelName(cid) : null;
  }

  /** Apply home cid from SSH clientlist when voice discovery left homeCid=0. */
  setCurrentChannelIdIfUnknown(channelId: number): boolean {
    return this.client.setCurrentChannelIdIfUnknown(channelId);
  }

  /** Discover home cid via the voice socket (no SSH). */
  ensureHomeChannelDiscovered(timeoutMs?: number): Promise<number> {
    return this.client.ensureHomeChannelDiscovered(timeoutMs);
  }

  /** Other non-query voice clients currently in this bot's channel (excludes the bot itself). */
  getHumanChannelPeerCount(): number {
    return this.client.getChannelUserCount();
  }

  /** Non-query client IDs tracked in this bot's channel (excludes self). */
  getHumanChannelPeerClids(): number[] {
    return this.client.getChannelMemberClids();
  }

  /** Join a channel by ID (for following !play / playback commands). */
  joinChannel(channelId: number): void {
    if (this._status === 'stopped' || this._status === 'error' || this._status === 'starting') {
      throw new Error('Bot is not connected');
    }
    this.client.moveToChannel(channelId);
  }

  /** Private (DM) text to a client. */
  sendTextMessage(targetClid: number, msg: string): void {
    const cmd = buildCommand('sendtextmessage', {
      targetmode: 1,
      target: targetClid,
      msg,
    });
    this.client.sendCommand(cmd);
  }

  /** Channel chat in the bot's current channel (visible to everyone there). */
  sendChannelMessage(msg: string): void {
    const cmd = buildCommand('sendtextmessage', {
      targetmode: 2,
      msg,
    });
    this.client.sendCommand(cmd);
  }

  get currentConfig(): VoiceBotConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<VoiceBotConfig>): void {
    Object.assign(this.config, partial);
    if (partial.nickname) this._originalNickname = partial.nickname;
    if (partial.videoStreamVolume != null) {
      this._videoStreamVolume = Math.max(0, Math.min(100, partial.videoStreamVolume));
    }
  }

  /** Stop playback when the bot's channel has been empty for the configured grace period. */
  private startAutoStopTimer(): void {
    this.stopAutoStopTimer();
    const graceSec = this.config.autoStopEmptySeconds ?? 300;
    if (graceSec <= 0) return;

    this.autoStopEmptySince = null;
    this.autoStopTimer = setInterval(() => {
      if (this._status !== 'playing' && !this._videoStreaming) {
        this.stopAutoStopTimer();
        return;
      }
      if (this.client.getChannelUserCount() > 0) {
        this.autoStopEmptySince = null;
        return;
      }
      const now = Date.now();
      if (this.autoStopEmptySince == null) {
        this.autoStopEmptySince = now;
        return;
      }
      if ((now - this.autoStopEmptySince) / 1000 >= graceSec) {
        console.log(`[VoiceBot ${this.config.id}] Auto-stop: channel empty for ${graceSec}s`);
        this.stopAutoStopTimer();
        if (this._videoStreaming) {
          this.stopVideoStream('channel_empty', channelEmptyStopDetail(graceSec))
            .catch((err) => this.emit('error', err));
        } else {
          this.clearPlayback('channel_empty', channelEmptyStopDetail(graceSec));
        }
      }
    }, 5000);
  }

  private stopAutoStopTimer(): void {
    if (this.autoStopTimer) {
      clearInterval(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    this.autoStopEmptySince = null;
  }

  private cleanupVideoTempFile(): void {
    if (!this._videoTempFile) return;
    safeUnlinkStreamTemp(this._videoTempFile);
    this._videoTempFile = null;
  }

  private clearVideoEndTimer(): void {
    if (!this._videoEndTimer) return;
    clearTimeout(this._videoEndTimer);
    this._videoEndTimer = null;
  }

  /**
   * Downloaded clips are not looped, so once ffmpeg finishes there is nothing
   * left to show — but the sidecar cannot notify us. Schedule stop from the
   * probed duration (+ slack) instead.
   */
  private scheduleVideoEndStop(durationSec: number): void {
    this.clearVideoEndTimer();
    this._videoEndTimer = setTimeout(() => {
      this._videoEndTimer = null;
      console.log(`[VoiceBot ${this.config.id}] Video ended, auto-stopping`);
      this.stopVideoStream('source_ended', 'Video reached its end').catch((err) => this.emit('error', err));
    }, (durationSec + 2) * 1000);
  }

  /**
   * Resolve a stream URL/path for the sidecar. On-demand downloads get
   * `loop: false` and an auto-stop timer; admin-provided local files keep looping.
   */
  private async resolveStreamSource(
    source: string,
    maxHeight: number,
  ): Promise<{ path: string; loop: boolean }> {
    const maxDur = this.config.maxVideoDurationSec ?? 900;
    const { path: filePath, durationSec } = await downloadVideoForStream(source, maxHeight, maxDur);
    const isDownloadedTemp = filePath.includes('.stream-') && filePath.endsWith('.mp4');

    this.clearVideoEndTimer();
    this._videoDurationSec = null;
    if (isDownloadedTemp) {
      this.cleanupVideoTempFile();
      this._videoTempFile = filePath;
      // Prefer probed duration; if ffprobe fails, fall back to the download
      // max so a non-looping clip cannot leave the bot "streaming" forever.
      const stopAfter = durationSec ?? maxDur;
      this._videoDurationSec = stopAfter;
      if (durationSec == null) {
        console.warn(
          `[VoiceBot ${this.config.id}] Could not probe video duration; auto-stop fallback in ${stopAfter}s`,
        );
      }
      this.scheduleVideoEndStop(stopAfter);
    }
    return { path: filePath, loop: !isDownloadedTemp };
  }

  /** Update the TS3 nickname to show what's playing. Max 30 chars. */
  private updateNowPlayingNickname(title: string): void {
    if (this._status === 'stopped') return;
    const prefix = this._originalNickname;
    const sep = ' \u266A '; // ♪
    const maxLen = 30;
    let nick = prefix + sep + title;
    if (nick.length > maxLen) {
      const available = maxLen - prefix.length - sep.length - 1; // -1 for …
      nick = prefix + sep + (available > 0 ? title.substring(0, available) + '\u2026' : '\u2026');
    }
    try {
      this.client.sendCommand(buildCommand('clientupdate', { client_nickname: nick }));
    } catch { }
  }

  /** Reset TS3 nickname to original. */
  private resetNickname(): void {
    if (this._status === 'stopped') return;
    try {
      this.client.sendCommand(buildCommand('clientupdate', { client_nickname: this._originalNickname }));
    } catch { }
  }

  /** Start polling ICY metadata for a radio stream. */
  private startIcyPolling(streamUrl: string): void {
    this.stopIcyPolling();
    this.lastStreamTitle = '';

    // Immediate first fetch
    this.fetchAndUpdateIcy(streamUrl);

    this.icyPollTimer = setInterval(() => {
      this.fetchAndUpdateIcy(streamUrl);
    }, 15000);
  }

  private async fetchAndUpdateIcy(streamUrl: string): Promise<void> {
    try {
      const title = await fetchIcyMetadata(streamUrl);
      if (!title || title === this.lastStreamTitle || !this._nowPlaying) return;
      this.lastStreamTitle = title;

      // Parse "Artist - Title" format
      const dashIdx = title.indexOf(' - ');
      if (dashIdx > 0) {
        this._nowPlaying.artist = title.substring(0, dashIdx).trim();
        this._nowPlaying.title = title.substring(dashIdx + 3).trim();
      } else {
        this._nowPlaying.title = title;
      }

      this.updateNowPlayingNickname(title);
      this.emit('metadataChange', this._nowPlaying);
    } catch { }
  }

  private stopIcyPolling(): void {
    if (this.icyPollTimer) {
      clearInterval(this.icyPollTimer);
      this.icyPollTimer = null;
    }
    this.lastStreamTitle = '';
  }

  /** Apply a persisted/generated identity before connect (create may finish keygen later). */
  setIdentity(identity: IdentityData): void {
    this.config.identity = identity;
    if (this._status === 'stopped') {
      this.identity = identity;
    }
  }

  async start(): Promise<void> {
    if (this._status === 'connected' || this._status === 'playing' || this._status === 'paused') {
      throw new Error('Bot is already running');
    }

    this._manuallyStopped = false;
    this._status = 'starting';
    this.emit('statusChange', this._status);

    this.identity = this.config.identity ?? generateIdentity(8);

    const opts: Ts3ClientOptions = {
      host: this.config.serverHost,
      port: this.config.serverPort,
      identity: this.identity,
      nickname: this.config.nickname,
      serverPassword: this.config.serverPassword,
      defaultChannel: this.config.defaultChannel,
      channelPassword: this.config.channelPassword,
    };

    await this.client.connect(opts);
    this._status = 'connected';
    this.emit('statusChange', this._status);
    this.emit('connected');
  }

  async stop(): Promise<void> {
    this._manuallyStopped = true;
    this.stopAutoStopTimer();
    this.stopIcyPolling();
    this.resetNickname();
    if (this.musicActive) this.endMusicSession('bot_stopped', 'Music bot was stopped');
    this.stopPlayback();
    this._nowPlaying = null;
    // Stop video stream if active
    if (this._videoStreaming) {
      await this.stopVideoStream('bot_stopped', 'Music bot was stopped');
    }
    this.client.disconnect();
  }

  /** Force-close the underlying socket if still open, without triggering reconnect */
  ensureDisconnected(): void {
    this.client.forceClose();
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this._status === 'stopped') resolve();
        else setTimeout(check, 100);
      };
      setTimeout(check, 600);
    });
    await this.start();
  }

  async play(item: QueueItem, options: MusicStartOptions = {}): Promise<void> {
    if (this._status !== 'connected' && this._status !== 'playing' && this._status !== 'paused') {
      throw new Error('Bot is not connected');
    }
    if (this._videoStreaming || this._videoStarting) {
      await this.replaceVideoWithMusic(options.replaceSessionIds);
    }
    this.beginMusicSession();

    this.stopIcyPolling();
    this.stopPlayback();
    this._nowPlaying = item;
    this._status = 'playing';
    this.emit('statusChange', this._status);
    this.emit('nowPlaying', item);
    this.updateNowPlayingNickname(item.title);

    try {
      if (
        !item.filePath
        && item.sourceUrl
        && (item.source === 'youtube' || item.source === 'url')
        && isYouTubeHostUrl(item.sourceUrl)
      ) {
        try {
          const { streamUrl, info } = await resolveYouTubeAudioStream(item.sourceUrl);
          item.streamUrl = streamUrl;
          if (!item.duration && info.duration) item.duration = info.duration;
          await this.playStream(item);
          return;
        } catch (streamErr: any) {
          console.warn(
            `[VoiceBot ${this.config.id}] YouTube stream failed for “${item.title}”, falling back to download: ${streamErr.message}`,
          );
        }
      }

      const filePath = await this.ensurePlayableFile(item);
      await this.startFileStream(filePath, 0);
      this.startAutoStopTimer();
    } catch (err) {
      this.endMusicSession('source_unreachable', 'Track could not be played');
      this._status = 'connected';
      this._nowPlaying = null;
      this.emit('statusChange', this._status);
      throw err;
    }
  }

  /** Start or restart bounded-memory local file decoding at the requested position. */
  private async startFileStream(filePath: string, startSeconds: number): Promise<void> {
    const stream = await this.pipeline.toPcmFileStream(filePath, startSeconds);
    this.fileStreamStartEpoch = ++this.loopEpoch;
    const epoch = this.fileStreamStartEpoch;

    this.streamKill = stream.kill;
    this.fileStdout = stream.stdout;
    this.streamChunks = [];
    this.streamChunksSize = 0;
    this.fileBaseSeconds = startSeconds;
    this.fileFramesSent = 0;
    this.fileFfmpegEnded = false;
    this._fileStreamActive = true;

    stream.stdout.on('data', (chunk: Buffer) => {
      if (epoch !== this.loopEpoch) return;
      this.streamChunks.push(chunk);
      this.streamChunksSize += chunk.length;
    });

    stream.process.on('close', (code) => {
      if (epoch !== this.loopEpoch) return;
      if (code != null && code !== 0) {
        this.clearTimer();
        this._fileStreamActive = false;
        this.streamKill = null;
        this.fileStdout = null;
        this.streamChunks = [];
        this.streamChunksSize = 0;
        if (!this._videoStreaming) this.stopAutoStopTimer();
        this._status = 'error';
        this.emit('error', new Error(`FFmpeg file playback exited with code ${code}`));
        this.emit('statusChange', this._status);
        return;
      }
      this.fileFfmpegEnded = true;
    });

    stream.process.on('error', (err) => {
      if (epoch !== this.loopEpoch) return;
      this.clearTimer();
      this._fileStreamActive = false;
      this.streamKill = null;
      this.fileStdout = null;
      this.streamChunks = [];
      this.streamChunksSize = 0;
      if (!this._videoStreaming) this.stopAutoStopTimer();
      this._status = 'error';
      this.emit('error', err);
      this.emit('statusChange', this._status);
    });

    this.fileNextDue = performance.now() + 200;
    this.playbackTimer = setTimeout(this.fileTick, 200);
  }

  private resumeFileStreamTick(): void {
    this.fileNextDue = performance.now() + FRAME_MS;
    this.playbackTimer = setTimeout(this.fileTick, FRAME_MS);
  }

  private fileTick = (): void => {
    if (this.fileStreamStartEpoch !== this.loopEpoch || !this._fileStreamActive) return;

    const now = performance.now();
    if (now < this.fileNextDue) {
      this.playbackTimer = setTimeout(this.fileTick, Math.max(1, this.fileNextDue - now));
      return;
    }

    const lagMs = now - this.fileNextDue;
    if (lagMs >= FRAME_MS) {
      this.fileNextDue = now + FRAME_MS;
    }

    let frame = this.takeFromStreamChunks(BYTES_PER_FRAME);
    if (!frame && this.fileFfmpegEnded && this.streamChunksSize > 0) {
      const raw = this.takeFromStreamChunks(this.streamChunksSize)!;
      const padded = Buffer.alloc(BYTES_PER_FRAME, 0);
      raw.copy(padded);
      frame = padded;
    }

    if (frame) {
      const opusFrame = this.pipeline.encodeFrame(frame, this.config.volume);
      this.sendVoiceFrame(opusFrame);
      this.fileFramesSent++;
    } else if (this.fileFfmpegEnded) {
      this.finishFileTrack();
      return;
    }

    this.fileNextDue += FRAME_MS;
    if (now - this.fileNextDue > 5 * FRAME_MS) {
      this.fileNextDue = now + FRAME_MS;
    }

    const delay = this.fileNextDue - performance.now();
    if (delay > 2) {
      this.playbackTimer = setTimeout(this.fileTick, delay);
    } else {
      setImmediate(this.fileTick);
    }
  };

  private finishFileTrack(): void {
    this.client.sendVoiceStop();
    this.clearTimer();
    this._fileStreamActive = false;
    this.streamKill = null;
    this.fileStdout = null;
    this.streamChunks = [];
    this.streamChunksSize = 0;

    const finished = this._nowPlaying;
    this._nowPlaying = null;
    this._status = 'connected';
    this.emit('statusChange', this._status);
    this.emit('trackEnd', finished);

    if (this.queue.repeat === 'track' && finished) {
      this.play(finished).catch((err) => this.emit('error', err));
      return;
    }

    const next = this.queue.next();
    if (next) {
      this.play(next).catch((err) => this.emit('error', err));
    } else {
      // The queue ran out: the music session is over, not merely paused.
      this.endMusicSession('source_ended', 'Queue finished');
      this.resetNickname();
      if (!this._videoStreaming) this.stopAutoStopTimer();
    }
  }

  /**
   * Stream-mode / registered YouTube songs may have an empty filePath until first play.
   * Download on demand, update the queue item, and notify listeners to persist the path.
   */
  private async ensurePlayableFile(item: QueueItem): Promise<string> {
    if (item.filePath && fs.existsSync(item.filePath)) {
      return item.filePath;
    }
    if (!item.sourceUrl) {
      throw new Error(`No media file for “${item.title}” and no source URL to download`);
    }

    console.log(`[VoiceBot ${this.config.id}] On-demand download: ${item.title} (${item.sourceUrl})`);
    const dl = await downloadYouTube(item.sourceUrl, MUSIC_DIR);
    item.filePath = dl.filePath;
    let fileSize: number | undefined;
    try {
      fileSize = fs.statSync(dl.filePath).size;
    } catch {
      /* ignore */
    }
    this.emit('mediaCached', {
      songId: item.id,
      filePath: dl.filePath,
      fileSize,
      title: dl.info.title,
      artist: dl.info.artist,
      duration: dl.info.duration,
    });
    return dl.filePath;
  }

  async playStream(item: QueueItem, options: MusicStartOptions = {}): Promise<void> {
    if (this._status !== 'connected' && this._status !== 'playing' && this._status !== 'paused') {
      throw new Error('Bot is not connected');
    }
    if (!item.streamUrl) {
      throw new Error('No streamUrl provided');
    }
    if (this._videoStreaming || this._videoStarting) {
      await this.replaceVideoWithMusic(options.replaceSessionIds);
    }
    this.beginMusicSession();

    this.stopIcyPolling();
    this.stopPlayback();
    this._nowPlaying = item;
    this._isStreaming = true;
    this._status = 'playing';
    this.streamStartTime = Date.now();
    this.emit('statusChange', this._status);
    this.emit('nowPlaying', item);
    this.updateNowPlayingNickname(item.title);
    this.startIcyPolling(item.streamUrl);

    try {
      const stream = await this.pipeline.toPcmStream(item.streamUrl);
      this.streamKill = stream.kill;
      this.streamChunks = [];
      this.streamChunksSize = 0;

      const epoch = ++this.loopEpoch;
      let framesSent = 0;
      const startTime = performance.now();

      stream.stdout.on('data', (chunk: Buffer) => {
        if (epoch !== this.loopEpoch) return;
        this.streamChunks.push(chunk);
        this.streamChunksSize += chunk.length;
      });

      stream.process.on('close', () => {
        if (epoch !== this.loopEpoch) return;
        this.endMusicSession('source_ended', 'Stream ended');
        this.client.sendVoiceStop();
        this._isStreaming = false;
        this.streamKill = null;
        this._nowPlaying = null;
        this._status = 'connected';
        this.emit('statusChange', this._status);
        this.emit('trackEnd', item);
      });

      stream.process.on('error', (err) => {
        if (epoch !== this.loopEpoch) return;
        this._isStreaming = false;
        this.streamKill = null;
        this._status = 'error';
        this.emit('error', err);
        this.emit('statusChange', this._status);
      });

      let nextDue = performance.now() + 200; // initial buffer delay

      const tick = () => {
        if (epoch !== this.loopEpoch) return;

        const now = performance.now();

        // If we're early, wait until the next due time
        if (now < nextDue) {
          this.playbackTimer = setTimeout(tick, Math.max(1, nextDue - now));
          return;
        }

        // If we're behind, resync clock (no bursts)
        const lagMs = now - nextDue;
        if (lagMs >= FRAME_MS) {
          nextDue = now + FRAME_MS;
        }

        // Send exactly one frame if available
        const frame = this.takeFromStreamChunks(BYTES_PER_FRAME);
        if (frame) {
          const opusFrame = this.pipeline.encodeFrame(frame, this.config.volume);
          this.sendVoiceFrame(opusFrame);
        }

        // Next slot
        nextDue += FRAME_MS;

        // If we fell way behind, resync to avoid long "catch-up"
        if (now - nextDue > 5 * FRAME_MS) {
          nextDue = now + FRAME_MS;
        }

        const delay = nextDue - performance.now();

        if (delay > 2) {
          this.playbackTimer = setTimeout(tick, delay);
        } else {
          setImmediate(tick);
        }
      };

      this.playbackTimer = setTimeout(tick, 200);
      this.startAutoStopTimer();
    } catch (err) {
      // A failed start must not leave ICY polling running for a dead stream.
      this.stopIcyPolling();
      this._isStreaming = false;
      this.streamKill = null;
      this.endMusicSession('source_unreachable', 'Stream could not be opened');
      this._status = 'connected';
      this._nowPlaying = null;
      this.emit('statusChange', this._status);
      throw err;
    }
  }

  /** Stop current audio without disconnecting the bot (used by clear-queue). */
  clearPlayback(reason: MediaStopReason = 'manual', detail: string | null = null): void {
    if (this.musicActive) this.endMusicSession(reason, detail);
    this.stopIcyPolling();
    this.stopPlayback();
    try {
      this.client.sendVoiceStop();
    } catch {
      /* ignore if not connected */
    }
    this.resetNickname();
    this._nowPlaying = null;
    if (!this._videoStreaming) {
      this.stopAutoStopTimer();
    }
    if (this._status === 'playing' || this._status === 'paused') {
      this._status = 'connected';
      this.emit('statusChange', this._status);
    }
    this.emit('trackEnd', null);
  }

  pause(): void {
    if (this._status !== 'playing') return;
    this.client.sendVoiceStop();

    if (this._fileStreamActive) {
      // Keep the epoch/process alive so resume can continue from the existing
      // file position; pausing stdout applies pipe backpressure to ffmpeg.
      if (this.playbackTimer) {
        clearTimeout(this.playbackTimer);
        this.playbackTimer = null;
      }
      this.fileStdout?.pause();
    } else {
      this.clearTimer();
    }

    this._status = 'paused';
    this.emit('statusChange', this._status);
  }

  resume(): void {
    if (this._status !== 'paused') return;

    if (this._fileStreamActive) {
      this._status = 'playing';
      this.emit('statusChange', this._status);
      this.fileStdout?.resume();
      this.resumeFileStreamTick();
    } else if (this._isStreaming && this._nowPlaying) {
      // Direct/live streams do not have a local seekable file. Re-open the
      // stream rather than accidentally running the removed PCM-frame loop.
      const item = this._nowPlaying;
      this._status = 'playing';
      this.emit('statusChange', this._status);
      this.playStream(item).catch((err) => this.emit('error', err));
    }
  }

  get canSeek(): boolean {
    return (this._status === 'playing' || this._status === 'paused') && this._fileStreamActive && !!this._nowPlaying;
  }

  async seek(seconds: number): Promise<void> {
    if (this._status !== 'playing' && this._status !== 'paused') return;
    if (!this._fileStreamActive || !this._nowPlaying) return;

    const duration = this._nowPlaying.duration ?? Infinity;
    const target = Math.max(0, Math.min(seconds, duration));
    const wasPlaying = this._status === 'playing';
    const filePath = this._nowPlaying.filePath;

    this.clearTimer();
    if (this.streamKill) {
      this.streamKill();
      this.streamKill = null;
    }
    this._fileStreamActive = false;
    this.streamChunks = [];
    this.streamChunksSize = 0;

    await this.startFileStream(filePath, target);

    if (!wasPlaying) {
      if (this.playbackTimer) {
        clearTimeout(this.playbackTimer);
        this.playbackTimer = null;
      }
      this.fileStdout?.pause();
    }
  }

  setVolume(volume: number): void {
    this.config.volume = Math.max(0, Math.min(100, volume));
    this.emit('volumeChange', this.config.volume);
  }

  skip(options: MusicStartOptions = {}): void {
    this.stopIcyPolling();
    this.stopPlayback();
    this._nowPlaying = null;
    this._status = 'connected';
    this.emit('statusChange', this._status);

    const next = this.queue.next();
    if (next) {
      this.play(next, options).catch((err) => this.emit('error', err));
    } else {
      this.resetNickname();
    }
  }

  previous(options: MusicStartOptions = {}): void {
    this.stopIcyPolling();
    this.stopPlayback();
    this._nowPlaying = null;
    this._status = 'connected';
    this.emit('statusChange', this._status);

    const prev = this.queue.previous();
    if (prev) {
      this.play(prev, options).catch((err) => this.emit('error', err));
    } else {
      this.resetNickname();
    }
  }

  stopAudio(): void {
    if (this.musicActive) this.endMusicSession('manual', null);
    this.stopIcyPolling();
    this.stopPlayback();
    this.client.sendVoiceStop();
    this._nowPlaying = null;
    this.resetNickname();
    if (this._status === 'playing' || this._status === 'paused') {
      this._status = 'connected';
      this.emit('statusChange', this._status);
    }
  }

  private takeFromStreamChunks(n: number): Buffer | null {
    if (this.streamChunksSize < n) return null;

    const out = Buffer.allocUnsafe(n);
    let offset = 0;

    while (offset < n) {
      const head = this.streamChunks[0];
      const need = n - offset;

      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        this.streamChunks.shift();
      } else {
        head.copy(out, offset, 0, need);
        this.streamChunks[0] = head.subarray(need);
        offset += need;
      }
    }

    this.streamChunksSize -= n;
    return out;
  }

  private sendVoiceFrame(opusFrame: Buffer): void {
    const now = performance.now();
    const dt = this.lastVoiceSendAt ? (now - this.lastVoiceSendAt) : 0;
    this.lastVoiceSendAt = now;

    const VOICE_DEBUG = process.env.VOICE_DEBUG === '1';

    if (VOICE_DEBUG) {
      // 1s stats
      if (!this.statWindowStart) this.statWindowStart = now;
      if (dt > 0) {
        this.statCount++;
        this.statDtSum += dt;
        this.statDtMin = Math.min(this.statDtMin, dt);
        this.statDtMax = Math.max(this.statDtMax, dt);
      }

      if (now - this.statWindowStart >= 1000) {
        const avg = this.statCount ? (this.statDtSum / this.statCount) : 0;
        console.log(
          `[voice] rate=${this.statCount}/s avg=${avg.toFixed(1)}ms min=${this.statDtMin.toFixed(1)} max=${this.statDtMax.toFixed(1)} streaming=${this._isStreaming}`
        );
        this.statWindowStart = now;
        this.statCount = 0;
        this.statDtSum = 0;
        this.statDtMin = Number.POSITIVE_INFINITY;
        this.statDtMax = 0;
      }
    }

    this.client.sendVoice(opusFrame);
  }

  private clearTimer(): void {
    this.loopEpoch++;
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  private stopPlayback(): void {
    this.clearTimer();
    this._fileStreamActive = false;
    this.fileStdout = null;
    this.fileFramesSent = 0;
    this.fileBaseSeconds = 0;
    this.fileFfmpegEnded = false;

    if (this.streamKill) {
      this.streamKill();
      this.streamKill = null;
    }
    this._isStreaming = false;
    this.streamChunks = [];
    this.streamChunksSize = 0;
  }

  // ─── Video Streaming ────────────────────────────────────────

  get videoStreaming(): boolean {
    return this._videoStreaming;
  }

  // ─── Media sessions (music XOR video) ─────────────────────

  private get musicActive(): boolean {
    return this._status === 'playing' || this._status === 'paused';
  }

  private beginMusicSession(): void {
    if (!this._musicSessionId) {
      this._musicSessionId = newMediaSessionId();
      this._musicStartedAt = Date.now();
    }
  }

  private endMusicSession(reason: MediaStopReason, detail: string | null): void {
    this._lastMusicStop = { reason, at: Date.now(), detail };
    this._musicSessionId = null;
    this._musicStartedAt = null;
  }

  /** This bot's music session, when music is playing or paused. */
  musicSessionInfo(): MediaSessionInfo | null {
    if (!this.musicActive) return null;
    this.beginMusicSession();
    return {
      id: this._musicSessionId!,
      kind: 'music',
      state: 'active',
      botId: this.config.id,
      botName: this.config.name,
      startedAt: this._musicStartedAt,
      label: this._nowPlaying?.title ?? null,
    };
  }

  /** This bot's video session, while starting or streaming. */
  videoSessionInfo(): MediaSessionInfo | null {
    if (!this._videoSessionId || (!this._videoStreaming && !this._videoStarting)) return null;
    return {
      id: this._videoSessionId,
      kind: 'video',
      state: this._videoStreaming ? 'active' : 'starting',
      botId: this.config.id,
      botName: this.config.name,
      startedAt: this._videoStartedAt,
      label: safeSourceLabel(this._videoSource),
    };
  }

  /** The bot's one active media session, if any. */
  get mediaSession(): MediaSessionInfo | null {
    return this.videoSessionInfo() ?? this.musicSessionInfo();
  }

  get lastMusicStop(): MediaStopInfo | null {
    return this._lastMusicStop;
  }

  /** Bot hub summary: no sidecar or Query calls, no source URLs. */
  mediaOverview(): Omit<BotMediaOverview, 'serverName' | 'botName' | 'serverConfigId'> {
    const cid = this.client.getCurrentChannelId();
    const progress = this.playbackProgress;
    const video = this.videoStreamStatus;
    const { source: _source, viewers: _viewers, sidecar: _sidecar, ...videoSummary } = video;
    return {
      botId: this.config.id,
      status: this._status,
      channelId: cid > 0 ? cid : null,
      channelName: this.getCurrentChannelName(),
      session: this.mediaSession,
      music: this.musicActive
        ? {
          title: this._nowPlaying?.title ?? null,
          artist: this._nowPlaying?.artist ?? null,
          live: this._isStreaming,
          position: progress?.position ?? null,
          duration: progress && progress.duration > 0 ? progress.duration : null,
        }
        : null,
      video: video.streaming ? videoSummary : null,
      lastMusicStop: this._lastMusicStop,
      lastVideoStop: this._lastVideoStop,
    };
  }

  /**
   * Fail fast (before downloads or queue changes) when starting music would
   * replace this bot's video and the caller has not confirmed that session.
   */
  assertMusicCanStart(replaceSessionIds: string[] | undefined): void {
    const video = this.videoSessionInfo();
    if (video && (video.state === 'starting' || !replaceSessionIds?.includes(video.id))) {
      throw new MediaSessionConflictError('music', [video]);
    }
  }

  /** Stop this bot's video for music, only when the caller confirmed that session. */
  private async replaceVideoWithMusic(replaceSessionIds: string[] | undefined): Promise<void> {
    if (!this.videoSessionInfo()) return;
    this.assertMusicCanStart(replaceSessionIds);
    await this.stopVideoStream('replaced_by_music', 'Replaced by music');
  }

  get videoStreamStatus(): VideoStreamStatus {
    return {
      streaming: this._videoStreaming,
      streamId: this._activeStreamId,
      source: this._videoSource,
      preset: this._videoPreset,
      framerate: this._videoFramerate,
      bitrate: this._videoBitrate,
      startedAt: this._videoStartedAt,
      viewerCount: this._viewers.size,
      viewers: Array.from(this._viewers.values()),
      sidecar: null,
      quality: this._videoStreaming ? this._videoQuality : null,
      encoder: this._videoStreaming ? this._videoEncoder : null,
      noViewer: { timeoutSec: this._noViewerTimeoutSec, stopAt: this._noViewerStopAt },
      lastStop: this._lastVideoStop,
      sourceMode: this._videoStreaming ? this._videoSourceMode : null,
      health: this._videoStreaming ? this._videoHealth : null,
    };
  }

  private async loadVideoSettings(): Promise<VideoStreamSettings> {
    if (!this.config.loadVideoSettings) return videoStreamingDefaults();
    try {
      return await this.config.loadVideoSettings();
    } catch (err: any) {
      console.warn(`[VoiceBot ${this.config.id}] Could not load video settings, using defaults: ${err.message}`);
      return videoStreamingDefaults();
    }
  }

  // ─── No-viewer auto-stop ──────────────────────────────────

  private clearNoViewerTimer(): void {
    if (this._noViewerTimer) {
      clearTimeout(this._noViewerTimer);
      this._noViewerTimer = null;
    }
    this._noViewerStopAt = null;
  }

  /**
   * Count down while nobody (no TeamSpeak viewer) watches the stream, and stop
   * it when the countdown ends. Separate from the channel-empty auto-stop: a
   * full channel where nobody opened the stream still frees the encoder.
   */
  private refreshNoViewerTimer(): void {
    if (!this._videoStreaming || this._noViewerTimeoutSec <= 0 || this._viewers.size > 0) {
      this.clearNoViewerTimer();
      return;
    }
    if (this._noViewerTimer) return;

    const timeoutSec = this._noViewerTimeoutSec;
    this._noViewerStopAt = Date.now() + timeoutSec * 1000;
    this._noViewerTimer = setTimeout(() => {
      this._noViewerTimer = null;
      this._noViewerStopAt = null;
      if (!this._videoStreaming || this._viewers.size > 0) return;
      console.log(`[VoiceBot ${this.config.id}] Auto-stop: no stream viewers for ${timeoutSec}s`);
      this.stopVideoStream('no_viewers', noViewersStopDetail(timeoutSec))
        .catch((err) => this.emit('error', err));
    }, timeoutSec * 1000);
  }

  // ─── Encode health (#72) ──────────────────────────────────

  /**
   * Sample the sidecar's in-memory encode stats while this stream runs. This
   * is not a diagnostic probe (no test encodes, no tool spawns) and never runs
   * without an active stream.
   */
  private startHealthMonitor(): void {
    this.stopHealthMonitor();
    this._videoHealthTimer = setInterval(() => {
      this.pollVideoHealth().catch(() => { /* next tick retries */ });
    }, VIDEO_HEALTH_INTERVAL_MS);
  }

  private stopHealthMonitor(): void {
    if (this._videoHealthTimer) {
      clearInterval(this._videoHealthTimer);
      this._videoHealthTimer = null;
    }
    this._videoHealth = null;
  }

  /** One health sample; stops the stream with a truthful reason if ffmpeg died. */
  async pollVideoHealth(): Promise<void> {
    if (!this._videoStreaming || !this.sidecarHttp || this._videoHealthPolling || this._videoStopping) return;
    this._videoHealthPolling = true;
    try {
      const stats = await this.sidecarHttp.getStats();
      if (!this._videoStreaming || this._videoStopping) return;

      if (stats.encoder?.state === 'exited') {
        const exit = classifyEncoderExit({
          mode: this._videoSourceMode ?? 'vod',
          loop: this._videoLoop,
          exitError: stats.encoder.exitError ?? null,
        });
        console.warn(`[VoiceBot ${this.config.id}] Encoder exited (${exit.reason}); stopping stream`);
        await this.stopVideoStream(exit.reason, exit.detail);
        return;
      }

      const h = stats.health;
      if (!h) {
        this._videoHealth = null;
        return;
      }
      const rtpDrops = (h.rtpVideoDrops ?? 0) + (h.rtpAudioDrops ?? 0);
      this._videoHealth = {
        speed: h.speed > 0 ? h.speed : null,
        fps: h.fps > 0 ? h.fps : null,
        droppedFrames: h.droppedFrames ?? 0,
        rtpDrops,
        belowRealtime: !!h.belowRealtime,
        belowRealtimeSecs: h.belowRealtimeSecs ?? 0,
        warning: h.belowRealtime
          ? belowRealtimeWarning({
            speed: h.speed > 0 ? h.speed : null,
            belowSecs: h.belowRealtimeSecs ?? 0,
            preset: this._videoPreset,
            encoderLabel: encoderDisplayName(this._videoEncoder?.active ?? 'vp8'),
            mode: this._videoSourceMode,
            rtpDrops,
          })
          : null,
        checkedAt: Date.now(),
      };
      if (h.belowRealtime) {
        console.warn(`[VoiceBot ${this.config.id}] ${this._videoHealth.warning}`);
      }
    } finally {
      this._videoHealthPolling = false;
    }
  }

  private recordVideoStop(reason: MediaStopReason, detail: string | null): void {
    this._lastVideoStop = { reason, at: Date.now(), detail };
  }

  // ─── Source / encoder application ─────────────────────────

  /** Record what the sidecar reports running; an old sidecar ignores encoders and runs VP8. */
  private applyEncoderSession(session: SidecarEncoderSession | null): void {
    const enc = this._videoEncoder;
    if (!enc) return;
    if (!session || !isEncoderId(session.active)) {
      this._videoEncoder = {
        ...enc,
        active: 'vp8',
        codec: 'vp8',
        hardware: false,
        fallbackReason: enc.selected === 'vp8'
          ? null
          : 'Sidecar did not report encoder support — update the sidecar image',
      };
      return;
    }
    this._videoEncoder = {
      ...enc,
      active: session.active,
      codec: ENCODER_CODEC[session.active],
      hardware: isHardwareEncoder(session.active),
      fallbackReason: session.fallbackReason || null,
    };
    if (session.fallbackReason) {
      console.warn(
        `[VoiceBot ${this.config.id}] Encoder fallback ${session.requested} → ${session.active}: ${session.fallbackReason}`,
      );
    }
  }

  /** (Re)start sidecar ffmpeg for an already-resolved path at `quality`. */
  private async sendSourceToSidecar(
    sourcePath: string,
    loop: boolean,
    quality: VideoStreamQualityInfo,
    mode: VideoSourceMode,
  ): Promise<void> {
    if (!this.sidecarHttp || !this._videoEncoder) throw new Error('No active video stream');
    const preset = STREAM_PRESETS[quality.actual];
    const framerate = this._videoRequestedFramerate && this._videoRequestedFramerate > 0
      ? this._videoRequestedFramerate
      : preset.framerate;
    const bitrate = effectiveBitrate(this._videoRequestedBitrate, preset.bitrate, this._videoSettings.maxBitrateKbps);

    const session = await this.sidecarHttp.setSource(sourcePath, {
      width: quality.width,
      height: quality.height,
      framerate,
      bitrate,
      volume: this._videoStreamVolume,
      loop,
      encoder: this._videoEncoder.selected,
      mode,
    });

    this._videoSourceMode = mode;
    this._videoLoop = loop;
    this._videoHealth = null;

    this._videoQuality = quality;
    this._videoPreset = quality.actual;
    this._videoFramerate = framerate;
    this._videoBitrate = bitrate;
    this.applyEncoderSession(session);
  }

  /**
   * Resolve (download/validate) a source, pick its quality — Auto probes the
   * source resolution, fixed presets never probe — and hand it to the sidecar.
   */
  private async applyVideoSource(source: string, requested: VideoQualityRequest): Promise<void> {
    const limit = this._videoSettings.autoMaxPreset;
    const maxHeight = STREAM_PRESETS[requested === 'auto' ? limit : requested].height;
    const resolved = await this.resolveStreamSource(source, maxHeight);
    const isLocal = !/^https?:\/\//i.test(resolved.path);
    // Only Auto probes; the same probe tells live (no duration) from VOD.
    const probe = requested === 'auto' ? await probeSource(resolved.path) : null;
    const quality = resolveQuality(requested, limit, probe?.resolution ?? null);
    const mode = resolveSourceMode(this._videoSourceModeRequest, isLocal, probe);
    if (quality.note) {
      console.log(`[VoiceBot ${this.config.id}] Auto quality → ${quality.actual}: ${quality.note}`);
    }
    await this.sendSourceToSidecar(resolved.path, resolved.loop && mode === 'file', quality, mode);
  }

  /** Start video streaming to TS6 via WebRTC */
  async startVideoStream(source: string, options: VideoStreamStartOptions = {}): Promise<void> {
    if (this._status !== 'connected' && this._status !== 'playing' && this._status !== 'paused') {
      throw new Error('Bot is not connected');
    }
    if (this._videoStreaming || this._videoStarting) {
      throw new Error('Video stream already active');
    }
    const music = this.musicSessionInfo();
    if (music && !options.replaceSessionIds?.includes(music.id)) {
      throw new MediaSessionConflictError('video', [music]);
    }

    // Claim the session synchronously so concurrent starts (double clicks,
    // chat commands, other admins) see it before the first await.
    this._videoStarting = true;
    this._videoSessionId = newMediaSessionId();
    try {
      if (music) this.clearPlayback('replaced_by_video', 'Replaced by a video stream');
      await this.startVideoStreamClaimed(source, options);
    } catch (err) {
      if (!this._videoStreaming) this._videoSessionId = null;
      throw err;
    } finally {
      this._videoStarting = false;
    }
  }

  private async startVideoStreamClaimed(source: string, options: VideoStreamStartOptions): Promise<void> {
    if (options.volume != null) {
      this._videoStreamVolume = Math.max(0, Math.min(100, options.volume));
    }

    const settings = await this.loadVideoSettings();
    this._videoSettings = settings;
    const requestedQuality = normalizeQualityRequest(
      options.preset ?? this.config.streamPreset,
      DEFAULT_PRESET,
    );
    const requestedEncoder = normalizeEncoderRequest(options.encoder, settings.defaultEncoder);
    const timeoutOverride = Number(options.noViewerTimeoutSec);
    this._noViewerTimeoutSec = options.noViewerTimeoutSec != null && Number.isFinite(timeoutOverride)
      ? Math.max(0, Math.floor(timeoutOverride))
      : settings.noViewerTimeoutSec;
    this._videoSourceModeRequest = options.sourceMode ?? 'auto';
    this._videoRequestedFramerate = options.framerate && options.framerate > 0 ? options.framerate : null;
    this._videoRequestedBitrate = options.bitrate?.trim() || null;

    const sidecarBinary = this.config.sidecarBinaryPath || process.env.SIDECAR_BINARY_PATH || 'sidecar';
    const sidecarPort = this.config.sidecarPort || 9800;

    // Check if sidecar URL is set (Docker mode — sidecar runs as separate container)
    const sidecarUrl = process.env.SIDECAR_URL;

    if (sidecarUrl) {
      // Docker mode: sidecar is an external service, don't spawn it
      this.sidecarHttp = new SidecarClient(sidecarUrl);
    } else {
      // Local mode: spawn sidecar binary
      const sidecarConfig: SidecarConfig = {
        binaryPath: sidecarBinary,
        port: sidecarPort,
      };

      this.sidecarProc = new SidecarProcess(sidecarConfig);
      this.sidecarProc.on('exited', (code: number | null) => {
        console.log(`[VoiceBot ${this.config.id}] Sidecar exited (code=${code})`);
        this.cleanupVideoTempFile();
        if (this._videoStreaming) {
          this._videoStreaming = false;
          this._activeStreamId = null;
          this._viewers.clear();
          this.clearNoViewerTimer();
          this.stopHealthMonitor();
          this._videoSessionId = null;
          this.recordVideoStop('sidecar_failure', `Media sidecar exited (code ${code ?? 'unknown'})`);
          if (this._status !== 'playing') {
            this.stopAutoStopTimer();
          }
          this.emit('videoStreamStopped', this._lastVideoStop);
          this.emit('statusChange', this._status);
        }
      });
      try {
        this.sidecarProc.start();
      } catch (err: any) {
        this.sidecarProc = null;
        throw new Error(`Failed to start sidecar: ${err.message}`);
      }
      this.sidecarHttp = new SidecarClient(sidecarPort);
    }

    // Wait for sidecar to be healthy
    await this.sidecarHttp.waitHealthy();
    console.log(`[VoiceBot ${this.config.id}] Sidecar ready`);

    // Resolve `auto` before any viewer can join: peers must negotiate the
    // codec ffmpeg will send. Capabilities are probed only when hardware is wanted.
    let caps: VideoEncoderCapabilities | null = null;
    if (requestedEncoder === 'auto' && settings.preferHardware) {
      try {
        caps = await this.sidecarHttp.getEncoders();
      } catch (err: any) {
        console.warn(`[VoiceBot ${this.config.id}] Encoder capability probe failed: ${err.message}`);
      }
    }
    const selection = selectEncoder(requestedEncoder, settings.preferHardware, caps);
    this._videoEncoder = {
      requested: requestedEncoder,
      selected: selection.selected,
      active: selection.selected,
      codec: ENCODER_CODEC[selection.selected],
      hardware: isHardwareEncoder(selection.selected),
      fallbackReason: null,
      note: selection.note,
    };

    // Setup stream signaling on the TS3 client
    this.signaling = new StreamSignaling(this.client);
    this.setupSignalingListeners();
    this.signaling.registerStreamNotifications();

    // Wait for server to confirm stream
    const streamPromise = new Promise<ActiveStream>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('setupstream timeout')), 10000);
      const handler = (stream: ActiveStream) => {
        if (stream.clid === this.client.getClientId()) {
          clearTimeout(timeout);
          this.signaling!.removeListener('streamStarted', handler);
          resolve(stream);
        }
      };
      this.signaling!.on('streamStarted', handler);
    });

    // Send setupstream command
    this.signaling.sendSetupStream({
      name: `${this.config.nickname} Stream`,
      type: 3,
      bitrate: 4608,
      accessibility: 1,
      mode: 1,
      viewerLimit: 0,
      audio: true,
    });

    const stream = await streamPromise;
    this._activeStreamId = stream.id;
    this._videoStreaming = true;
    this._videoSource = source;
    this._videoStartedAt = Date.now();

    try {
      await this.applyVideoSource(source, requestedQuality);
    } catch (err) {
      if (this.signaling && this._activeStreamId) {
        this.signaling.sendStreamStop(this._activeStreamId);
      }
      this._activeStreamId = null;
      this._videoSource = null;
      this._videoStreaming = false;
      this._videoStartedAt = null;
      this._videoQuality = null;
      this._videoEncoder = null;
      this.clearNoViewerTimer();
      this.signaling = null;
      if (this.sidecarProc) {
        await this.sidecarProc.stop();
        this.sidecarProc = null;
      }
      this.sidecarHttp = null;
      throw err;
    }

    console.log(
      `[VoiceBot ${this.config.id}] Video stream started: ${stream.id} ` +
      `(quality ${requestedQuality}→${this._videoPreset}, encoder ${this._videoEncoder?.active})`,
    );
    this.emit('videoStreamStarted', { streamId: stream.id, source, preset: this._videoPreset });
    this.emit('statusChange', this._status);
    this.startAutoStopTimer();
    this.refreshNoViewerTimer();
    this.startHealthMonitor();
  }

  /** Stop video streaming, recording why it stopped. */
  async stopVideoStream(reason: MediaStopReason = 'manual', detail: string | null = null): Promise<void> {
    if (!this._videoStreaming || this._videoStopping) return;
    this._videoStopping = true;

    try {
      this.clearVideoEndTimer();
      this.clearNoViewerTimer();
      this.stopHealthMonitor();
      this._videoDurationSec = null;

      // Remove all viewers from TS6 stream first
      if (this.signaling && this._activeStreamId) {
        for (const [clid] of this._viewers) {
          this.signaling.sendRemoveClient(clid, this._activeStreamId);
        }
      }

      // Stop ffmpeg and close WebRTC peers
      try { await this.sidecarHttp?.stopSource(); } catch { /* ignore */ }
      for (const [clid] of this._viewers) {
        try { await this.sidecarHttp?.closePeer(String(clid)); } catch { /* ignore */ }
      }
      this._viewers.clear();

      // Stop TS6 stream
      if (this.signaling && this._activeStreamId) {
        console.log(`[VoiceBot ${this.config.id}] Sending stopstream: ${this._activeStreamId}`);
        this.signaling.sendStreamStop(this._activeStreamId);
      }

      // Wait for the stopstream command to be sent and ACKed over UDP
      await new Promise((r) => setTimeout(r, 1000));

      // Stop sidecar process (only in local mode)
      if (this.sidecarProc) {
        await this.sidecarProc.stop();
        this.sidecarProc = null;
      }

      this._activeStreamId = null;
      this._videoSource = null;
      this._videoStreaming = false;
      this._videoStartedAt = null;
      this._videoSessionId = null;
      this.signaling = null;
      this.cleanupVideoTempFile();
      if (this._status !== 'playing') {
        this.stopAutoStopTimer();
      }
      this.recordVideoStop(reason, detail);
    } finally {
      this._videoStopping = false;
    }

    console.log(`[VoiceBot ${this.config.id}] Video stream stopped (${reason})`);
    this.emit('videoStreamStopped', this._lastVideoStop);
    this.emit('statusChange', this._status);
  }

  /** Change video source while streaming (keeps the stream's quality request and encoder). */
  async setVideoSource(source: string, volume?: number, sourceMode?: VideoSourceModeRequest): Promise<void> {
    if (!this._videoStreaming || !this.sidecarHttp) {
      throw new Error('No active video stream');
    }
    // A new source is a new kind of input: default back to detection.
    this._videoSourceModeRequest = sourceMode ?? 'auto';
    if (volume != null) {
      this._videoStreamVolume = Math.max(0, Math.min(100, volume));
    }
    this._videoSource = source;
    await this.applyVideoSource(source, this._videoQuality?.requested ?? this._videoPreset);
    console.log(`[VoiceBot ${this.config.id}] Video source changed`);
    this.emit('videoSourceChanged', source);
  }

  /** Adjust video stream audio volume (0–100) while streaming. */
  async setVideoStreamVolume(volume: number): Promise<void> {
    if (!this._videoStreaming || !this.sidecarHttp || !this._videoSource) {
      throw new Error('No active video stream');
    }
    this._videoStreamVolume = Math.max(0, Math.min(100, volume));
    // Reuse the resolved quality: a volume change must not re-probe the source.
    const quality = this._videoQuality ?? resolveQuality(this._videoPreset, this._videoSettings.autoMaxPreset, null);
    const maxHeight = STREAM_PRESETS[quality.actual].height;
    let sourcePath: string;
    let loop = true;
    if (this._videoTempFile) {
      try {
        sourcePath = resolvePathUnderMusicDir(this._videoTempFile);
        loop = false;
      } catch {
        const resolved = await this.resolveStreamSource(this._videoSource, maxHeight);
        sourcePath = resolved.path;
        loop = resolved.loop;
      }
    } else {
      const resolved = await this.resolveStreamSource(this._videoSource, maxHeight);
      sourcePath = resolved.path;
      loop = resolved.loop;
    }
    const mode: VideoSourceMode = /^https?:\/\//i.test(sourcePath) ? (this._videoSourceMode ?? 'vod') : 'file';
    await this.sendSourceToSidecar(sourcePath, loop && mode === 'file', quality, mode);
    // setSource restarts ffmpeg from the beginning for volume changes, so
    // refresh the auto-stop timer from now for non-looping on-demand clips.
    if (!loop && this._videoDurationSec != null) {
      this.scheduleVideoEndStop(this._videoDurationSec);
    }
    this.emit('videoVolumeChange', this._videoStreamVolume);
  }

  /** Kick a viewer from the video stream */
  async kickVideoViewer(clid: number): Promise<void> {
    if (!this._videoStreaming || !this.signaling || !this._activeStreamId) {
      throw new Error('No active video stream');
    }
    try { await this.sidecarHttp?.closePeer(String(clid)); } catch { /* ignore */ }
    this.signaling.sendRemoveClient(clid, this._activeStreamId);
    this._viewers.delete(clid);
    this.emit('videoViewerLeft', clid);
    this.refreshNoViewerTimer();
  }

  /** Get WebRTC offer for WebUI preview player */
  async getWebRtcOffer(): Promise<{ sdp: string } | null> {
    if (!this._videoStreaming || !this.sidecarHttp) return null;
    return this.sidecarHttp.createPeer('webui-preview', this._videoEncoder?.codec);
  }

  /** Set WebRTC answer from WebUI preview player */
  async setWebRtcAnswer(sdp: string): Promise<void> {
    if (!this.sidecarHttp) throw new Error('No sidecar');
    await this.sidecarHttp.setAnswer('webui-preview', sdp);
  }

  /** Add ICE candidate from WebUI preview player */
  async addWebRtcIceCandidate(candidate: string, sdpMid: string, sdpMLineIndex: number): Promise<void> {
    if (!this.sidecarHttp) throw new Error('No sidecar');
    await this.sidecarHttp.addIceCandidate('webui-preview', candidate, sdpMid, sdpMLineIndex);
  }

  private setupSignalingListeners(): void {
    if (!this.signaling) return;

    this.signaling.on('signalingMessage', (msg: SignalingMessage) => {
      this.handleSignalingMessage(msg);
    });

    this.signaling.on('joinStreamRequest', (params: Record<string, string>) => {
      const viewerClid = parseInt(params.clid) || 0;
      const streamId = params.id || this._activeStreamId;
      if (!streamId || !viewerClid) return;
      console.log(`[VoiceBot ${this.config.id}] Viewer join request: clid=${viewerClid}`);
      this.handleViewerJoin(viewerClid, streamId);
    });

    this.signaling.on('streamClientLeft', (params: Record<string, string>) => {
      const clid = parseInt(params.clid) || 0;
      if (this._viewers.has(clid)) {
        console.log(`[VoiceBot ${this.config.id}] Viewer left: clid=${clid}`);
        this.sidecarHttp?.closePeer(String(clid)).catch(() => { });
        this._viewers.delete(clid);
        this.emit('videoViewerLeft', clid);
        this.refreshNoViewerTimer();
      }
    });
  }

  private async handleSignalingMessage(msg: SignalingMessage): Promise<void> {
    if (!this.sidecarHttp) return;

    switch (msg.type) {
      case 'answer':
        if (msg.sdp && msg.clid) {
          try {
            await this.sidecarHttp.setAnswer(String(msg.clid), msg.sdp);
          } catch (err: any) {
            console.error(`[VoiceBot ${this.config.id}] setAnswer error (clid=${msg.clid}): ${err.message}`);
          }
        }
        break;
      case 'ice_candidate':
        if (msg.candidate && msg.clid) {
          try {
            await this.sidecarHttp.addIceCandidate(
              String(msg.clid),
              msg.candidate,
              msg.sdpMid || '0',
              msg.sdpMlineIndex ?? 0
            );
          } catch (err: any) {
            console.error(`[VoiceBot ${this.config.id}] addIceCandidate error (clid=${msg.clid}): ${err.message}`);
          }
        }
        break;
      case 'reconnect':
        if (msg.clid && this._activeStreamId) {
          console.log(`[VoiceBot ${this.config.id}] Reconnect from clid=${msg.clid}`);
          try { await this.sidecarHttp.closePeer(String(msg.clid)); } catch { /* ignore */ }
          this._viewers.delete(msg.clid);
          await this.handleViewerJoin(msg.clid, this._activeStreamId);
        }
        break;
    }
  }

  private async handleViewerJoin(viewerClid: number, streamId: string): Promise<void> {
    if (!this.sidecarHttp || !this.signaling) return;

    try {
      if (this._viewers.has(viewerClid)) {
        try { await this.sidecarHttp.closePeer(String(viewerClid)); } catch { /* ignore */ }
      }

      const result = await this.sidecarHttp.createPeer(String(viewerClid), this._videoEncoder?.codec);

      const viewer: VideoViewerInfo = {
        clid: viewerClid,
        joinedAt: Date.now(),
        iceState: 'new',
      };
      this._viewers.set(viewerClid, viewer);

      this.signaling.sendJoinResponse(viewerClid, streamId, true, result.sdp);
      console.log(`[VoiceBot ${this.config.id}] Viewer accepted: clid=${viewerClid} (${this._viewers.size} total)`);
      this.emit('videoViewerJoined', viewer);
    } catch (err: any) {
      console.error(`[VoiceBot ${this.config.id}] handleViewerJoin error (clid=${viewerClid}): ${err.message}`);
      this._viewers.delete(viewerClid);
    } finally {
      this.refreshNoViewerTimer();
    }
  }
}
