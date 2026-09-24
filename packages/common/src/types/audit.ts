/** Administrative audit types (#91 Slice 4). Shared FE/BE — no secret payloads. */

export const ADMIN_AUDIT_ACTIONS = [
  'client.kick',
  'client.ban',
  'ban.create',
  'ban.delete',
  'ban.delete_all',
  'connection.create',
  'connection.update',
  'connection.credentials_changed',
  'connection.delete',
  'flow.create',
  'flow.update',
  'flow.delete',
  'flow.enable',
  'flow.disable',
  'user.create',
  'user.update',
  'user.delete',
  'settings.yt_cookies_changed',
  'settings.yt_cookies_removed',
  'settings.limits_update',
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export const ADMIN_AUDIT_OUTCOMES = [
  'pending',
  'success',
  'failure',
  'partial',
  'unknown',
] as const;

export type AdminAuditOutcome = (typeof ADMIN_AUDIT_OUTCOMES)[number];

/** Allow-listed result codes only — never raw exception text. */
export const ADMIN_AUDIT_RESULT_CODES = [
  'ok',
  'ts_error',
  'timeout',
  'network_error',
  'engine_reload_failed',
  'pool_refresh_failed',
  'not_found',
  'validation_failed',
  'storage_failed',
  'unknown',
] as const;

export type AdminAuditResultCode = (typeof ADMIN_AUDIT_RESULT_CODES)[number];

export const ADMIN_AUDIT_TARGET_TYPES = [
  'client',
  'ban',
  'connection',
  'flow',
  'user',
  'settings',
] as const;

export type AdminAuditTargetType = (typeof ADMIN_AUDIT_TARGET_TYPES)[number];

export interface AdminAuditEventDto {
  id: string;
  operationId: string;
  actorUserId: number;
  actorUsername: string | null;
  action: AdminAuditAction;
  connectionId: number | null;
  virtualServerId: number | null;
  targetType: AdminAuditTargetType | null;
  targetId: string | null;
  outcome: AdminAuditOutcome;
  resultCode: AdminAuditResultCode | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminAuditListResponse {
  items: AdminAuditEventDto[];
  nextCursor: string | null;
  retention: {
    maxAgeDays: number;
    maxRows: number;
  };
}

export interface AdminAuditListQuery {
  cursor?: string;
  limit?: number;
  action?: AdminAuditAction;
  actorUserId?: number;
  connectionId?: number;
  virtualServerId?: number;
  outcome?: AdminAuditOutcome;
  from?: string;
  to?: string;
}
