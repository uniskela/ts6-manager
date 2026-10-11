import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@/api/settings.api';
import {
  consumePageEntryAttempt,
  decideGlobalPageEntryScan,
  expensiveDiagnosticQueryOptions,
  pageEntryAttemptWasOffline,
} from '@/lib/demand-driven-query-policy';

export const MEDIA_ADMIN_DIAGNOSTICS_QUERY_KEY = ['media-admin-diagnostics'] as const;
export const MEDIA_ADMIN_DIAGNOSTICS_SCOPE = 'media-admin';

/** One page-entry probe plus manual refresh. Never polls. */
export function useMediaAdminDiagnostics() {
  const qc = useQueryClient();
  const [offlineUnchecked, setOfflineUnchecked] = useState(false);
  const query = useQuery({
    queryKey: MEDIA_ADMIN_DIAGNOSTICS_QUERY_KEY,
    queryFn: () => settingsApi.getMediaDiagnostics(),
    enabled: false,
    ...expensiveDiagnosticQueryOptions,
  });

  const invalidated = useSyncExternalStore(
    (onChange) => qc.getQueryCache().subscribe(onChange),
    () => qc.getQueryState(MEDIA_ADMIN_DIAGNOSTICS_QUERY_KEY)?.isInvalidated ?? false,
    () => false,
  );

  useEffect(() => {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine;
    const decision = decideGlobalPageEntryScan({ scope: MEDIA_ADMIN_DIAGNOSTICS_SCOPE, online });
    if (decision.action === 'skip') {
      if (decision.reason === 'already-attempted') {
        setOfflineUnchecked(pageEntryAttemptWasOffline(MEDIA_ADMIN_DIAGNOSTICS_SCOPE));
      } else if (decision.reason === 'offline') {
        consumePageEntryAttempt(MEDIA_ADMIN_DIAGNOSTICS_SCOPE, true);
        setOfflineUnchecked(true);
      }
      return;
    }
    consumePageEntryAttempt(decision.scope, false);
    setOfflineUnchecked(false);
    void query.refetch();
    // Page-entry latch is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    consumePageEntryAttempt(MEDIA_ADMIN_DIAGNOSTICS_SCOPE, false);
    setOfflineUnchecked(false);
    void query.refetch();
  }, [query]);

  return {
    report: query.data,
    isFetching: query.isFetching,
    isError: query.isError,
    invalidated,
    offlineUnchecked,
    notChecked: offlineUnchecked && !query.data && !query.isFetching,
    refresh,
  };
}
