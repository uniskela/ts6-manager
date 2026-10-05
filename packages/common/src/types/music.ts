// === Music / Voice Bot Types ===

export type BotAvatarMode = 'none' | 'default' | 'custom';

export type VoiceBotStatus = 'stopped' | 'starting' | 'connected' | 'playing' | 'paused' | 'error';

export interface MusicBotSummary {
  id: number;
  name: string;
  serverConfigId: number;
  serverConfig?: { id: number; name: string; host: string };
  nickname: string;
  serverPassword: string | null;
  defaultChannel: string | null;
  commandChannelIds?: string[];
  virtualServerId?: number;
  channelPassword: string | null;
  voicePort: number;
  volume: number;
  autoStart: boolean;
  avatarMode?: BotAvatarMode;
  avatarMd5?: string | null;
  avatarError?: string | null;
  status: VoiceBotStatus;
  nowPlaying: QueueItemInfo | null;
  createdAt: string;
}

export interface MusicBotDetail extends MusicBotSummary {
  updatedAt: string;
  playbackProgress: { position: number; duration: number } | null;
}

export interface CreateMusicBotRequest {
  name: string;
  serverConfigId: number;
  nickname?: string;
  serverPassword?: string;
  defaultChannel?: string;
  commandChannelIds?: string[];
  virtualServerId?: number;
  channelPassword?: string;
  voicePort?: number;
  volume?: number;
  autoStart?: boolean;
}

export interface UpdateMusicBotRequest {
  name?: string;
  nickname?: string;
  serverPassword?: string;
  defaultChannel?: string;
  commandChannelIds?: string[];
  virtualServerId?: number;
  channelPassword?: string;
  voicePort?: number;
  volume?: number;
  autoStart?: boolean;
}

// === Song Types ===

export interface SongInfo {
  id: number;
  title: string;
  artist: string | null;
  duration: number | null;
  filePath: string;
  source: 'local' | 'youtube' | 'url';
  sourceUrl: string | null;
  fileSize: number | null;
  serverConfigId: number;
  createdAt: string;
}

export interface QueueItemInfo {
  id: string;
  title: string;
  artist?: string;
  duration?: number;
  source: string;
  streamUrl?: string;
}

export type RepeatMode = 'off' | 'track' | 'queue';

export interface PlaybackState {
  status: VoiceBotStatus;
  nowPlaying: QueueItemInfo | null;
  position: number;
  duration: number;
  volume: number;
  queue: QueueItemInfo[];
  currentIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
  isStreaming?: boolean;
}

// === Playlist Types ===

export type PlaylistMode = 'local' | 'stream';

export interface PlaylistSummary {
  id: number;
  name: string;
  mode: PlaylistMode;
  musicBotId: number | null;
  songCount: number;
  createdAt: string;
  youtubePlaylistId?: string | null;
  serverConfigId?: number | null;
}

export interface PlaylistDetail extends PlaylistSummary {
  songs: (SongInfo & { position: number })[];
}

// === YouTube Types ===

export interface YouTubeSearchResult {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
}

// === Radio Station Types ===

export interface RadioStationInfo {
  id: number;
  name: string;
  url: string;
  genre: string | null;
  imageUrl: string | null;
  serverConfigId: number;
}

export interface RadioPreset {
  name: string;
  url: string;
  genre: string;
}

/** Station result from Community Radio Browser search (import candidate). */
export interface RadioBrowserStationInfo {
  stationuuid: string;
  name: string;
  url: string;
  genre: string;
  imageUrl: string | null;
  countrycode: string;
  codec: string;
  bitrate: number;
}

// === Chat Commands (music bot !commands) ===

