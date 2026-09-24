import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_OUTCOMES,
  type AdminAuditAction,
  type AdminAuditEventDto,
  type AdminAuditOutcome,
} from '@ts6/common';
import { ClipboardList, Filter } from 'lucide-react';
import { auditApi } from '@/api/audit.api';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const ACTION_LABELS: Record<AdminAuditAction, string> = {
  'client.kick': 'Kick client',
  'client.ban': 'Ban client',
  'ban.create': 'Add ban',
  'ban.delete': 'Delete ban',
  'ban.delete_all': 'Clear bans',
  'connection.create': 'Create connection',
  'connection.update': 'Update connection',
  'connection.credentials_changed': 'Change connection credentials',
  'connection.delete': 'Delete connection',
  'flow.create': 'Create flow',
  'flow.update': 'Update flow',
  'flow.delete': 'Delete flow',
  'flow.enable': 'Enable flow',
  'flow.disable': 'Disable flow',
  'user.create': 'Create user',
  'user.update': 'Update user',
  'user.delete': 'Delete user',
  'settings.yt_cookies_changed': 'Update yt-dlp cookies',
  'settings.yt_cookies_removed': 'Remove yt-dlp cookies',
  'settings.limits_update': 'Update app limits',
};

function outcomeClass(outcome: AdminAuditOutcome): string {
  switch (outcome) {
    case 'success':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'failure':
      return 'text-destructive';
    case 'partial':
      return 'text-amber-600 dark:text-amber-400';
    case 'unknown':
    case 'pending':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}

function formatWhen(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function EventRow({ event }: { event: AdminAuditEventDto }) {
  const label = ACTION_LABELS[event.action] ?? event.action;
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 px-4 py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-sm">{label}</p>
        <p className="text-xs text-muted-foreground font-mono-data break-all">
          {event.actorUsername ?? `user #${event.actorUserId}`}
          {event.connectionId != null ? ` · connection ${event.connectionId}` : ''}
          {event.virtualServerId != null ? ` · sid ${event.virtualServerId}` : ''}
          {event.targetType ? ` · ${event.targetType}${event.targetId ? ` ${event.targetId}` : ''}` : ''}
        </p>
      </div>
      <div className="shrink-0 text-left sm:text-right space-y-0.5">
        <p className={cn('text-xs font-medium uppercase tracking-wide', outcomeClass(event.outcome))}>
          {event.outcome}
          {event.resultCode ? ` · ${event.resultCode}` : ''}
        </p>
        <p className="text-xs text-muted-foreground">{formatWhen(event.createdAt)}</p>
      </div>
    </div>
  );
}

export default function AuditHistory() {
  const [action, setAction] = useState<string>('');
  const [outcome, setOutcome] = useState<string>('');
  const [actorUserId, setActorUserId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [virtualServerId, setVirtualServerId] = useState('');
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const cursor = cursorStack[cursorStack.length - 1] ?? undefined;

  const filters = useMemo(
    () => ({
      action: (action || undefined) as AdminAuditAction | undefined,
      outcome: (outcome || undefined) as AdminAuditOutcome | undefined,
      actorUserId: actorUserId ? Number(actorUserId) : undefined,
      connectionId: connectionId ? Number(connectionId) : undefined,
      virtualServerId: virtualServerId ? Number(virtualServerId) : undefined,
      cursor: cursor || undefined,
      limit: 50,
    }),
    [action, outcome, actorUserId, connectionId, virtualServerId, cursor],
  );

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-audit', filters],
    queryFn: () => auditApi.list(filters),
  });

  const resetPages = () => setCursorStack([null]);

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col space-y-4">
      <div className="shrink-0 space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ClipboardList className="h-5 w-5 text-primary" />
          Administrative Audit
        </h1>
        <p className="text-sm text-muted-foreground">
          Manager-initiated admin actions only — separate from TeamSpeak client activity and Server Logs.
          Retention: {data?.retention.maxAgeDays ?? 30} days or {data?.retention.maxRows?.toLocaleString() ?? '100,000'} rows
          (whichever first). Records cannot be deleted from this UI.
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Filter className="h-3 w-3" /> Action</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={action}
            onChange={(e) => { setAction(e.target.value); resetPages(); }}
          >
            <option value="">All</option>
            {ADMIN_AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Outcome</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={outcome}
            onChange={(e) => { setOutcome(e.target.value); resetPages(); }}
          >
            <option value="">All</option>
            {ADMIN_AUDIT_OUTCOMES.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Actor user ID</span>
          <Input
            className="h-9 w-28"
            inputMode="numeric"
            value={actorUserId}
            onChange={(e) => { setActorUserId(e.target.value.replace(/\D/g, '')); resetPages(); }}
            placeholder="Any"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Connection ID</span>
          <Input
            className="h-9 w-28"
            inputMode="numeric"
            value={connectionId}
            onChange={(e) => { setConnectionId(e.target.value.replace(/\D/g, '')); resetPages(); }}
            placeholder="Any"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Virtual server ID</span>
          <Input
            className="h-9 w-28"
            inputMode="numeric"
            value={virtualServerId}
            onChange={(e) => { setVirtualServerId(e.target.value.replace(/\D/g, '')); resetPages(); }}
            placeholder="Any"
          />
        </label>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {isLoading ? (
          <PageLoader />
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
            Failed to load audit history. Confirm you are signed in as an admin.
          </div>
        ) : !data?.items.length ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={ClipboardList}
              title="No audit events yet"
              description="Kick, ban, connection, flow, user, and settings mutations that are instrumented will appear here."
            />
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className={cn(isFetching && 'opacity-70')}>
              {data.items.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={cursorStack.length <= 1 || isFetching}
          onClick={() => setCursorStack((s) => s.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!data?.nextCursor || isFetching}
          onClick={() => {
            if (data?.nextCursor) setCursorStack((s) => [...s, data.nextCursor]);
          }}
        >
          Older
        </Button>
      </div>
    </div>
  );
}
