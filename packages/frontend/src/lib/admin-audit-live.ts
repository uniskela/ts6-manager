/** Poll cadence for administrative audit while viewing the newest page. */
export const ADMIN_AUDIT_HISTORY_REFETCH_MS = 10_000;

/**
 * Live-poll audit history only on the newest page (cursor stack root).
 * Older pages stay frozen so paging is stable. Returns `false` to disable.
 */
export function adminAuditHistoryRefetchInterval(opts: {
  onNewestPage: boolean;
}): number | false {
  if (!opts.onNewestPage) return false;
  return ADMIN_AUDIT_HISTORY_REFETCH_MS;
}