export interface ChatCommandInfo {
  id: number;
  serverConfigId: number;
  name: string;
  response: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Recommended canned-reply template (not yet stored for a server). */
export interface ChatCommandPreset {
  name: string;
  description: string;
  response: string;
}

export interface SeedChatCommandPresetsResult {
  created: number;
  createdNames: string[];
  commands: ChatCommandInfo[];
}

export interface CreateChatCommandRequest {
  name: string;
  response: string;
  description?: string;
  enabled?: boolean;
}

export interface UpdateChatCommandRequest {
  name?: string;
  response?: string;
  description?: string | null;
  enabled?: boolean;
}

export interface YouTubeUrlInfo {
  type: 'video' | 'playlist';
  items: YouTubeSearchResult[];
}

// === Video Streaming Types ===

export const VIDEO_STREAM_PRESET_KEYS = ['480p', '720p', '1080p', '1440p', '2160p'] as const;
export type VideoStreamPresetKey = (typeof VIDEO_STREAM_PRESET_KEYS)[number];

/** A fixed preset, or `auto` to pick the largest preset the source fills (capped by the Auto limit). */
export type VideoQualityRequest = 'auto' | VideoStreamPresetKey;

export const VIDEO_ENCODER_IDS = ['vp8', 'vp9', 'h264', 'vp8_vaapi', 'vp9_vaapi', 'h264_vaapi', 'h264_nvenc', 'h264_amf'] as const;
export type VideoEncoderId = (typeof VIDEO_ENCODER_IDS)[number];
/** `auto` picks software VP8, or the first working hardware encoder (VAAPI, NVENC or AMF) when hardware is preferred. */
export type VideoEncoderRequest = 'auto' | VideoEncoderId;
export type VideoCodec = 'vp8' | 'vp9' | 'h264';

/** Why a media session stopped (1.9.0 truthful lifecycle). */
export type MediaStopReason =
  | 'manual'
  | 'no_viewers'
  | 'channel_empty'
  | 'source_ended'
  | 'source_unreachable'
  | 'encoder_failure'
  | 'sidecar_failure'
  | 'replaced_by_music'
  | 'replaced_by_video'
  | 'server_disconnect'
  | 'bot_stopped';

export type MediaKind = 'music' | 'video';

/**
 * The media a bot is playing. Music and video never run at once on a bot, and
 * only one video stream runs at a time (the media sidecar is shared).
 */
export interface MediaSessionInfo {
  /** Opaque ID; send it back as `replaceSessionIds` to confirm a switch. */
  id: string;
  kind: MediaKind;
  state: 'starting' | 'active';
  botId: number;
  botName: string;
  startedAt: number | null;
  /** Track title, or a credential-free source label (host / file name) for video. */
  label: string | null;
}

/** 409 body when a start would replace media the caller has not confirmed. */
export interface MediaSessionConflictBody {
  error: string;
  details?: string;
  reason: 'media_session_conflict';
  requested: MediaKind;
  conflicts: MediaSessionInfo[];
}

/** One bot's media state for the Bot hub (cheap to poll: no sidecar or Query calls). */
export interface BotMediaOverview {
  botId: number;
  botName: string;
  avatarMode?: BotAvatarMode;
  avatarMd5?: string | null;
  avatarError?: string | null;
  serverConfigId: number;
  serverName: string | null;
  status: string;
  channelId: number | null;
  channelName: string | null;
  session: MediaSessionInfo | null;
  music: {
    title: string | null;
    artist: string | null;
    /** Radio / live audio stream rather than a track. */
    live: boolean;
    position: number | null;
    duration: number | null;
  } | null;
  /** Video details while streaming (no source URL — see `session.label`). */
  video: Omit<VideoStreamStatus, 'source' | 'viewers' | 'sidecar'> | null;
  lastMusicStop: MediaStopInfo | null;
  lastVideoStop: MediaStopInfo | null;
}

export interface VideoStreamPreset {
  label: string;
  width: number;
  height: number;
  bitrate: string;
  framerate: number;
}

/**
 * How the source behaves: `live` never ends and is not looped, `vod` is a
 * remote file-like source, `file` is local. Never inferred from a URL suffix.
 */
export type VideoSourceMode = 'live' | 'vod' | 'file';
export type VideoSourceModeRequest = 'auto' | VideoSourceMode;

/** Encode health while streaming (from the sidecar, sampled every ~10 s). */
export interface VideoStreamHealth {
  /** ffmpeg encode speed; ~1.0 is realtime. */
  speed: number | null;
  fps: number | null;
  droppedFrames: number;
  rtpDrops: number;
  /** Sustained below realtime after startup (not a transient). */
  belowRealtime: boolean;
  belowRealtimeSecs: number;
  /** Human-readable warning with context, when below realtime. */
  warning: string | null;
  checkedAt: number;
}

export interface VideoStreamQualityInfo {
  requested: VideoQualityRequest;
  actual: VideoStreamPresetKey;
  width: number;
  height: number;
  /** Probed source resolution (Auto only). */
  sourceWidth: number | null;
  sourceHeight: number | null;
  /** Why Auto chose what it chose, when not obvious (probe failure, capped by limit). */
  note: string | null;
}

export interface VideoStreamEncoderInfo {
  requested: VideoEncoderRequest;
  /** Encoder the backend asked the sidecar for (after resolving `auto`). */
  selected: VideoEncoderId;
  /** Encoder the sidecar reports running; differs from `selected` after a hardware fallback. */
  active: VideoEncoderId;
  codec: VideoCodec;
  hardware: boolean;
  fallbackReason: string | null;
  note: string | null;
}

export interface MediaStopInfo {
  reason: MediaStopReason;
  at: number;
  detail: string | null;
}

export interface VideoStreamStatus {
  streaming: boolean;
  streamId: string | null;
  source: string | null;
  /** Actual preset in use (for Auto, the resolved preset). */
  preset: string;
  framerate: number;
  bitrate: string;
  startedAt: number | null;
  viewerCount: number;
  viewers: VideoViewerInfo[];
  sidecar: { videoPort: number; audioPort: number } | null;
  quality: VideoStreamQualityInfo | null;
  encoder: VideoStreamEncoderInfo | null;
  sourceMode: VideoSourceMode | null;
  health: VideoStreamHealth | null;
  noViewer: {
    /** 0 = disabled. */
    timeoutSec: number;
    /** Epoch ms when the stream auto-stops unless a viewer joins; null while viewers are watching. */
    stopAt: number | null;
  };
  lastStop: MediaStopInfo | null;
}

/** Simple encode cost/quality preset; `custom` when Advanced knobs diverge. */
export type VideoEncodeProfile = 'performance' | 'balanced' | 'quality' | 'custom';

/** Admin defaults for new video streams (per-stream requests may override). */
export interface VideoStreamSettings {
  /** Stop a stream nobody watches after this many seconds; 0 = off. */
  noViewerTimeoutSec: number;
  /** Post channel chat notices when a stream stops by itself. */
  announceAutoStops: boolean;
  /** Highest preset Auto may select. */
  autoMaxPreset: VideoStreamPresetKey;
  defaultEncoder: VideoEncoderRequest;
  /** Let `auto` use a working hardware encoder (VAAPI, NVENC or AMF). */
  preferHardware: boolean;
  /** Clamp for any stream bitrate in kbps; 0 = no clamp. */
  maxBitrateKbps: number;
  /** Performance / Balanced / Quality — or custom when Advanced differs. */
  encodeProfile: VideoEncodeProfile;
  /** libvpx `-cpu-used` (higher = faster). Hardware encoders ignore this. */
  cpuUsed: number;
}

export interface VideoEncoderCapability {
  id: VideoEncoderId;
  codec: VideoCodec;
  hardware: boolean;
  available: boolean;
  lowPower?: boolean;
  error?: string;
  /** Raw ffmpeg reason when `error` is a friendlier summary of it. */
  detail?: string;
  /** Test encodes run, in order. Absent when the check was skipped without running ffmpeg. */
  attempts?: VideoEncoderProbeAttempt[];
  /** Why ffmpeg was not run at all (e.g. no VAAPI device); absent when it ran. */
  skipped?: string;
}

/** One ffmpeg test encode of an encoder capability check. */
export interface VideoEncoderProbeAttempt {
  command: string;
  lowPower?: boolean;
  ok: boolean;
  /** How ffmpeg ended: "exit 0", "exit status 1", a timeout, or a start error. */
  result: string;
  /** ffmpeg's combined output (tail only). */
  output?: string;
}

export interface VideoEncoderCapabilities {
  checkedAt: string;
  vaapiDevice: string;
  vaapiDevicePresent: boolean;
  hwDecode: boolean;
  encoders: VideoEncoderCapability[];
}

export interface VideoViewerInfo {
  clid: number;
  joinedAt: number;
  iceState: string;
}

export interface StartVideoStreamRequest {
  source: string;
  preset?: VideoQualityRequest;
  encoder?: VideoEncoderRequest;
  framerate?: number;
  bitrate?: string;
  volume?: number;
  /** One-session override of the no-viewer timeout (seconds, 0 = off). */
  noViewerTimeoutSec?: number;
  /** Session IDs from a media_session_conflict the caller agrees to replace. */
  replaceSessionIds?: string[];
  /** Source behaviour; `auto` detects live vs VOD when the source is probed. */
  sourceMode?: VideoSourceModeRequest;
}

export interface SetVideoSourceRequest {
  source: string;
}
