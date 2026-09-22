import { useEffect, useMemo, useState, type ElementType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock,
  Gauge,
  Hash,
  LayoutGrid,
  Radio,
  Server,
  Wifi,
  X,
} from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip as ReTooltip, XAxis, YAxis } from 'recharts';
import { useDashboard } from '@/hooks/use-dashboard';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { useAuthStore } from '@/stores/auth.store';
import { NUDGE_DISMISS_STORAGE_KEY } from '@/content/connection-setup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataPanel } from '@/components/shared/DataPanel';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { RefreshStatus, StaleDataNotice } from '@/components/shared/RefreshStatus';
import { WidgetManagerModal } from '@/components/widget/WidgetManagerModal';
import { formatBytes, formatUptime } from '@/lib/utils';
import { formatLocalTime, formatNumber } from '@/lib/formatting';
import { apiErrorMessage, isTeamSpeakStarting, teamSpeakConnectionTitle, teamSpeakRefreshTone } from '@/lib/api-error';

interface DashboardData {
  serverName: string;
  platform: string;
  version: string;
  onlineUsers: number;
  maxClients: number;
  uptime: number;
  channelCount: number;
  bandwidth: { incoming: number; outgoing: number };
  packetloss: number;
  ping: number;
}

interface BandwidthSample {
  context: string;
  time: string;
  incoming: number;
  outgoing: number;
}

const chartColours = {
  incoming: 'hsl(var(--chart-1))',
  outgoing: 'hsl(var(--chart-3))',
  muted: 'hsl(var(--muted-foreground))',
  popover: 'hsl(var(--popover))',
  popoverForeground: 'hsl(var(--popover-foreground))',
  border: 'hsl(var(--border))',
};

function Metric({ label, value, icon: Icon }: { label: string; value: string | number; icon: ElementType }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <p className="break-words font-mono-data text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 border-b border-border/70 py-3 last:border-0 sm:grid-cols-[minmax(7rem,0.4fr)_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere] font-mono-data text-sm text-foreground sm:text-right">{children}</dd>
    </div>
  );
}

