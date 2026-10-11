import api from './client';
import type { ServerIcon, ServerIconList } from '@ts6/common';

const base = (configId: number, sid: number) => `/servers/${configId}/vs/${sid}/icons`;

export const iconsApi = {
  list: (configId: number, sid: number): Promise<ServerIconList> => api.get(base(configId, sid)).then((r) => ({
    maxBytes: Number(r.data?.maxBytes) || 256 * 1024,
    truncated: r.data?.truncated === true,
    icons: Array.isArray(r.data?.icons) ? r.data.icons : [],
  })),
  /** Icon previews need the session token, so they are fetched as blobs rather than by `<img src>`. */
  image: (configId: number, sid: number, id: number): Promise<Blob> =>
    api.get(`${base(configId, sid)}/${id}`, { responseType: 'blob', timeout: 60000 }).then((r) => r.data),
  upload: (configId: number, sid: number, file: File): Promise<ServerIcon> => {
    const data = new FormData();
    data.append('file', file);
    return api.post(base(configId, sid), data, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    }).then((r) => r.data);
  },
  remove: (configId: number, sid: number, id: number) => api.delete(`${base(configId, sid)}/${id}`).then((r) => r.data),
};
