import api from './client';
import type {
  RuntimeMediaDiagnosticReport,
  VideoEncoderCapabilities,
  VideoStreamSettings,
} from '@ts6/common';

export interface ServerVideoStreamingSettings {
  global: VideoStreamSettings;
  overrides: Partial<VideoStreamSettings>;
  effective: VideoStreamSettings;
}

export const settingsApi = {
  getYtCookieStatus: () => api.get('/settings/yt-cookies').then((r) => r.data),

  uploadYtCookieFile: (file: File) => {
    const formData = new FormData();
    formData.append('cookies', file);
    return api.post('/settings/yt-cookies', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data);
  },

  uploadYtCookieText: (text: string) =>
    api.post('/settings/yt-cookies', { text }).then((r) => r.data),

  deleteYtCookies: () => api.delete('/settings/yt-cookies').then((r) => r.data),

  /** Demand-driven bounded media tool + sidecar probes (not polled). */
  getRuntimeDiagnostics: (): Promise<RuntimeMediaDiagnosticReport> =>
    api.get('/settings/runtime-diagnostics').then((r) => r.data),

  getLimits: () => api.get('/settings/limits').then((r) => r.data),

  updateLimits: (data: { maxVideoDuration?: number; maxPlaylistImport?: number }) =>
    api.put('/settings/limits', data).then((r) => r.data),

  getVideoStreaming: (): Promise<VideoStreamSettings> =>
    api.get('/settings/video-streaming').then((r) => r.data),

  updateVideoStreaming: (data: Partial<VideoStreamSettings>): Promise<VideoStreamSettings> =>
    api.put('/settings/video-streaming', data).then((r) => r.data),

  getServerVideoStreaming: (serverConfigId: number): Promise<ServerVideoStreamingSettings> =>
    api.get(`/settings/video-streaming/servers/${serverConfigId}`).then((r) => r.data),

  /** Replace one server's overrides; `{}` returns the server to the global defaults. */
  updateServerVideoStreaming: (
    serverConfigId: number,
    data: Partial<VideoStreamSettings>,
  ): Promise<ServerVideoStreamingSettings> =>
    api.put(`/settings/video-streaming/servers/${serverConfigId}`, data).then((r) => r.data),

  /** Encoder test encodes run on the sidecar; demand-driven only (first call / refresh). */
  getVideoEncoders: (refresh = false): Promise<VideoEncoderCapabilities> =>
    api.get('/settings/video-encoders', { params: refresh ? { refresh: '1' } : undefined, timeout: 60000 })
      .then((r) => r.data),
};
