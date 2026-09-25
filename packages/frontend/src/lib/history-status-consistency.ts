/**
 * Slice 6 PR6 — history/status consistency helpers.
 *
 * Scope changes and failed refreshes must not preserve misleading
 * "current" labels (Disabled / Capturing / Live / up to date).
 */

import type { ActivityCaptureStatus, ActivityJournalStatus } from '@ts6/common';

/** Stable scope string for connection + virtual-server selection. */
export function connectionSidScopeKey(
  configId: number | null | undefined,
  sid: number | null | undefined,
): string {
  return `${configId ?? 'none'}:${sid ?? 'none'}`;
}

/**
 * Reset cursor (and optional filters) synchronously when the operator scope
 * changes. useEffect resets leave one render that can fetch with a stale
 * cursor under the new connection/SID key.
 */
export function nextScopedCursorStack<T>(
  current: { scopeKey: string; cursorStack: T[] },
  nextScopeKey: string,
  emptyStack: T[],
): { scopeKey: string; cursorStack: T[] } {
  if (current.scopeKey === nextScopeKey) return current;
  return { scopeKey: nextScopeKey, cursorStack: emptyStack };
}

export type CaptureStatusDisplay =
  | { kind: 'unknown' }
  | { kind: 'stale'; status: ActivityCaptureStatus }
  | { kind: 'current'; status: ActivityCaptureStatus };

/**
 * Resolve capture status for the selected pair without defaulting unknown
 * loads/errors to "Disabled".
 *
 * - No successful status payload yet → unknown
 * - Payload present, pair absent → disabled (current)
 * - Payload present, pair found, last fetch failed → stale (last known)
 * - Payload present, pair found, fetch ok → current
 */
export function resolveCaptureStatusDisplay(opts: {
  configId: number | null | undefined;
  sid: number | null | undefined;
  statuses: ActivityJournalStatus[] | undefined;
  statusQueryStatus: 'pending' | 'error' | 'success';
  /** True when React Query still has a previous successful payload after an error. */
  hasStatusData: boolean;
}): CaptureStatusDisplay {
  const { configId, sid, statuses, statusQueryStatus, hasStatusData } = opts;
  if (configId == null || sid == null) return { kind: 'unknown' };

  const pair = statuses?.find(
    (row) => row.serverConfigId === configId && row.virtualServerId === sid,
  );

  if (!hasStatusData || statuses == null) {
    return { kind: 'unknown' };
  }

  const status: ActivityCaptureStatus = pair?.status ?? 'disabled';

  // Keep last known row after a failed refresh, but never label it as fresh.
  if (statusQueryStatus === 'error') {
    return { kind: 'stale', status };
  }

  return { kind: 'current', status };
}

export function captureStatusLabel(
  display: CaptureStatusDisplay,
  opts?: { reconnectAttempt?: number },
): string {
  if (display.kind === 'unknown') return 'Unknown';
  let base = CAPTURE_STATUS_LABEL[display.status];
  if (
    display.status === 'interrupted'
    && (opts?.reconnectAttempt ?? 0) > 0
  ) {
    base = 'Interrupted — reconnecting';
  }
  return display.kind === 'stale' ? `${base} (stale)` : base;
}

export const CAPTURE_STATUS_LABEL: Record<ActivityCaptureStatus, string> = {
  disabled: 'Disabled',
  connecting: 'Connecting',
  capturing: 'Capturing',
  interrupted: 'Interrupted',
  persistence_error: 'Persistence error',
};

/**
 * Live / idle / degraded copy for history surfaces. Failed refreshes must not
 * keep an "up to date" or "Live" claim.
 */
export function historyRefreshPresentation(opts: {
  isFetching: boolean;
  hasError: boolean;
  /** True when auto-poll is actually armed (newest page + policy). */
  livePolling: boolean;
  idleLiveLabel?: string;
  idleStaticLabel?: string;
  refreshingLabel?: string;
  degradedLabel?: string;
}): {
  tone: 'live' | 'degraded';
  idleLabel: string;
  refreshingLabel: string;
  degradedLabel: string;
  showLiveBadge: boolean;
} {
  const idleLiveLabel = opts.idleLiveLabel ?? 'Live history active';
  const idleStaticLabel = opts.idleStaticLabel ?? 'History up to date';
  const refreshingLabel = opts.refreshingLabel ?? 'Refreshing history…';
  const degradedLabel = opts.degradedLabel ?? 'History updates interrupted';

  return {
    tone: opts.hasError ? 'degraded' : 'live',
    idleLabel: opts.livePolling ? idleLiveLabel : idleStaticLabel,
    refreshingLabel,
    degradedLabel,
    showLiveBadge: opts.livePolling && !opts.hasError && !opts.isFetching,
  };
}
