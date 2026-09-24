import api from './client';
import type {
  ActivityJournalHistoryResponse,
  ActivityJournalRetention,
  ActivityJournalStatus,
  ActivityJournalTarget,
} from '@ts6/common';

export const activityJournalApi = {
  getTargets: () =>
    api.get<{ targets: ActivityJournalTarget[] }>('/activity-journal/targets').then((r) => r.data),

  setTarget: (serverConfigId: number, virtualServerId: number, enabled: boolean) =>
    api
      .put<{ ok: boolean; status: ActivityJournalStatus | null }>('/activity-journal/targets', {
        serverConfigId,
        virtualServerId,
        enabled,
      })
      .then((r) => r.data),

  getStatus: () =>
    api
      .get<{ statuses: ActivityJournalStatus[]; retention: ActivityJournalRetention }>(
        '/activity-journal/status',
      )
      .then((r) => r.data),

  getHistory: (params: {
    serverConfigId?: number;
    virtualServerId?: number;
    cursor?: string;
    limit?: number;
  }) =>
    api
      .get<ActivityJournalHistoryResponse>('/activity-journal/history', { params })
      .then((r) => r.data),

  getRetention: () =>
    api.get<ActivityJournalRetention>('/activity-journal/retention').then((r) => r.data),
};
