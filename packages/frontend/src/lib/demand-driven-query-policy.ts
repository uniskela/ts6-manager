/**
 * Slice 6 PR2 — demand-driven expensive diagnostics.
 *
 * Expensive scans/summaries run only on authorized page entry or manual refresh.
 * PWA recovery, file mutations, channel-list changes, window focus, and idle
 * intervals mark stale / coverage-stale without starting a scan.
 *
 * Files storage summaries are an exception: the Files page uses **manual Refresh
 * only**. A page-entry scan of every channel issues rapid `ftgetfilelist` calls
 * and trips TeamSpeak Query flood protection, taking down the shared SSH session
 * used for ordinary browse. Runtime/media probes may still use one page-entry
 * opportunity.
 */

export const EXPENSIVE_DIAGNOSTIC_QUERY_ROOTS = [
  'file-summaries',
  'runtime-media-diagnostics',
] as const;

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
 * Page-entry attempts keyed by connectionScope (or a fixed global scope such as
 * runtime-media). Survives remounts within the SPA document; full reloads clear
 * the map.
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

type CancelTimer = ReturnType<typeof setTimeout>;

/**
 * Deferred summary cancels keyed by connectionScope. StrictMode remounts
 * re-establish the same scope in the same turn and call retain to abort cancel.
 */
const pendingSummaryCancels = new Map<string, CancelTimer>();

export type SummaryCancelClient = {
  cancelQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

function summaryCancelScopeKey(queryKey: readonly unknown[]): string | null {
  // Expected shape: ['file-summaries', configId, sid]
  if (queryKey.length < 3) return null;
  const configId = queryKey[1];
  const sid = queryKey[2];
  if (typeof configId !== 'number' || typeof sid !== 'number') return null;
  return connectionScope(configId, sid);
}

/** Keep an in-flight summary for this scope (StrictMode same-scope remount). */
export function retainSummaryQueryScope(queryKey: readonly unknown[]): void {
  const scope = summaryCancelScopeKey(queryKey);
  if (!scope) return;
  const pending = pendingSummaryCancels.get(scope);
  if (pending != null) {
    clearTimeout(pending);
    pendingSummaryCancels.delete(scope);
  }
}

/**
 * Cancel after a macrotask so same-scope StrictMode replay can retain first.
 * Real connection changes and unmounts still cancel once the timer fires.
 */
export function deferCancelSummaryQuery(
  queryClient: SummaryCancelClient,
  queryKey: readonly unknown[],
): void {
  const scope = summaryCancelScopeKey(queryKey);
  if (!scope) {
    void queryClient.cancelQueries({ queryKey });
    return;
  }
  const existing = pendingSummaryCancels.get(scope);
  if (existing != null) clearTimeout(existing);
  const keySnapshot = [...queryKey];
  const handle = setTimeout(() => {
    pendingSummaryCancels.delete(scope);
    void queryClient.cancelQueries({ queryKey: keySnapshot });
  }, 0);
  pendingSummaryCancels.set(scope, handle);
}

/** Test-only: drop deferred cancels without firing them. */
export function resetPendingSummaryCancelsForTests(): void {
  for (const handle of pendingSummaryCancels.values()) clearTimeout(handle);
  pendingSummaryCancels.clear();
}

export type PageEntryScanDecision =
  | { action: 'skip'; reason: 'missing-context' | 'already-attempted' | 'offline' }
  | { action: 'authorize-entry-scan'; scope: string };

/** Fixed scope for instance-global runtime/media probes (not per-connection). */
export const RUNTIME_MEDIA_DIAGNOSTICS_SCOPE = 'runtime-media';

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

/**
 * One automatic opportunity for a global (non-connection) expensive diagnostic.
 * Offline entry shows "Not checked." and does not defer a probe until reconnect.
 */
export function decideGlobalPageEntryScan(input: {
  scope: string;
  online: boolean;
}): PageEntryScanDecision {
  if (hasConsumedPageEntryAttempt(input.scope)) {
    return { action: 'skip', reason: 'already-attempted' };
  }
  if (!input.online) {
    return { action: 'skip', reason: 'offline' };
  }
  return { action: 'authorize-entry-scan', scope: input.scope };
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
  /** Channels included in the bounded scan request (≤256). */
  scannedChannelKey: string;
  scannedAt: number;
};

export type ChannelSummaryDisplay =
  | { kind: 'not-checked' }
  | { kind: 'scanning' }
  | { kind: 'stale-cached' }
  | { kind: 'not-scanned' }
  | { kind: 'unavailable' }
  | { kind: 'partial' }
  | { kind: 'ready' }
  | { kind: 'error' };

/**
 * Truthful per-channel label for the storage summary strip.
 * Never presents a missing observation as zero files.
 *
 * `eligibleChannelKey` is the bounded selection that may be scanned (first ≤256).
 * Intentional omissions beyond the cap are `not-scanned`, not stale — including
 * while the eligible channels are still fetching.
 */
export function channelSummaryDisplay(input: {
  offlineUnchecked: boolean;
  isFetching: boolean;
  isError: boolean;
  hasErrorData: boolean;
  observation: SummaryObservation | null;
  /** @deprecated Prefer eligibleChannelKey for stale comparison. */
  currentChannelKey: string;
  /** Bounded eligible set (first ≤256 of current channels). */
  eligibleChannelKey?: string;
  /** Channels beyond the scan cap (never requested). */
  omittedChannelIds?: readonly number[];
  channelId: number;
  summary?: {
    unavailable?: boolean;
    notScanned?: boolean;
    complete?: boolean;
  } | null;
  isQueryInvalidated: boolean;
}): ChannelSummaryDisplay {
  // Cap omissions never scan — classify before fetching so UI never says Scanning…
  if (
    input.summary?.notScanned
    || (input.omittedChannelIds !== undefined
      && input.omittedChannelIds.includes(input.channelId))
  ) {
    return { kind: 'not-scanned' };
  }

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
    if (!scannedIds.has(input.channelId)) {
      return { kind: 'not-scanned' };
    }
    if (input.isError) return { kind: 'error' };
    if (input.summary?.unavailable) return { kind: 'unavailable' };
    const eligibleKey = input.eligibleChannelKey ?? input.currentChannelKey;
    if (
      input.isQueryInvalidated
      || input.observation.scannedChannelKey !== eligibleKey
    ) {
      return { kind: 'stale-cached' };
    }
    if (input.summary && input.summary.complete === false) {
      return { kind: 'partial' };
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
    case 'partial':
      return 'Partial';
    case 'error':
      return 'Check failed.';
    case 'stale-cached':
    case 'ready':
      return null;
  }
}
