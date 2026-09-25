import type { ActivityCaptureStatus } from '@ts6/common';

/** Poll cadence for history while capture is actively running. */
export const ACTIVITY_JOURNAL_HISTORY_REFETCH_MS = 10_000;

/** Faster status poll while capture is arming or recovering. */
export const ACTIVITY_JOURNAL_STATUS_RECOVERY_REFETCH_MS = 5_000;
export const ACTIVITY_JOURNAL_STATUS_IDLE_REFETCH_MS = 15_000;

/**
 * Live-poll history only when capture is on, status is **capturing**, and the
 * user is on the newest page. Connecting / interrupted must not claim Live.
 * Returns `false` so React Query disables the interval otherwise.
 */
export function activityJournalHistoryRefetchInterval(opts: {
  enabled: boolean;
  status: ActivityCaptureStatus;
  onNewestPage: boolean;
}): number | false {
  if (!opts.enabled || !opts.onNewestPage) return false;
  if (opts.status === 'capturing') {
    return ACTIVITY_JOURNAL_HISTORY_REFETCH_MS;
  }
  return false;
}

/** True when the Live badge / “live journal history” copy is accurate. */
export function isActivityJournalLiveCapture(status: ActivityCaptureStatus): boolean {
  return status === 'capturing';
}

/**
 * Status poll cadence: faster while connecting/interrupted so reconnect UX
 * catches up without implying history is Live.
 */
export function activityJournalStatusRefetchInterval(opts: {
  enabled: boolean;
  status: ActivityCaptureStatus | 'unknown';
}): number {
  if (
    opts.enabled
    && (opts.status === 'connecting' || opts.status === 'interrupted')
  ) {
    return ACTIVITY_JOURNAL_STATUS_RECOVERY_REFETCH_MS;
  }
  return ACTIVITY_JOURNAL_STATUS_IDLE_REFETCH_MS;
}
