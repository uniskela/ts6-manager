import api from './client';
import type { FileSummaryResponse } from './file-summary.types';

const base = (configId: number, sid: number) =>
  `/servers/${configId}/vs/${sid}/files`;

export type { FileSummaryResponse };
export type {
  ChannelFileSummaryResult,
  FileSummaryBudgetSnapshot,
} from './file-summary.types';

export const filesApi = {
  summaries: (
    configId: number,
    sid: number,
    cids: number[],
    opts?: { signal?: AbortSignal },
  ): Promise<FileSummaryResponse> =>
    api
      .get(`${base(configId, sid)}/summary`, {
        params: { cids: cids.join(',') },
        signal: opts?.signal,
        // Storage scans can run up to the server deadline (~20s) plus RTT.
        timeout: 30_000,
      })
      .then((r) => r.data as FileSummaryResponse),
  list: (configId: number, sid: number, cid: number, path = '/') =>
    api.get(`${base(configId, sid)}/${cid}`, { params: { path } }).then((r) => r.data),
  createDir: (configId: number, sid: number, cid: number, dirname: string) =>
    api.post(`${base(configId, sid)}/${cid}/mkdir`, { dirname }).then((r) => r.data),
  delete: (configId: number, sid: number, cid: number, name: string) =>
    api.delete(`${base(configId, sid)}/${cid}/file`, { data: { name } }).then((r) => r.data),
};
