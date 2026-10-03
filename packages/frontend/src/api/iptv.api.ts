import api from './client';
import { videoStartRequest, type VideoStartOptions } from '@/lib/video-options';

export const iptvApi = {
  // Playlists
  playlists: (serverConfigId?: number) =>
    api.get('/iptv/playlists', { params: serverConfigId ? { serverConfigId } : {} }).then((r) => r.data),
  createPlaylist: (data: { name: string; url: string; serverConfigId: number; autoRefreshMinutes?: number }) =>
    api.post('/iptv/playlists', data).then((r) => r.data),
  uploadPlaylist: (data: { name: string; serverConfigId: number; file: File }) => {
    const formData = new FormData();
    formData.append('name', data.name);
    formData.append('serverConfigId', String(data.serverConfigId));
    formData.append('playlist', data.file);
    return api.post('/iptv/playlists/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    }).then((r) => r.data);
  },
  replacePlaylistFile: (id: number, file: File) => {
    const formData = new FormData();
    formData.append('playlist', file);
    return api.post(`/iptv/playlists/${id}/replace`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    }).then((r) => r.data);
  },
  updatePlaylist: (id: number, data: { name?: string; url?: string; autoRefreshMinutes?: number }) =>
    api.put(`/iptv/playlists/${id}`, data).then((r) => r.data),
  deletePlaylist: (id: number) => api.delete(`/iptv/playlists/${id}`).then((r) => r.data),
  refreshPlaylist: (id: number) => api.post(`/iptv/playlists/${id}/refresh`).then((r) => r.data),

  // Channels
  groups: (playlistId: number) => api.get(`/iptv/playlists/${playlistId}/groups`).then((r) => r.data),
  consoleGroups: (serverConfigId: number, playlistId?: number) => api.get('/iptv/groups', {
    params: { serverConfigId, ...(playlistId ? { playlistId } : {}) },
  }).then((r) => r.data),
  channels: (playlistId: number, params: { search?: string; group?: string; page?: number; pageSize?: number }) =>
    api.get(`/iptv/playlists/${playlistId}/channels`, { params }).then((r) => r.data),
  consoleChannels: (params: { serverConfigId: number; playlistId?: number; group?: string; search?: string; page?: number; pageSize?: number }) =>
    api.get('/iptv/channels', { params }).then((r) => r.data),

  // Streaming (via a music bot's video sidecar)
  stream: (botId: number, channelId: number, options?: string | VideoStartOptions) => {
    const video = typeof options === 'string'
      ? { preset: options }
      : options ? videoStartRequest(options) : {};
    return api.post('/iptv/stream', { botId, channelId, ...video }).then((r) => r.data);
  },
  stop: (botId: number) => api.post('/iptv/stop', { botId }).then((r) => r.data),
};
