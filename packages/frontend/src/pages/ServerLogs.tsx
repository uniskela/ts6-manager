import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ServerLogPage } from '@ts6/common';
import { LOGVIEW_MAX_LINES } from '@ts6/common';
import { logsApi } from '@/api/bans.api';
import { useServerStore } from '@/stores/server.store';
import { useServers, useVirtualServers } from '@/hooks/use-servers';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { RefreshStatus, StaleDataNotice } from '@/components/shared/RefreshStatus';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChevronLeft, ChevronRight, RefreshCw, ScrollText, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  apiErrorMessage,
  isTeamSpeakLogviewIo,
  isTeamSpeakStarting,
  teamSpeakConnectionTitle,
  teamSpeakQueryRetry,
  teamSpeakQueryRetryDelay,
  teamSpeakRefreshTone,
} from '@/lib/api-error';
import {
  formatLogTimestamp,
  levelBadgeLabel,
  logLevelMatchesFilter,
  parseServerLogLine,
  type ServerLogLevel,
} from '@/lib/server-logs';
import { formatLocalDateTime } from '@/lib/formatting';

const LEVEL_COLORS: Record<ServerLogLevel, string> = {
  ERROR: 'text-destructive bg-destructive/10 border-destructive/20',
  WARNING: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
  INFO: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
  DEBUG: 'text-muted-foreground bg-muted/50 border-border/50',
  UNKNOWN: 'text-muted-foreground bg-muted/30 border-border/40',
};

const PAGE_SIZE_OPTIONS = ['50', '100'] as const;

