import { useState, useEffect } from 'react';
import {
  useIptvPlaylists, useCreateIptvPlaylist, useDeleteIptvPlaylist, useRefreshIptvPlaylist,
  useIptvGroups, useIptvChannels, useIptvStream, useIptvStop,
} from '@/hooks/use-iptv';
import { useMusicBots } from '@/hooks/use-music-bots';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { PageHeader } from '@/components/shared/PageHeader';
import { RefreshStatus, StaleDataNotice } from '@/components/shared/RefreshStatus';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tv, Plus, Trash2, RefreshCw, Play, Square, Search, ChevronLeft, ChevronRight, Loader2, Radio, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { IptvPlaylistSummary, IptvChannelInfo, IptvChannelPage } from '@ts6/common';
import { formatLocalDateTime, formatNumber } from '@/lib/formatting';
import { apiErrorMessage } from '@/lib/api-error';

const PRESETS = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
];

// ─── Channel browser ─────────────────────────────────────────────────────────

function ChannelBrowser({ playlist, bots }: { playlist: IptvPlaylistSummary; bots: any[] }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [group, setGroup] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 24;

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: groups } = useIptvGroups(playlist.id);
  const groupList: string[] = Array.isArray(groups) ? groups : [];
  const { data, isFetching } = useIptvChannels(playlist.id, {
    search: debounced || undefined,
    group: group || undefined,
    page,
    pageSize,
  }) as { data: IptvChannelPage | undefined; isFetching: boolean };

  const stream = useIptvStream();
  const stop = useIptvStop();

  // Running music bots on this playlist's server can act as the streamer.
  const eligibleBots = bots.filter(
    (b) => b.serverConfigId === playlist.serverConfigId && b.status !== 'stopped' && b.status !== 'error',
  );
  const [botId, setBotId] = useState<string>('');
  const [preset, setPreset] = useState('720p');

  useEffect(() => {
    if (!botId && eligibleBots.length > 0) setBotId(String(eligibleBots[0].id));
  }, [eligibleBots, botId]);

  const channels: IptvChannelInfo[] = data?.channels ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const doStream = (channel: IptvChannelInfo) => {
    if (!botId) { toast.error('Select a running music bot to stream through'); return; }
    stream.mutate(
      { botId: parseInt(botId), channelId: channel.id, preset },
      {
        onSuccess: () => toast.success(`Streaming: ${channel.name}`),
        onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to start stream'),
      },
    );
  };

  return (
    <div className="space-y-3">
      {/* Streamer controls */}
      <div className="flex flex-wrap items-end gap-2 rounded-md border p-2.5">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Stream through bot</Label>
          <Select value={botId} onValueChange={setBotId}>
            <SelectTrigger className="h-10 w-full min-w-44 text-xs sm:h-8 sm:w-48"><SelectValue placeholder={eligibleBots.length ? 'Select bot' : 'No running bots'} /></SelectTrigger>
            <SelectContent>
              {eligibleBots.map((b) => (
                <SelectItem key={b.id} value={String(b.id)}>{b.name} ({b.status})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Quality</Label>
          <Select value={preset} onValueChange={setPreset}>
            <SelectTrigger className="h-10 w-28 text-xs sm:h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {botId && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => stop.mutate(parseInt(botId), { onSuccess: () => toast.success('Stream stopped') })}
          >
            <Square className="h-3.5 w-3.5 mr-1" /> Stop
          </Button>
        )}
        {eligibleBots.length === 0 && (
          <p className="text-[11px] text-amber-500 flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" /> Start a Music Bot on this server to stream.
          </p>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            aria-label="Search IPTV channels"
            placeholder="Search channels..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs pl-8"
          />
        </div>
        {groupList.length > 0 && (
          <Select value={group || '__all__'} onValueChange={(v) => { setGroup(v === '__all__' ? '' : v); setPage(1); }}>
            <SelectTrigger className="h-10 w-full text-xs sm:h-8 sm:w-52"><SelectValue placeholder="All groups" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All groups</SelectItem>
              {groupList.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Channel grid */}
      {channels.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">
          {isFetching ? 'Loading…' : 'No channels match your filters.'}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-md border p-2 group hover:border-primary/40 transition-colors">
              <div className="h-9 w-9 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                {c.logo
                  ? <img src={c.logo} alt="" className="h-full w-full object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  : <Radio className="h-4 w-4 text-muted-foreground" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{c.name}</p>
                {c.groupTitle && <p className="text-[10px] text-muted-foreground truncate">{c.groupTitle}</p>}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => doStream(c)}
                disabled={stream.isPending || !botId}
                aria-label={`Stream ${c.name}`}
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{formatNumber(total)} channels{isFetching ? ' · updating…' : ''}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Previous channel page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="tabular-nums">{page} / {totalPages}</span>
          <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Next channel page" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Add playlist dialog ─────────────────────────────────────────────────────

function AddPlaylistDialog({ open, onClose, serverConfigId }: { open: boolean; onClose: () => void; serverConfigId: number | null }) {
  const create = useCreateIptvPlaylist();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [refresh, setRefresh] = useState('0');

  const submit = () => {
    if (!serverConfigId) { toast.error('Select a server first'); return; }
    if (!name.trim() || !url.trim()) { toast.error('Name and M3U URL are required'); return; }
    create.mutate(
      { name: name.trim(), url: url.trim(), serverConfigId, autoRefreshMinutes: parseInt(refresh) || 0 },
      {
        onSuccess: (res: any) => {
          if (res?.refreshError) toast.warning(`Playlist added, but refresh failed: ${res.refreshError}`);
          else toast.success(`Playlist added — ${formatNumber(Number(res?.channelCount ?? 0))} channels`);
          setName(''); setUrl(''); setRefresh('0');
          onClose();
        },
        onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to add playlist'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add IPTV Playlist</DialogTitle>
          <DialogDescription>Paste an M3U/M3U8 playlist URL (Xtream, Threadfin, Dispatcharr, etc.).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="iptv-playlist-name" className="text-xs">Name</Label>
            <Input id="iptv-playlist-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My IPTV" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="iptv-playlist-url" className="text-xs">M3U URL</Label>
            <Input id="iptv-playlist-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://provider/get.php?...&type=m3u_plus" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="iptv-playlist-refresh" className="text-xs">Auto-refresh (minutes, 0 = manual)</Label>
            <Input id="iptv-playlist-refresh" type="number" min={0} value={refresh} onChange={(e) => setRefresh(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending} aria-busy={create.isPending}>
            {create.isPending ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Adding…</> : 'Add & Load'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Iptv() {
  const { data: servers } = useServers();
  const serverList = Array.isArray(servers) ? servers : [];
  const { selectedConfigId, setServer } = useServerStore();

  // Default to the first server if none selected.
  useEffect(() => {
    if (!selectedConfigId && serverList.length > 0) setServer(serverList[0].id);
  }, [serverList, selectedConfigId, setServer]);

  const { data: playlists, isLoading, error, refetch, isFetching } = useIptvPlaylists(selectedConfigId ?? undefined);
  const { data: bots } = useMusicBots();
  const botList = Array.isArray(bots) ? bots : [];

  const deletePlaylist = useDeleteIptvPlaylist();
  const refreshPlaylist = useRefreshIptvPlaylist();

  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IptvPlaylistSummary | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null);

  if (isLoading && playlists === undefined) return <PageLoader />;
  if (error && playlists === undefined) {
    return (
      <div className="space-y-4">
        <EmptyState icon={Tv} title="Could not load IPTV playlists" description={apiErrorMessage(error, 'Check the selected connection and try again.')} />
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => { void refetch(); }} disabled={isFetching} aria-busy={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    );
  }

  const playlistList: IptvPlaylistSummary[] = Array.isArray(playlists) ? playlists : [];
  const selectedPlaylist = playlistList.find((p) => p.id === selectedPlaylistId) ?? playlistList[0] ?? null;
  const backgroundError = error
    ? apiErrorMessage(error, 'Playlist refresh failed. The last successful list is still displayed.')
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="IPTV"
        icon={Tv}
        description="Stream live IPTV channels into TeamSpeak via a Music Bot's video sidecar."
        actions={(
          <>
          <Select value={selectedConfigId ? String(selectedConfigId) : ''} onValueChange={(v) => { setServer(parseInt(v)); setSelectedPlaylistId(null); }}>
            <SelectTrigger aria-label="IPTV server" className="h-10 min-w-0 flex-1 sm:h-9 sm:w-48 sm:flex-none"><SelectValue placeholder="Select server" /></SelectTrigger>
            <SelectContent>
              {serverList.map((s: any) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button onClick={() => setAddOpen(true)} disabled={!selectedConfigId}>
            <Plus className="h-4 w-4 mr-1.5" /> Add Playlist
          </Button>
          </>
        )}
        metadata={<RefreshStatus isRefreshing={isFetching} idleLabel="Playlist data up to date" refreshingLabel="Refreshing playlists…" />}
      />

      {backgroundError && (
        <StaleDataNotice message={backgroundError} onRetry={() => { void refetch(); }} isRetrying={isFetching} />
      )}

      {playlistList.length === 0 ? (
        <EmptyState
          icon={Tv}
          title="No IPTV playlists"
          description="Add an M3U/M3U8 playlist to browse channels and stream them into a TeamSpeak channel."
        >
          <Button onClick={() => setAddOpen(true)} disabled={!selectedConfigId}><Plus className="h-4 w-4 mr-1.5" /> Add Playlist</Button>
        </EmptyState>
      ) : (
        <>
          {/* Playlist cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {playlistList.map((p) => (
              <Card
                key={p.id}
                className={`cursor-pointer transition-colors ${selectedPlaylist?.id === p.id ? 'border-primary/50' : 'hover:border-primary/30'}`}
                onClick={() => setSelectedPlaylistId(p.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                  event.preventDefault();
                  setSelectedPlaylistId(p.id);
                }}
                role="button"
                tabIndex={0}
                aria-label={`View ${p.name} channels`}
                aria-pressed={selectedPlaylist?.id === p.id}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm truncate">{p.name}</CardTitle>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        onClick={(e) => { e.stopPropagation(); refreshPlaylist.mutate(p.id, {
                          onSuccess: (r: any) => toast.success(`Refreshed — ${formatNumber(Number(r.channelCount))} channels`),
                          onError: (err: any) => toast.error(err?.response?.data?.error || 'Refresh failed'),
                        }); }}
                        disabled={refreshPlaylist.isPending}
                        aria-label={`Refresh ${p.name}`}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${refreshPlaylist.isPending ? 'animate-spin' : ''}`} />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }}
                        aria-label={`Delete ${p.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="text-[10px]">{formatNumber(p.channelCount)} channels</Badge>
                    {p.autoRefreshMinutes > 0 && <Badge variant="outline" className="text-[10px]">auto {p.autoRefreshMinutes}m</Badge>}
                  </div>
                  {p.lastError
                    ? <p className="text-[10px] text-destructive truncate flex items-center gap-1"><AlertCircle className="h-3 w-3 shrink-0" /> {p.lastError}</p>
                    : <p className="text-[10px] text-muted-foreground">{p.lastRefreshedAt ? `Updated ${formatLocalDateTime(p.lastRefreshedAt)}` : 'Not refreshed yet'}</p>}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Channel browser for selected playlist */}
          {selectedPlaylist && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2"><Radio className="h-4 w-4" /> {selectedPlaylist.name} — Channels</CardTitle>
              </CardHeader>
              <CardContent>
                <ChannelBrowser playlist={selectedPlaylist} bots={botList} />
              </CardContent>
            </Card>
          )}
        </>
      )}

      <AddPlaylistDialog open={addOpen} onClose={() => setAddOpen(false)} serverConfigId={selectedConfigId} />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) { setDeleteTarget(null); setDeleteError(''); } }}
        title="Delete playlist?"
        description={`This removes "${deleteTarget?.name}" and all its channels.`}
        confirmLabel="Delete"
        destructive
        loading={deletePlaylist.isPending}
        error={deleteError}
        onConfirm={() => {
          if (deleteTarget) {
            setDeleteError('');
            deletePlaylist.mutate(deleteTarget.id, {
              onSuccess: () => {
                toast.success('Playlist deleted');
                setDeleteError('');
                setDeleteTarget(null);
              },
              onError: (e: unknown) => {
                const message = apiErrorMessage(e, 'Failed to delete playlist');
                setDeleteError(message);
                toast.error(message);
              },
            });
          }
        }}
      />
    </div>
  );
}
