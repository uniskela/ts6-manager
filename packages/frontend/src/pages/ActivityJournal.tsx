import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activityJournalApi } from '@/api/activity-journal.api';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NotebookPen, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ActivityCaptureStatus,
  ActivityClassification,
  ActivityJournalStatus,
  ClientActivityEntry,
} from '@ts6/common';

const STATUS_LABEL: Record<ActivityCaptureStatus, string> = {
  disabled: 'Disabled',
  connecting: 'Connecting',
  capturing: 'Capturing',
  interrupted: 'Interrupted',
  persistence_error: 'Persistence error',
};

const STATUS_CLASS: Record<ActivityCaptureStatus, string> = {
  disabled: 'text-muted-foreground',
  connecting: 'text-amber-600',
  capturing: 'text-emerald-600',
  interrupted: 'text-amber-600',
  persistence_error: 'text-destructive',
};

function classLabel(c: ActivityClassification): string {
  switch (c) {
    case 'known_bot':
      return 'Known bot';
    case 'query':
      return 'Query';
    case 'voice':
      return 'Voice';
    default:
      return 'Unknown';
  }
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ActivityJournal() {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState<'ALL' | 'join' | 'leave'>('ALL');
  const [classFilter, setClassFilter] = useState<'ALL' | ActivityClassification>('ALL');
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const cursor = cursorStack[cursorStack.length - 1];

  const statusQuery = useQuery({
    queryKey: ['activity-journal-status'],
    queryFn: () => activityJournalApi.getStatus(),
    refetchInterval: 15_000,
  });

  const historyQuery = useQuery({
    queryKey: ['activity-journal-history', c, s, cursor],
    queryFn: () =>
      activityJournalApi.getHistory({
        serverConfigId: c!,
        virtualServerId: s!,
        cursor: cursor || undefined,
        limit: 50,
      }),
    enabled: !!c && !!s,
  });

  const targetMutation = useMutation({
    mutationFn: (enabled: boolean) => activityJournalApi.setTarget(c!, s!, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['activity-journal-status'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-journal-history'] });
      setCursorStack([null]);
    },
  });

  const pairStatus = useMemo((): ActivityJournalStatus | null => {
    if (!c || !s || !statusQuery.data) return null;
    return (
      statusQuery.data.statuses.find(
        (row: ActivityJournalStatus) => row.serverConfigId === c && row.virtualServerId === s,
      ) || null
    );
  }, [c, s, statusQuery.data]);

  const enabled = pairStatus?.enabled === true;
  const captureStatus: ActivityCaptureStatus = pairStatus?.status || 'disabled';

  const items = useMemo((): ClientActivityEntry[] => {
    const raw = historyQuery.data?.items || [];
    return raw.filter((entry: ClientActivityEntry) => {
      if (kindFilter !== 'ALL' && entry.eventKind !== kindFilter) return false;
      if (classFilter !== 'ALL' && entry.classification !== classFilter) return false;
      return true;
    });
  }, [historyQuery.data, kindFilter, classFilter]);

  if (!c || !s) {
    return <EmptyState icon={NotebookPen} title="No server selected" description="Select a connection and virtual server to view the activity journal." />;
  }

  if (statusQuery.isLoading && historyQuery.isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Activity Journal</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Opt-in TeamSpeak join/leave history for this connection and virtual server.
            Identity fields are allow-listed (no IPs or chat). Retention:{' '}
            {statusQuery.data?.retention.days ?? 7}d /{' '}
            {(statusQuery.data?.retention.perConnectionSid ?? 10000).toLocaleString()} per
            connection-SID /{' '}
            {(statusQuery.data?.retention.global ?? 100000).toLocaleString()} global.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void statusQuery.refetch();
            void historyQuery.refetch();
          }}
          disabled={statusQuery.isFetching || historyQuery.isFetching}
        >
          <RefreshCw
            className={cn(
              'h-4 w-4 mr-1',
              (statusQuery.isFetching || historyQuery.isFetching) && 'animate-spin',
            )}
          />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={enabled}
            disabled={targetMutation.isPending}
            onCheckedChange={(v) => targetMutation.mutate(v)}
            id="journal-capture"
          />
          <label htmlFor="journal-capture" className="text-sm font-medium">
            Capture for config {c} / SID {s}
          </label>
        </div>
        <div className="text-sm">
          Status:{' '}
          <span className={cn('font-medium', STATUS_CLASS[captureStatus])}>
            {STATUS_LABEL[captureStatus]}
          </span>
        </div>
        {pairStatus && pairStatus.droppedEvents > 0 && (
          <Badge variant="outline" className="text-amber-600 border-amber-500/40">
            Gaps: {pairStatus.droppedEvents} dropped
          </Badge>
        )}
        {pairStatus?.lastError && (
          <span className="text-xs text-destructive">{pairStatus.lastError}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as typeof kindFilter)}>
          <SelectTrigger className="h-9 w-[140px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All events</SelectItem>
            <SelectItem value="join">Joins</SelectItem>
            <SelectItem value="leave">Leaves</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={classFilter}
          onValueChange={(v) => setClassFilter(v as typeof classFilter)}
        >
          <SelectTrigger className="h-9 w-[160px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All classifications</SelectItem>
            <SelectItem value="voice">Voice</SelectItem>
            <SelectItem value="known_bot">Known bot</SelectItem>
            <SelectItem value="query">Query</SelectItem>
            <SelectItem value="unknown">Unknown</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border border-border bg-card overflow-hidden shadow-sm">
        <ScrollArea className="h-[max(18rem,calc(100dvh-22rem))] sm:h-[calc(100dvh-300px)]">
          <div className="divide-y divide-border/60">
            {historyQuery.isLoading ? (
              <p className="text-center text-muted-foreground text-sm py-10">Loading…</p>
            ) : items.length === 0 ? (
              <p className="text-center text-muted-foreground text-sm py-10">
                {enabled
                  ? 'No journal entries yet for this context.'
                  : 'Capture is disabled. Enable capture to record joins and leaves.'}
              </p>
            ) : (
              items.map((entry: ClientActivityEntry) => (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2 text-sm"
                >
                  <span className="text-xs text-muted-foreground tabular-nums min-w-[10rem]">
                    {formatWhen(entry.observedAt)}
                  </span>
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                    {entry.eventKind}
                  </Badge>
                  <span className="font-medium">{entry.nickname || `clid ${entry.clientId}`}</span>
                  <span className="text-xs text-muted-foreground">
                    {classLabel(entry.classification)}
                    {entry.databaseId != null ? ` · dbid ${entry.databaseId}` : ''}
                    {entry.uniqueId ? ` · ${entry.uniqueId.slice(0, 12)}…` : ''}
                  </span>
                  {entry.identityProvenance !== 'event' && entry.identityProvenance !== 'none' && (
                    <span className="text-[10px] text-muted-foreground">
                      identity: {entry.identityProvenance}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={cursorStack.length <= 1}
          onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!historyQuery.data?.nextCursor}
          onClick={() => {
            const next = historyQuery.data?.nextCursor;
            if (next) setCursorStack((stack) => [...stack, next]);
          }}
        >
          Older
        </Button>
      </div>
    </div>
  );
}
