import api from './client';
import type { BotMediaOverview, StartVideoStreamRequest, VideoStreamStatus, MediaCommandPermissions } from '@ts6/common';

// === Music Bot API ===

export const musicBotsApi = {
  list: () => api.get('/music-bots').then((r) => r.data),
  /** Bot hub overview; in-memory state only, safe to poll. */
  media: (): Promise<BotMediaOverview[]> => api.get('/music-bots/media').then((r) => r.data),
  get: (id: number) => api.get(`/music-bots/${id}`).then((r) => r.data),
  create: (data: any) => api.post('/music-bots', data).then((r) => r.data),
  update: (id: number, data: any) => api.put(`/music-bots/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/music-bots/${id}`),
  start: (id: number) => api.post(`/music-bots/${id}/start`).then((r) => r.data),
  stop: (id: number) => api.post(`/music-bots/${id}/stop`).then((r) => r.data),
  restart: (id: number) => api.post(`/music-bots/${id}/restart`).then((r) => r.data),

  // The authenticated client supplies the bearer header; <img src> cannot.
  avatar: (id: number, signal?: AbortSignal): Promise<Blob> =>
    api.get(`/music-bots/${id}/avatar`, { responseType: 'blob', signal }).then((r) => r.data),
  uploadAvatar: (id: number, file: File) => {
    const data = new FormData();
    data.append('file', file);
    return api.put(`/music-bots/${id}/avatar`, data, {
      headers: { 'Content-Type': 'multipart/form-data' },
      // Saving also awaits the TS6 upload, size confirmation, and flag commands.
      timeout: 90000,
    }).then((r) => r.data);
  },
  avatarMode: (id: number, mode: 'custom' | 'default' | 'none') =>
    api.put(`/music-bots/${id}/avatar/mode`, { mode }, { timeout: 90000 }).then((r) => r.data),

  // Playback
  playRadio: (id: number, stationId: number) => api.post(`/music-bots/${id}/play-radio`, { stationId }).then((r) => r.data),
  play: (id: number, songId: number) => api.post(`/music-bots/${id}/play`, { songId }).then((r) => r.data),
  playUrl: (id: number, url: string, opts?: { enqueue?: boolean }) =>
    api.post(`/music-bots/${id}/play-url`, { url, enqueue: opts?.enqueue === true }).then((r) => r.data),
  pause: (id: number) => api.post(`/music-bots/${id}/pause`).then((r) => r.data),
  resume: (id: number) => api.post(`/music-bots/${id}/resume`).then((r) => r.data),
  stopPlayback: (id: number) => api.post(`/music-bots/${id}/stop-playback`).then((r) => r.data),
  skip: (id: number) => api.post(`/music-bots/${id}/skip`).then((r) => r.data),
  previous: (id: number) => api.post(`/music-bots/${id}/previous`).then((r) => r.data),
  seek: (id: number, seconds: number) => api.post(`/music-bots/${id}/seek`, { seconds }).then((r) => r.data),
  volume: (id: number, volume: number) => api.post(`/music-bots/${id}/volume`, { volume }).then((r) => r.data),
  state: (id: number) => api.get(`/music-bots/${id}/state`).then((r) => r.data),

  // Queue
  queue: (id: number) => api.get(`/music-bots/${id}/queue`).then((r) => r.data),
  enqueue: (id: number, songId: number) => api.post(`/music-bots/${id}/queue`, { songId }).then((r) => r.data),
  loadPlaylist: (id: number, playlistId: number, clearFirst?: boolean) =>
    api.post(`/music-bots/${id}/queue/playlist`, { playlistId, clearFirst }).then((r) => r.data),
  removeFromQueue: (id: number, index: number) => api.delete(`/music-bots/${id}/queue/${index}`).then((r) => r.data),
  clearQueue: (id: number) => api.delete(`/music-bots/${id}/queue`).then((r) => r.data),
  shuffle: (id: number, enabled: boolean) => api.post(`/music-bots/${id}/queue/shuffle`, { enabled }).then((r) => r.data),
  repeat: (id: number, mode: string) => api.post(`/music-bots/${id}/queue/repeat`, { mode }).then((r) => r.data),
  playFromQueue: (id: number, index: number) => api.post(`/music-bots/${id}/queue/${index}/play`).then((r) => r.data),
  moveQueueItem: (id: number, from: number, to: number) => api.put(`/music-bots/${id}/queue/move`, { from, to }).then((r) => r.data),
  playerWidgetToken: (id: number) => api.get(`/music-bots/${id}/player-widget-token`).then((r) => r.data),

  // Video Streaming
  // start/source await a full video download server-side before responding
  // (often past the client's default 15s timeout), so they get a longer,
  // bounded timeout of their own instead of the global default.
  // Auto quality and hardware-encoder startup add a bounded source probe /
  // test encode on top of the download, hence the same long timeout.
  startStream: (id: number, request: StartVideoStreamRequest) =>
    api.post(`/music-bots/${id}/stream/start`, request, { timeout: 120000 }).then((r) => r.data),
  stopStream: (id: number) => api.post(`/music-bots/${id}/stream/stop`).then((r) => r.data),
  setStreamSource: (id: number, source: string, volume?: number) =>
    api.post(`/music-bots/${id}/stream/source`, { source, volume }, { timeout: 120000 }).then((r) => r.data),
  setStreamVolume: (id: number, volume: number) =>
    api.post(`/music-bots/${id}/stream/volume`, { volume }).then((r) => r.data),
  streamStatus: (id: number): Promise<VideoStreamStatus> =>
    api.get(`/music-bots/${id}/stream/status`).then((r) => r.data),
  kickViewer: (id: number, clid: number) => api.delete(`/music-bots/${id}/stream/viewer/${clid}`).then((r) => r.data),
  webrtcOffer: (id: number) => api.post(`/music-bots/${id}/stream/webrtc/offer`).then((r) => r.data),
  webrtcAnswer: (id: number, sdp: string) =>
    api.post(`/music-bots/${id}/stream/webrtc/answer`, { sdp }).then((r) => r.data),
  webrtcIce: (id: number, candidate: string, sdpMid: string, sdpMLineIndex: number) =>
    api.post(`/music-bots/${id}/stream/webrtc/ice`, { candidate, sdpMid, sdpMLineIndex }).then((r) => r.data),
};

