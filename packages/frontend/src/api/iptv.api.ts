import api from './client';

export const iptvApi = {
  // Playlists
  playlists: (serverConfigId?: number) =>
    api.get('/iptv/playlists', { params: serverConfigId ? { serverConfigId } : {} }).then((r) => r.data),
  createPlaylist: (data: { name: string; url: string; serverConfigId: number; autoRefreshMinutes?: number }) =>
    api.post('/iptv/playlists', data).then((r) => r.data),
  updatePlaylist: (id: number, data: { name?: string; url?: string; autoRefreshMinutes?: number }) =>
    api.put(`/iptv/playlists/${id}`, data).then((r) => r.data),
  deletePlaylist: (id: number) => api.delete(`/iptv/playlists/${id}`).then((r) => r.data),
  refreshPlaylist: (id: number) => api.post(`/iptv/playlists/${id}/refresh`).then((r) => r.data),

  // Channels
  groups: (playlistId: number) => api.get(`/iptv/playlists/${playlistId}/groups`).then((r) => r.data),
  channels: (playlistId: number, params: { search?: string; group?: string; page?: number; pageSize?: number }) =>
    api.get(`/iptv/playlists/${playlistId}/channels`, { params }).then((r) => r.data),

  // Streaming (via a music bot's video sidecar)
  stream: (botId: number, channelId: number, preset?: string) =>
    api.post('/iptv/stream', { botId, channelId, preset }).then((r) => r.data),
  stop: (botId: number) => api.post('/iptv/stop', { botId }).then((r) => r.data),
};
