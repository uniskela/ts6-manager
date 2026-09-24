import type { AdminAuditListQuery, AdminAuditListResponse } from '@ts6/common';
import api from './client';

export const auditApi = {
  list: (params: AdminAuditListQuery = {}): Promise<AdminAuditListResponse> =>
    api.get('/audit', { params }).then((r) => r.data),
};