// === Music Library API ===

export const musicLibraryApi = {
  startDownload: (configId: number, urls: string[], signal: AbortSignal) =>
    api.post(`/servers/${configId}/music-library/youtube/download-jobs`, { urls }, { signal }).then(r => r.data),
  downloadStatus: (configId: number, jobId: string, signal: AbortSignal) =>
    api.get(`/servers/${configId}/music-library/youtube/download-jobs/${jobId}`, { signal }).then(r => r.data),
  songs: (configId: number) => api.get(`/servers/${configId}/music-library/songs`).then((r) => r.data),
  searchSongs: (
    configId: number,
    params: { search?: string; page?: number; pageSize?: number } = {},
  ) =>
    api
      .get(`/servers/${configId}/music-library/songs/search`, {
        params: {
          search: params.search ?? '',
          page: params.page ?? 1,
          pageSize: params.pageSize ?? 50,
        },
      })
      .then((r) => r.data as {
        total: number;
        page: number;
        pageSize: number;
        songs: import('@ts6/common').SongInfo[];
      }),
  scan: (configId: number) =>
    api.post(`/servers/${configId}/music-library/scan`).then((r) => r.data),
  upload: (configId: number, formData: FormData) =>
    api.post(`/servers/${configId}/music-library/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000, // 5 min for large uploads
    }).then((r) => r.data),
  deleteSong: (configId: number, songId: number) =>
    api.delete(`/servers/${configId}/music-library/songs/${songId}`).then((r) => r.data),
  youtubeSearch: (configId: number, query: string) =>
    api.post(`/servers/${configId}/music-library/youtube/search`, { query }).then((r) => r.data),
  youtubeDownload: (configId: number, url: string) =>
    api.post(`/servers/${configId}/music-library/youtube/download`, { url }).then((r) => r.data),
  youtubeInfo: (configId: number, url: string) =>
    api.post(`/servers/${configId}/music-library/youtube/info`, { url }, { timeout: 300000 }).then((r) => r.data),
  youtubeDownloadBatch: (configId: number, urls: string[]) =>
    api.post(`/servers/${configId}/music-library/youtube/download-batch`, { urls }, { timeout: 600000 }).then((r) => r.data),
  /** Register YouTube URLs as songs without downloading (stream playlists). */
  youtubeRegister: (
    configId: number,
    items: { url: string; title?: string; artist?: string; duration?: number }[],
  ) =>
    api
      .post(`/servers/${configId}/music-library/youtube/register`, { items }, { timeout: 120000 })
      .then((r) => r.data),
  youtubeImportPlaylist: (
    configId: number,
    data: {
      url: string;
      playlistName?: string;
      playlistId?: number;
      reimport?: boolean;
      musicBotId?: number;
      clearFirst?: boolean;
    },
  ) => api.post(`/servers/${configId}/music-library/youtube/import-playlist`, data).then((r) => r.data),
  youtubeImportStatus: (configId: number, jobId: string) =>
    api.get(`/servers/${configId}/music-library/youtube/import/${jobId}`).then((r) => r.data),
};

// === Radio Station API ===

export const radioStationsApi = {
  list: (configId: number) => api.get(`/servers/${configId}/radio-stations`).then((r) => r.data),
  presets: (configId: number) => api.get(`/servers/${configId}/radio-stations/presets`).then((r) => r.data),
  browse: (configId: number, params: { q?: string; tag?: string; country?: string; limit?: number }) =>
    api.get(`/servers/${configId}/radio-stations/browse`, { params }).then((r) => r.data),
  create: (
    configId: number,
    data: { name: string; url: string; genre?: string; imageUrl?: string; stationuuid?: string },
  ) => api.post(`/servers/${configId}/radio-stations`, data).then((r) => r.data),
  update: (configId: number, id: number, data: { name?: string; url?: string; genre?: string | null }) =>
    api.put(`/servers/${configId}/radio-stations/${id}`, data).then((r) => r.data),
  delete: (configId: number, id: number) =>
    api.delete(`/servers/${configId}/radio-stations/${id}`).then((r) => r.data),
  resetIds: (configId: number) =>
    api.post(`/servers/${configId}/radio-stations/reset-ids`).then((r) => r.data),
};

// === Custom chat commands (!name → reply) ===

export const chatCommandsApi = {
  permissions: (configId: number, sid: number): Promise<MediaCommandPermissions> =>
    api.get(`/servers/${configId}/chat-commands/permissions/${sid}`).then((r) => r.data),
  savePermissions: (configId: number, sid: number, policy: MediaCommandPermissions): Promise<MediaCommandPermissions> =>
    api.put(`/servers/${configId}/chat-commands/permissions/${sid}`, policy).then((r) => r.data),
  list: (configId: number) => api.get(`/servers/${configId}/chat-commands`).then((r) => r.data),
  presets: (configId: number) =>
    api.get(`/servers/${configId}/chat-commands/presets`).then((r) => r.data),
  seedPresets: (configId: number) =>
    api.post(`/servers/${configId}/chat-commands/seed-presets`).then((r) => r.data),
  create: (
    configId: number,
    data: { name: string; response: string; description?: string; enabled?: boolean },
  ) => api.post(`/servers/${configId}/chat-commands`, data).then((r) => r.data),
  update: (
    configId: number,
    id: number,
    data: { name?: string; response?: string; description?: string | null; enabled?: boolean },
  ) => api.put(`/servers/${configId}/chat-commands/${id}`, data).then((r) => r.data),
  delete: (configId: number, id: number) =>
    api.delete(`/servers/${configId}/chat-commands/${id}`).then((r) => r.data),
};

// === Playlist API ===

export const playlistsApi = {
  list: (serverConfigId?: number) =>
    api.get('/playlists', { params: serverConfigId ? { serverConfigId } : undefined }).then((r) => r.data),
  get: (id: number) => api.get(`/playlists/${id}`).then((r) => r.data),
  create: (data: { name: string; musicBotId?: number; mode?: 'local' | 'stream'; serverConfigId?: number }) =>
    api.post('/playlists', data).then((r) => r.data),
  update: (id: number, data: any) => api.put(`/playlists/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/playlists/${id}`),
  addSong: (id: number, songId: number) => api.post(`/playlists/${id}/songs`, { songId }).then((r) => r.data),
  addSongs: (id: number, songIds: number[]): Promise<{ added: number; alreadyInPlaylist: number }> =>
    api.post(`/playlists/${id}/songs`, { songIds }).then((r) => r.data),
  addFromPlaylist: (id: number, sourcePlaylistId: number) =>
    api.post(`/playlists/${id}/songs/from-playlist`, { sourcePlaylistId }).then((r) => r.data),
  removeSong: (id: number, songId: number) => api.delete(`/playlists/${id}/songs/${songId}`).then((r) => r.data),
  reorder: (id: number, songIds: number[]) => api.put(`/playlists/${id}/songs/reorder`, { songIds }).then((r) => r.data),
};
