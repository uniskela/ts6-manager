import api from './client';

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

  getLimits: () => api.get('/settings/limits').then((r) => r.data),

  updateLimits: (data: { maxVideoDuration?: number; maxPlaylistImport?: number }) =>
    api.put('/settings/limits', data).then((r) => r.data),
};