export default function ServerLogs() {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const { data: servers } = useServers();
  const { data: virtualServers, isLoading: virtualServersLoading, error: virtualServersError, refetch: refetchVirtualServers, isFetching: virtualServersFetching } = useVirtualServers();

  const [lines, setLines] = useState<string>('100');
  const [instanceMode, setInstanceMode] = useState(false);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('ALL');
  /** Stack of begin_pos values for Previous; empty means newest page. */
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const beginPos = cursorStack.length ? cursorStack[cursorStack.length - 1] : null;

  // Reset paging when the operator changes server context or page size / scope.
  useEffect(() => {
    setCursorStack([]);
    setFilter('');
    setLevelFilter('ALL');
  }, [c, s, lines, instanceMode]);

  const pageSize = Math.min(LOGVIEW_MAX_LINES, Math.max(1, parseInt(lines, 10) || 100));

  const query = useQuery({
    queryKey: ['logs', c, s, pageSize, instanceMode, beginPos],
    queryFn: () => logsApi.getPage(c!, s!, {
      lines: pageSize,
      reverse: 1,
      instance: instanceMode ? 1 : 0,
      beginPos,
    }),
    enabled: !!c && !!s,
    retry: teamSpeakQueryRetry,
    retryDelay: teamSpeakQueryRetryDelay,
  });

  const page = query.data as ServerLogPage | undefined;
  const parsedEntries = useMemo(
    () => (page?.entries ?? []).map((entry) => ({
      ...entry,
      parsed: parseServerLogLine(entry.sourceText),
    })),
    [page],
  );

  const filtered = useMemo(() => {
    return parsedEntries.filter((entry) => {
      if (!logLevelMatchesFilter(entry.parsed.level, levelFilter)) return false;
      if (filter && !entry.sourceText.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    });
  }, [parsedEntries, filter, levelFilter]);

  const connection = servers?.find((server: any) => Number(server.id) === c);
  const virtualServer = virtualServers?.find((server: any) => Number(server.virtualserver_id) === s);
  const contextIsValid = !!virtualServers?.some((server: any) => Number(server.virtualserver_id) === s);
  const hasPage = !!page;
  const gateError = query.error || virtualServersError;
  const isFetchingGate = query.isFetching || virtualServersFetching;

  const retryGate = () => {
    void refetchVirtualServers();
    void query.refetch();
  };

  const refreshNewest = () => {
    if (cursorStack.length > 0) {
      setCursorStack([]);
      return;
    }
    void query.refetch();
  };

  const goOlder = () => {
    if (!page?.nextBeginPos) return;
    setCursorStack((prev) => [...prev, page.nextBeginPos!]);
  };

  const goPrevious = () => {
    setCursorStack((prev) => prev.slice(0, -1));
  };

  if (!c || !s) return <EmptyState icon={ScrollText} title="No server selected" />;

  if (gateError && !hasPage) {
    const logviewIo = isTeamSpeakLogviewIo(gateError);
    return (
      <div className="space-y-4">
        <EmptyState
          icon={ScrollText}
          title={teamSpeakConnectionTitle(gateError)}
          description={apiErrorMessage(
            gateError,
            logviewIo
              ? 'TeamSpeak could not read its logfile (permissions, lock, or rotation). Manager is connected — use Retry once after a few seconds, or check the TeamSpeak logs volume.'
              : isTeamSpeakStarting(gateError)
                ? 'TeamSpeak Query is still coming up after startup. Wait a moment and retry.'
                : 'Could not load server logs from TeamSpeak.',
          )}
        />
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={retryGate} disabled={isFetchingGate}>
            {isFetchingGate ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    );
  }

  if ((query.isLoading || virtualServersLoading || !contextIsValid) && !hasPage) {
    return <PageLoader />;
  }

  const backgroundError = gateError
    ? apiErrorMessage(
      gateError,
      isTeamSpeakLogviewIo(gateError)
        ? 'TeamSpeak could not read its logfile. The last successful page is still displayed — Retry once; do not leave this page auto-refreshing.'
        : isTeamSpeakStarting(gateError)
          ? 'TeamSpeak Query is still starting. Log data may be incomplete until it comes online.'
          : 'Log refresh failed. The last successful page is still displayed.',
    )
    : null;
  const refreshTone = !contextIsValid && !gateError
    ? 'starting'
    : teamSpeakRefreshTone(gateError);

  const filtersActive = filter.length > 0 || levelFilter !== 'ALL';
  const scopeMismatch = hasPage && page.context.instance !== instanceMode;
  const emptyMessage = (() => {
    if (filtered.length > 0) return null;
    if (parsedEntries.length === 0) {
      if (beginPos) {
        return 'No older log entries for this cursor. Refresh for the newest page if the log rotated.';
      }
      if (instanceMode) {
        return 'Instance log returned no entries. The TeamSpeak instance logfile may be empty, or instance logview is unavailable for this connection.';
      }
      return 'No virtual server log entries on this page.';
    }
    if (filtersActive) return 'No matches on this page.';
    return null;
  })();

  const scopeLabel = instanceMode
    ? 'Instance log (not scoped to the selected virtual server)'
    : `Virtual server log · SID ${s}${virtualServer?.virtualserver_name ? ` · ${virtualServer.virtualserver_name}` : ''}`;

  return (
    <div className="space-y-4" data-testid="server-logs-page">
      <PageHeader
        title="Server Logs"
        icon={ScrollText}
        description={(
          <div className="space-y-1">
            <p>
              Connection: {connection?.name ?? `config ${c}`}
            </p>
            <p data-testid="logs-scope-label">{scopeLabel}</p>
            {page?.fetchedAt && (
              <p className="text-xs">Fetched {formatLocalDateTime(page.fetchedAt)}</p>
            )}
          </div>
        )}
        actions={(
          <Button size="sm" variant="outline" onClick={refreshNewest} disabled={isFetchingGate} aria-busy={isFetchingGate}>
            <RefreshCw className={cn('h-4 w-4 mr-1', query.isFetching && 'animate-spin')} /> Refresh
          </Button>
        )}
        metadata={(
          <RefreshStatus
            isRefreshing={isFetchingGate}
            tone={refreshTone}
            idleLabel="Log page up to date"
            refreshingLabel="Refreshing logs…"
            degradedLabel="Log updates interrupted"
            startingLabel="Waiting for TeamSpeak Query…"
          />
        )}
      />

      {backgroundError && (
        <StaleDataNotice
          message={backgroundError}
          onRetry={retryGate}
          isRetrying={isFetchingGate}
        />
      )}

      {scopeMismatch && (
        <StaleDataNotice
          message="Log scope response did not match the selected Instance / Virtual server mode. Refresh to reload."
          onRetry={retryGate}
          isRetrying={isFetchingGate}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter this page…"
            aria-label="Filter this page"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="h-9 w-[calc(50%-0.25rem)] min-w-28 flex-1 text-xs sm:w-[150px] sm:flex-none" aria-label="Level filter this page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All levels (this page)</SelectItem>
            <SelectItem value="ERROR">Error (this page)</SelectItem>
            <SelectItem value="WARNING">Warning (this page)</SelectItem>
            <SelectItem value="INFO">Info (this page)</SelectItem>
            <SelectItem value="DEBUG">Debug (this page)</SelectItem>
            <SelectItem value="UNKNOWN">Unknown (this page)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={lines} onValueChange={setLines}>
          <SelectTrigger className="h-9 w-[calc(50%-0.25rem)] min-w-28 flex-1 text-xs sm:w-[130px] sm:flex-none" aria-label="Page size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((value) => (
              <SelectItem key={value} value={value}>{value} lines</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={instanceMode ? 'instance' : 'vs'} onValueChange={(v) => setInstanceMode(v === 'instance')}>
          <SelectTrigger className="h-9 w-full min-w-40 flex-1 text-xs sm:w-[200px] sm:flex-none" aria-label="Log source scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="vs">Virtual server log</SelectItem>
            <SelectItem value="instance">Instance log</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="logs-filter-hint">
        Search and level filters apply to this page only. They do not fetch older history.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={goPrevious}
          disabled={cursorStack.length === 0 || query.isFetching}
          data-testid="logs-previous"
        >
          <ChevronLeft className="h-4 w-4 mr-1" /> Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={goOlder}
          disabled={!page?.nextBeginPos || query.isFetching}
          data-testid="logs-older"
        >
          Older <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="logs-page-meta">
          {cursorStack.length === 0 ? 'Newest page' : `Older page ${cursorStack.length}`}
          {page?.nextBeginPos ? '' : ' · end of available cursor'}
        </span>
      </div>

      <div className="min-w-0 rounded-md border border-border bg-card overflow-hidden shadow-sm">
        <ScrollArea className="h-[max(18rem,calc(100dvh-22rem))] sm:h-[calc(100dvh-300px)]">
          <div className="p-3 space-y-0.5 min-w-0">
            {emptyMessage ? (
              <p className="text-center text-muted-foreground text-sm py-10" data-testid="logs-empty">
                {emptyMessage}
              </p>
            ) : (
              filtered.map((entry, i) => {
                const { text: tsText, zoneLabel } = formatLogTimestamp(entry.parsed);
                return (
                  <div
                    key={`${entry.lastPos ?? 'row'}-${i}`}
                    className="flex min-w-0 items-start gap-2 py-0.5 group hover:bg-muted/10 rounded px-1"
                    data-testid="log-row"
                  >
                    <span
                      className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded border shrink-0 font-mono-data uppercase tracking-wider mt-0.5',
                        LEVEL_COLORS[entry.parsed.level],
                      )}
                    >
                      {levelBadgeLabel(entry.parsed.level)}
                    </span>
                    <div className="min-w-0 flex-1">
                      {tsText && (
                        <div className="text-[10px] text-muted-foreground font-mono-data mb-0.5 break-all">
                          <span>{tsText}</span>
                          {zoneLabel && <span className="ml-2 opacity-80">({zoneLabel})</span>}
                        </div>
                      )}
                      <p className="text-xs font-mono-data text-muted-foreground leading-relaxed whitespace-pre-wrap break-all [overflow-wrap:anywhere]">
                        {entry.sourceText}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="logs-count">
        {filtered.length} of {parsedEntries.length} entries on this page
        {instanceMode ? ' · instance logfile' : ` · VS ${s}`}
      </p>
    </div>
  );
}