export default function Dashboard() {
  const { selectedConfigId, selectedSid } = useServerStore();
  const { data: servers } = useServers();
  const query = useDashboard();
  const data = query.data as DashboardData | undefined;
  const isAdmin = useAuthStore((state) => state.isAdmin());
  const [bandwidthHistory, setBandwidthHistory] = useState<BandwidthSample[]>([]);
  const [showWidgets, setShowWidgets] = useState(false);
  const [nudgeDismissed, setNudgeDismissed] = useState(() => {
    try {
      return localStorage.getItem(NUDGE_DISMISS_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const context = `${selectedConfigId ?? 'none'}:${selectedSid ?? 'none'}`;
  const visibleHistory = useMemo(
    () => bandwidthHistory.filter((sample) => sample.context === context),
    [bandwidthHistory, context],
  );
  const hasNoConnections = isAdmin && Array.isArray(servers) && servers.length === 0;
  const showConnectionNudge = hasNoConnections && !nudgeDismissed;

  useEffect(() => {
    setBandwidthHistory([]);
  }, [context]);

  useEffect(() => {
    if (!data) return;
    setBandwidthHistory((previous) => [
      ...previous.filter((sample) => sample.context === context),
      {
        context,
        time: formatLocalTime(Date.now()),
        incoming: data.bandwidth.incoming,
        outgoing: data.bandwidth.outgoing,
      },
    ].slice(-30));
  }, [context, data]);

  const dismissNudge = () => {
    setNudgeDismissed(true);
    try {
      localStorage.setItem(NUDGE_DISMISS_STORAGE_KEY, '1');
    } catch {
      // Browser privacy modes may reject local storage; dismissal still works for this session.
    }
  };

  if (!selectedConfigId || !selectedSid) {
    return (
      <div className="space-y-4">
        {showConnectionNudge && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="flex flex-col items-start gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                <p className="font-medium">Connect your TeamSpeak server to get started</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Add a connection under Settings to manage channels, clients, bots, and more.
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
                <Button size="sm" asChild>
                  <Link to="/settings?tab=connections&wizard=1">Go to Connections</Link>
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={dismissNudge} aria-label="Dismiss connection setup suggestion">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
        <EmptyState
          icon={Server}
          title={hasNoConnections ? 'No server connection configured' : 'No server selected'}
          description={hasNoConnections
            ? 'Use the setup wizard in Settings → Connections to add your TeamSpeak server.'
            : 'Select a server connection from the header to view the dashboard.'}
        >
          {hasNoConnections && (
            <Button size="sm" asChild>
              <Link to="/settings?tab=connections&wizard=1">Open connection setup</Link>
            </Button>
          )}
        </EmptyState>
      </div>
    );
  }

  if (query.isLoading && !data) return <PageLoader />;

  if (!data) {
    const detail = apiErrorMessage(
      query.error,
      isTeamSpeakStarting(query.error)
        ? 'TeamSpeak Query is still coming up after startup. Wait a moment and retry.'
        : 'Could not connect to the TeamSpeak server. Check your connection settings.',
    );
    return (
      <div className="space-y-4">
        <EmptyState icon={Wifi} title={teamSpeakConnectionTitle(query.error)} description={detail} />
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? 'Retrying…' : 'Retry connection'}
          </Button>
        </div>
      </div>
    );
  }

  const utilisation = data.maxClients > 0
    ? Math.min(Math.max((data.onlineUsers / data.maxClients) * 100, 0), 100)
    : 0;
  const roundedUtilisation = Math.round(utilisation);
  const availableSlots = Math.max(data.maxClients - data.onlineUsers, 0);
  const backgroundError = query.error
    ? apiErrorMessage(
      query.error,
      isTeamSpeakStarting(query.error)
        ? 'TeamSpeak Query is still starting. Live data may be incomplete until it comes online.'
        : 'Live data refresh failed. The last successful snapshot is still displayed.',
    )
    : null;
  const refreshTone = teamSpeakRefreshTone(query.error);

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        title={data.serverName}
        description="Live TeamSpeak server overview"
        badge={<Badge variant="success" className="font-mono-data text-[10px]">ONLINE</Badge>}
        actions={isAdmin ? (
          <Button size="sm" variant="outline" onClick={() => setShowWidgets(true)}>
            <LayoutGrid className="mr-1.5 h-3.5 w-3.5" /> Widgets
          </Button>
        ) : undefined}
        metadata={(
          <RefreshStatus
            isRefreshing={query.isFetching}
            tone={refreshTone}
            idleLabel="Live monitoring active"
            refreshingLabel="Refreshing live data…"
            degradedLabel="Live updates interrupted"
            startingLabel="Waiting for TeamSpeak Query…"
          />
        )}
      />

      {backgroundError && (
        <StaleDataNotice
          message={backgroundError}
          onRetry={() => { void query.refetch(); }}
          isRetrying={query.isFetching}
        />
      )}

      <DataPanel
        title="Server Status"
        description="Availability, utilisation, and connection health"
        status={<Badge variant="success">Online</Badge>}
      >
        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="min-w-0 rounded-lg border border-primary/20 bg-primary/5 p-4 sm:p-5">
            <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Online users</p>
                <p className="mt-1 font-mono-data text-3xl font-bold text-primary">{formatNumber(data.onlineUsers)} / {formatNumber(data.maxClients)}</p>
              </div>
              <p className="font-mono-data text-sm text-muted-foreground">{roundedUtilisation}% utilised</p>
            </div>
            <div
              role="progressbar"
              aria-label="User slot utilisation"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={roundedUtilisation}
              className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${utilisation}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {formatNumber(availableSlots)} {availableSlots === 1 ? 'slot' : 'slots'} available
            </p>
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-3">
            <Metric icon={Hash} label="Channels" value={formatNumber(data.channelCount)} />
            <Metric icon={Clock} label="Uptime" value={formatUptime(data.uptime)} />
            <Metric icon={Gauge} label="Ping" value={`${Number(data.ping || 0).toFixed(1)} ms`} />
            <Metric icon={Radio} label="Packet loss" value={`${(Number(data.packetloss || 0) * 100).toFixed(2)}%`} />
          </div>
        </div>
      </DataPanel>

      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <DataPanel
          title="Traffic"
          description="Incoming and outgoing bandwidth over the latest local samples"
          className="lg:col-span-2"
        >
          <div className="h-[240px] min-w-0">
            {visibleHistory.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={visibleHistory} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashboard-incoming" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chartColours.incoming} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={chartColours.incoming} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="dashboard-outgoing" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chartColours.outgoing} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={chartColours.outgoing} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" tick={{ fontSize: 10, fill: chartColours.muted }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis tick={{ fontSize: 10, fill: chartColours.muted }} axisLine={false} tickLine={false} tickFormatter={formatBytes} width={56} />
                  <ReTooltip
                    contentStyle={{ background: chartColours.popover, border: `1px solid ${chartColours.border}`, borderRadius: '6px', fontSize: '12px' }}
                    labelStyle={{ color: chartColours.popoverForeground }}
                    formatter={(value: number, name: string) => [`${formatBytes(value)}/s`, name === 'incoming' ? 'Incoming' : 'Outgoing']}
                  />
                  <Area type="monotone" dataKey="incoming" stroke={chartColours.incoming} fill="url(#dashboard-incoming)" strokeWidth={2} isAnimationActive={false} />
                  <Area type="monotone" dataKey="outgoing" stroke={chartColours.outgoing} fill="url(#dashboard-outgoing)" strokeWidth={2} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                Collecting bandwidth samples…
              </div>
            )}
          </div>
          <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
            <div data-traffic-series="incoming" className="flex min-w-0 items-center gap-2 text-primary">
              <ArrowDownToLine className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="text-xs text-muted-foreground">Incoming</span>
              <span className="ml-auto font-mono-data text-sm">{formatBytes(data.bandwidth.incoming)}/s</span>
            </div>
            <div data-traffic-series="outgoing" className="flex min-w-0 items-center gap-2 [color:hsl(var(--chart-3))]">
              <ArrowUpFromLine className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="text-xs text-muted-foreground">Outgoing</span>
              <span className="ml-auto font-mono-data text-sm">{formatBytes(data.bandwidth.outgoing)}/s</span>
            </div>
          </div>
        </DataPanel>

        <DataPanel title="Runtime & Capacity" description="Runtime identity and available capacity">
          <dl className="min-w-0">
            <DetailRow label="Server version">{data.version || 'Unknown'}</DetailRow>
            <DetailRow label="Platform">{data.platform || 'Unknown'}</DetailRow>
            <DetailRow label="Total slots">{formatNumber(data.maxClients)}</DetailRow>
            <DetailRow label="Available slots">{formatNumber(availableSlots)}</DetailRow>
          </dl>
        </DataPanel>
      </div>

      <WidgetManagerModal open={showWidgets} onOpenChange={setShowWidgets} />
    </div>
  );
}
