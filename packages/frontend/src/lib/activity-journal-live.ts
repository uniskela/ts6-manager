import type { ActivityCaptureStatus } from '@ts6/common';

/** Poll cadence for history while capture is actively running. */
export const ACTIVITY_JOURNAL_HISTORY_REFETCH_MS = 10_000;

/**
 * Live-poll history only when capture is on, the capture loop is connecting or
 * capturing, and the user is on the newest page (cursor stack root).
 * Returns `false` so React Query disables the interval otherwise.
 */
export function activityJournalHistoryRefetchInterval(opts: {
  enabled: boolean;
  status: ActivityCaptureStatus;
  onNewestPage: boolean;
}): number | false {
  if (!opts.enabled || !opts.onNewestPage) return false;
  if (opts.status === 'capturing' || opts.status === 'connecting') {
    return ACTIVITY_JOURNAL_HISTORY_REFETCH_MS;
  }
  return false;
}
