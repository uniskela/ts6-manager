/**
 * Slice 6 PR2 — demand-driven expensive diagnostics.
 *
 * Expensive scans/summaries run only on authorized page entry or manual refresh.
 * PWA recovery, file mutations, channel-list changes, window focus, and idle
 * intervals mark stale / coverage-stale without starting a scan.
 */

export const EXPENSIVE_DIAGNOSTIC_QUERY_ROOTS = ['file-summaries'] as const;

export type DemandDrivenKind = 'expensive-diagnostic' | 'ordinary';

export type DemandDrivenQueryMeta = {
  demandDriven?: DemandDrivenKind;
};

/** Shared TanStack options so mount/focus/reconnect cannot start a scan. */
export const expensiveDiagnosticQueryOptions = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 5 * 60_000,
  refetchOnMount: false as const,
  refetchOnWindowFocus: false as const,
  refetchOnReconnect: false as const,
  retry: false as const,
  meta: { demandDriven: 'expensive-diagnostic' as const },
};

export function isExpensiveDiagnosticQueryKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return (
    typeof root === 'string'
    && (EXPENSIVE_DIAGNOSTIC_QUERY_ROOTS as readonly string[]).includes(root)
  );
}

export function isExpensiveDiagnosticQuery(query: {
  queryKey: readonly unknown[];
  meta?: DemandDrivenQueryMeta;
}): boolean {
  if (query.meta?.demandDriven === 'expensive-diagnostic') return true;
  if (query.meta?.demandDriven === 'ordinary') return false;
  return isExpensiveDiagnosticQueryKey(query.queryKey);
}

export type QueryClientLike = {
  invalidateQueries: (filters?: {
    queryKey?: readonly unknown[];
    predicate?: (query: { queryKey: readonly unknown[]; meta?: DemandDrivenQueryMeta }) => boolean;
    refetchType?: 'active' | 'inactive' | 'all' | 'none';
  }) => Promise<unknown>;
};

/**
 * PWA recovery: refresh ordinary live queries; mark expensive diagnostics stale
 * without refetch (`refetchType: 'none'`).
 */
export async function invalidateAfterPwaRecovery(queryClient: QueryClientLike): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      predicate: (query) => isExpensiveDiagnosticQuery(query),
      refetchType: 'none',
    }),
    queryClient.invalidateQueries({
      predicate: (query) => !isExpensiveDiagnosticQuery(query),
    }),
  ]);
}

/** Mark an expensive diagnostic stale without authorizing a new probe. */
export async function markExpensiveDiagnosticStale(
  queryClient: QueryClientLike,
  queryKey: readonly unknown[],
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey,
    refetchType: 'none',
  });
}

export function connectionScope(configId: number, sid: number): string {
  return `${configId}:${sid}`;
}

export function channelCoverageKey(channelIds: readonly number[]): string {
  return channelIds.join(',');
}

/**
 * Page-entry attempts keyed by connectionScope. Survives `/files` remounts within
 * the SPA document (same pattern as safe-ui latch); full reloads clear the map.
 */
const pageEntryAttempts = new Map<string, { offlineUnchecked: boolean }>();

export function hasConsumedPageEntryAttempt(scope: string): boolean {
  return pageEntryAttempts.has(scope);
}

export function consumePageEntryAttempt(scope: string, offlineUnchecked = false): void {
  pageEntryAttempts.set(scope, { offlineUnchecked });
}

export function pageEntryAttemptWasOffline(scope: string): boolean {
  return pageEntryAttempts.get(scope)?.offlineUnchecked === true;
}

/** Test-only: clear between cases in the same document. */
export function resetPageEntryAttemptsForTests(): void {
  pageEntryAttempts.clear();
}

export type PageEntryScanDecision =
  | { action: 'skip'; reason: 'missing-context' | 'already-attempted' | 'offline' }
  | { action: 'authorize-entry-scan'; scope: string };

/**
 * One automatic opportunity per connection scope after context is valid.
 * Offline entry does not authorize a deferred scan — callers show "Not checked."
 */
export function decidePageEntryScan(input: {
  configId: number | null | undefined;
  sid: number | null | undefined;
  hasChannels: boolean;
  online: boolean;
  entryAttemptScope: string | null;
}): PageEntryScanDecision {
  if (!input.configId || !input.sid || !input.hasChannels) {
    return { action: 'skip', reason: 'missing-context' };
  }
  const scope = connectionScope(input.configId, input.sid);
  if (input.entryAttemptScope === scope) {
    return { action: 'skip', reason: 'already-attempted' };
  }
  if (!input.online) {
    return { action: 'skip', reason: 'offline' };
  }
  return { action: 'authorize-entry-scan', scope };
}

export type DiagnosticTrigger =
  | 'page-entry-authorized'
  | 'manual-refresh'
  | 'pwa-recovery'
  | 'file-mutation'
  | 'channel-list-change'
  | 'connection-revision'
  | 'window-focus'
  | 'idle-interval'
  | 'config-edit';

/** Enforcement companion to query meta — only entry + refresh may scan. */
export function shouldScanOnTrigger(trigger: DiagnosticTrigger): boolean {
  return trigger === 'page-entry-authorized' || trigger === 'manual-refresh';
}

export type SummaryObservation = {
  scannedChannelKey: string;
  scannedAt: number;
};

export type ChannelSummaryDisplay =
  | { kind: 'not-checked' }
  | { kind: 'scanning' }
  | { kind: 'stale-cached' }
  | { kind: 'not-scanned' }
  | { kind: 'unavailable' }
  | { kind: 'ready' }
  | { kind: 'error' };

/**
 * Truthful per-channel label for the storage summary strip.
 * Never presents a missing observation as zero files.
 */
export function channelSummaryDisplay(input: {
  offlineUnchecked: boolean;
  isFetching: boolean;
  isError: boolean;
  hasErrorData: boolean;
  observation: SummaryObservation | null;
  currentChannelKey: string;
  channelId: number;
  summary?: { unavailable?: boolean } | null;
  isQueryInvalidated: boolean;
}): ChannelSummaryDisplay {
  if (input.isFetching && !input.summary) return { kind: 'scanning' };
  if (input.offlineUnchecked && !input.observation) return { kind: 'not-checked' };
  if (input.isError && !input.observation) return { kind: 'error' };

  if (input.observation) {
    const scannedIds = new Set(
      input.observation.scannedChannelKey
        .split(',')
        .filter(Boolean)
        .map(Number),
    );
    if (!scannedIds.has(input.channelId)) return { kind: 'not-scanned' };
    if (input.isError) return { kind: 'error' };
    if (input.summary?.unavailable) return { kind: 'unavailable' };
    if (
      input.isQueryInvalidated
      || input.observation.scannedChannelKey !== input.currentChannelKey
    ) {
      return { kind: 'stale-cached' };
    }
    return { kind: 'ready' };
  }

  if (input.isFetching) return { kind: 'scanning' };
  return { kind: 'not-checked' };
}

export function channelSummaryLabelText(display: ChannelSummaryDisplay): string | null {
  switch (display.kind) {
    case 'not-checked':
      return 'Not checked.';
    case 'scanning':
      return 'Scanning…';
    case 'not-scanned':
      return 'Not scanned.';
    case 'unavailable':
      return 'Unavailable';
    case 'error':
      return 'Check failed.';
    case 'stale-cached':
    case 'ready':
      return null;
  }
}
