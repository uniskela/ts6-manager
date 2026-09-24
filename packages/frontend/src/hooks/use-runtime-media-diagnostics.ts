import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/settings.api';
import {
  consumePageEntryAttempt,
  decideGlobalPageEntryScan,
  expensiveDiagnosticQueryOptions,
  pageEntryAttemptWasOffline,
  RUNTIME_MEDIA_DIAGNOSTICS_SCOPE,
} from '../lib/demand-driven-query-policy';

export const RUNTIME_MEDIA_DIAGNOSTICS_QUERY_KEY = ['runtime-media-diagnostics'] as const;

/**
 * Demand-driven runtime/media diagnostics. One page-entry probe opportunity
 * (global scope) plus manual refresh. Never attaches a refetchInterval.
 */
export function useRuntimeMediaDiagnostics(opts?: { autoEntry?: boolean }) {
  const autoEntry = opts?.autoEntry !== false;
  const qc = useQueryClient();
  const [offlineUnchecked, setOfflineUnchecked] = useState(false);

  const query = useQuery({
    queryKey: RUNTIME_MEDIA_DIAGNOSTICS_QUERY_KEY,
    queryFn: () => settingsApi.getRuntimeDiagnostics(),
    enabled: false,
    ...expensiveDiagnosticQueryOptions,
  });

  const invalidated = useSyncExternalStore(
    (onChange) => qc.getQueryCache().subscribe(onChange),
    () => qc.getQueryState(RUNTIME_MEDIA_DIAGNOSTICS_QUERY_KEY)?.isInvalidated ?? false,
    () => false,
  );

  useEffect(() => {
    if (!autoEntry) return;
    const online = typeof navigator === 'undefined' ? true : navigator.onLine;
    const decision = decideGlobalPageEntryScan({
      scope: RUNTIME_MEDIA_DIAGNOSTICS_SCOPE,
      online,
    });
    if (decision.action === 'skip') {
      if (decision.reason === 'already-attempted') {
        setOfflineUnchecked(pageEntryAttemptWasOffline(RUNTIME_MEDIA_DIAGNOSTICS_SCOPE));
      } else if (decision.reason === 'offline') {
        consumePageEntryAttempt(RUNTIME_MEDIA_DIAGNOSTICS_SCOPE, true);
        setOfflineUnchecked(true);
      }
      return;
    }
    consumePageEntryAttempt(decision.scope, false);
    setOfflineUnchecked(false);
    void query.refetch();
    // Page-entry latch is intentional; do not re-run on refetch identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEntry]);

  const refresh = useCallback(() => {
    consumePageEntryAttempt(RUNTIME_MEDIA_DIAGNOSTICS_SCOPE, false);
    setOfflineUnchecked(false);
    void query.refetch();
  }, [query]);

  const notChecked = offlineUnchecked && !query.data && !query.isFetching;

  return {
    report: query.data,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    invalidated,
    offlineUnchecked,
    notChecked,
    refresh,
  };
}
