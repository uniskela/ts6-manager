import api from './client';
import type { ChannelBannerList, HostedChannelBanner, PublicUrlSettings } from '@ts6/common';

export const channelBannersApi = {
  list: (): Promise<ChannelBannerList> => api.get('/channel-banners').then((r) => r.data),
  upload: (file: File): Promise<HostedChannelBanner> => {
    const data = new FormData();
    data.append('file', file);
    return api.post('/channel-banners', data, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    }).then((r) => r.data);
  },
  remove: (name: string) => api.delete(`/channel-banners/${encodeURIComponent(name)}`).then((r) => r.data),
  getPublicUrl: (): Promise<PublicUrlSettings> => api.get('/settings/public-url').then((r) => r.data),
  updatePublicUrl: (publicUrl: string): Promise<PublicUrlSettings> =>
    api.put('/settings/public-url', { publicUrl }).then((r) => r.data),
};
