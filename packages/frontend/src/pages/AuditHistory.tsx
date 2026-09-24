import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_OUTCOMES,
  type AdminAuditAction,
  type AdminAuditEventDto,
  type AdminAuditOutcome,
  type AdminAuditResultCode,
} from '@ts6/common';
import { ClipboardList, Filter, RefreshCw } from 'lucide-react';
import { auditApi } from '@/api/audit.api';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { adminAuditHistoryRefetchInterval } from '@/lib/admin-audit-live';
import { cn } from '@/lib/utils';

const ACTION_LABELS: Record<AdminAuditAction, string> = {
  'client.kick': 'Kick client',
  'client.ban': 'Ban client',
  'client.move': 'Move client',
  'client.poke': 'Poke client',
  'client.message': 'Message client',
  'client.permission_add': 'Add client permission',
  'client.permission_delete': 'Delete client permission',
  'ban.create': 'Add ban',
  'ban.delete': 'Delete ban',
  'ban.delete_all': 'Clear bans',
  'channel.create': 'Create channel',
  'channel.update': 'Edit channel',
  'channel.delete': 'Delete channel',
  'channel.move': 'Move channel',
  'channel.permission_add': 'Add channel permission',
  'channel.permission_delete': 'Delete channel permission',
  'server_group.create': 'Create server group',
  'server_group.update': 'Rename server group',
  'server_group.delete': 'Delete server group',
  'server_group.copy': 'Copy server group',
  'server_group.member_add': 'Add server group member',
  'server_group.member_remove': 'Remove server group member',
  'server_group.permission_add': 'Add server group permission',
  'server_group.permission_delete': 'Delete server group permission',
  'channel_group.create': 'Create channel group',
  'channel_group.update': 'Rename channel group',
  'channel_group.delete': 'Delete channel group',
  'channel_group.assign': 'Assign channel group',
  'channel_group.permission_add': 'Add channel group permission',
  'channel_group.permission_delete': 'Delete channel group permission',
  'privilege_key.create': 'Create privilege key',
  'privilege_key.delete': 'Delete privilege key',
  'virtual_server.edit': 'Edit virtual server',
  'virtual_server.start': 'Start virtual server',
  'virtual_server.stop': 'Stop virtual server',
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

const RESULT_CODE_LABELS: Record<AdminAuditResultCode, string> = {
  ok: 'OK',
  ts_error: 'TeamSpeak error',
  timeout: 'Timeout',
  network_error: 'Network error',
  engine_reload_failed: 'Engine reload failed',
  pool_refresh_failed: 'Pool refresh failed',
  not_found: 'Not found',
  validation_failed: 'Validation failed',
  storage_failed: 'Storage failed',
  unknown: 'Unknown',
};

const TARGET_TYPE_LABELS: Record<string, string> = {
  client: 'Client',
  ban: 'Ban',
  channel: 'Channel',
  server_group: 'Server group',
  channel_group: 'Channel group',
  privilege_key: 'Privilege key',
  virtual_server: 'Virtual server',
  connection: 'Connection',
  flow: 'Flow',
  user: 'User',
  settings: 'Settings',
};

const AUDIT_GRID =
  'grid min-w-[52rem] grid-cols-[9.5rem_minmax(8rem,1.1fr)_minmax(6rem,0.9fr)_minmax(7rem,1fr)_minmax(6.5rem,0.85fr)_minmax(5.5rem,0.75fr)] gap-x-3';

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

function formatDurationMs(startedIso: string, completedIso: string | null): string | null {
  if (!completedIso) return null;
  const start = Date.parse(startedIso);
  const end = Date.parse(completedIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function EventRow({ event }: { event: AdminAuditEventDto }) {
  const label = ACTION_LABELS[event.action] ?? event.action;
  const actor = event.actorUsername ?? `user #${event.actorUserId}`;
  const targetType = event.targetType
    ? (TARGET_TYPE_LABELS[event.targetType] ?? event.targetType)
    : null;
  const target = targetType
    ? `${targetType}${event.targetId ? ` ${event.targetId}` : ''}`
    : '—';
  const contextBits = [
    event.connectionId != null ? `conn ${event.connectionId}` : null,
    event.virtualServerId != null ? `sid ${event.virtualServerId}` : null,
  ].filter(Boolean);
  const context = contextBits.join(' · ') || '—';
  const resultLabel = event.resultCode
    ? (RESULT_CODE_LABELS[event.resultCode] ?? event.resultCode)
    : null;
  const duration = formatDurationMs(event.createdAt, event.completedAt);
  const title = [
    `Operation ${event.operationId}`,
    resultLabel ? `Result: ${resultLabel}` : null,
    duration ? `Duration: ${duration}` : null,
    event.completedAt ? `Completed: ${formatWhen(event.completedAt)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div
      role="row"
      className={cn(AUDIT_GRID, 'items-start border-b border-border/60 px-4 py-2.5 text-sm last:border-0')}
      title={title}
    >
      <div className="space-y-0.5">
        <p className="text-xs text-muted-foreground tabular-nums leading-snug">
          {formatWhen(event.createdAt)}
        </p>
        {duration && (
          <p className="text-[10px] text-muted-foreground/80">{duration}</p>
        )}
      </div>
      <div className="min-w-0">
        <p className="font-medium leading-snug truncate" title={label}>{label}</p>
        <p className="text-[10px] text-muted-foreground font-mono-data truncate" title={event.action}>
          {event.action}
        </p>
      </div>
      <p className="min-w-0 truncate text-xs leading-snug" title={actor}>{actor}</p>
      <p className="min-w-0 truncate text-xs text-muted-foreground font-mono-data leading-snug" title={target}>
        {target}
      </p>
      <p className="min-w-0 truncate text-xs text-muted-foreground leading-snug" title={context}>
        {context}
      </p>
      <div className="min-w-0 space-y-0.5">
        <p className={cn('text-xs font-medium uppercase tracking-wide', outcomeClass(event.outcome))}>
          {event.outcome}
        </p>
        {resultLabel && (
          <p className="text-[10px] text-muted-foreground truncate" title={resultLabel}>
            {resultLabel}
          </p>
        )}
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
  const onNewestPage = cursorStack.length === 1 && cursorStack[0] == null;
  const historyRefetchInterval = adminAuditHistoryRefetchInterval({ onNewestPage });
  const historyLive = historyRefetchInterval !== false;

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

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['admin-audit', filters],
    queryFn: () => auditApi.list(filters),
    refetchInterval: historyRefetchInterval,
  });

  const resetPages = () => setCursorStack([null]);

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col space-y-4">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ClipboardList className="h-5 w-5 text-primary" />
            Administrative Audit
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Manager-initiated admin actions only — separate from TeamSpeak client activity and Server Logs.
            Retention: {data?.retention.maxAgeDays ?? 30} days or {data?.retention.maxRows?.toLocaleString() ?? '100,000'} rows
            (whichever first). Records cannot be deleted from this UI.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {historyLive && (
            <span className="text-xs font-medium text-emerald-600" title="Newest page refreshes automatically">
              Live
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn('h-4 w-4 mr-1', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
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
            <div className={cn('min-w-0', isFetching && 'opacity-70')}>
              <div
                className={cn(
                  AUDIT_GRID,
                  'sticky top-0 z-10 border-b border-border bg-card/95 px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur-sm',
                )}
                role="row"
              >
                <span>Date / time</span>
                <span>Action</span>
                <span>Actor</span>
                <span>Target</span>
                <span>Context</span>
                <span>Outcome</span>
              </div>
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
