// === Music / Voice Bot Types ===

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

export type VideoStreamPresetKey = '480p' | '720p' | '1080p';

export interface VideoStreamPreset {
  label: string;
  width: number;
  height: number;
  bitrate: string;
  framerate: number;
}

export interface VideoStreamStatus {
  streaming: boolean;
  streamId: string | null;
  source: string | null;
  preset: string;
  startedAt: number | null;
  viewerCount: number;
  viewers: VideoViewerInfo[];
  sidecar: { videoPort: number; audioPort: number } | null;
}

export interface VideoViewerInfo {
  clid: number;
  joinedAt: number;
  iceState: string;
}

export interface StartVideoStreamRequest {
  source: string;
  preset?: VideoStreamPresetKey;
}

export interface SetVideoSourceRequest {
  source: string;
}
