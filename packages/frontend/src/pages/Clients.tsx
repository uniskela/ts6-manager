import { useEffect, useMemo, useRef, useState } from 'react';
import { useClients, useKickClient, useBanClient, usePokeClient } from '@/hooks/use-clients';
import { useMusicBots, usePlayUrl } from '@/hooks/use-music-bots';
import { useRadioStations, usePlayRadio } from '@/hooks/use-radio-stations';
import { useServerStore } from '@/stores/server.store';
import { useAuthStore } from '@/stores/auth.store';
import { DataTable } from '@/components/shared/DataTable';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { RefreshStatus, StaleDataNotice } from '@/components/shared/RefreshStatus';
import { formatUptime } from '@/lib/utils';
import { formatNumber } from '@/lib/formatting';
import { apiErrorMessage, isTeamSpeakStarting, teamSpeakConnectionTitle, teamSpeakRefreshTone } from '@/lib/api-error';
import { Users, MoreHorizontal, LogOut, Ban, Zap, Youtube, Radio, Copy } from 'lucide-react';
import { type ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import type { MusicBotSummary, RadioStationInfo } from '@ts6/common';
import { useVirtualServers } from '@/hooks/use-servers';

type PlayDialogMode = 'youtube' | 'radio' | null;

type ClientActionTarget = {
  configId: number;
  sid: number;
  clid: number;
  name: string;
};

export default function Clients() {
  const { selectedConfigId, selectedSid } = useServerStore();
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const { data, isLoading, error, refetch, isFetching } = useClients();
  const {
    error: virtualServersError,
    isLoading: virtualServersLoading,
    isFetching: virtualServersFetching,
    refetch: refetchVirtualServers,
  } = useVirtualServers();
  const kickClient = useKickClient();
  const banClient = useBanClient();
  const pokeClient = usePokeClient();
  const copyIp = (ip: string) => {
    void navigator.clipboard.writeText(ip).then(() => toast.success('IP copied'));
  };
  const { data: bots } = useMusicBots();
  const { data: stations } = useRadioStations(selectedConfigId);
  const playUrl = usePlayUrl();
  const playRadio = usePlayRadio();

  const [kickTarget, setKickTarget] = useState<ClientActionTarget | null>(null);
  const [kickReason, setKickReason] = useState('Kicked by admin');
  const [kickError, setKickError] = useState('');
  const [banTarget, setBanTarget] = useState<ClientActionTarget | null>(null);
  const [banDuration, setBanDuration] = useState('3600');
  const [banReason, setBanReason] = useState('Banned by admin');
  const [banError, setBanError] = useState('');
  const [pokeTarget, setPokeTarget] = useState<ClientActionTarget | null>(null);
  const [pokeMsg, setPokeMsg] = useState('');
  const [pokeError, setPokeError] = useState('');
  const kickSubmitting = useRef(false);
  const banSubmitting = useRef(false);
  const pokeSubmitting = useRef(false);
  const kickReasonInput = useRef<HTMLInputElement>(null);
  const banReasonInput = useRef<HTMLInputElement>(null);
  const pokeMessageInput = useRef<HTMLInputElement>(null);
  const [playMode, setPlayMode] = useState<PlayDialogMode>(null);
  const [playClientName, setPlayClientName] = useState('');
  const [selectedBotId, setSelectedBotId] = useState<string>('');
  const [ytUrl, setYtUrl] = useState('');
  const [selectedStationId, setSelectedStationId] = useState<string>('');

  const clients = useMemo(() => {
    if (!data || !Array.isArray(data)) return [];
    return data.filter((c: any) => String(c.client_type) === '0');
  }, [data]);

  const runningBots = useMemo(() => {
    const list = (Array.isArray(bots) ? bots : []) as MusicBotSummary[];
    return list.filter(
      (b) =>
        b.status !== 'stopped' &&
        b.status !== 'error' &&
        (!selectedConfigId || b.serverConfigId === selectedConfigId),
    );
  }, [bots, selectedConfigId]);

  const stationList = (Array.isArray(stations) ? stations : []) as RadioStationInfo[];

  useEffect(() => {
    if (!playMode) return;
    if (selectedBotId && runningBots.some((b) => String(b.id) === selectedBotId)) return;
    setSelectedBotId(runningBots[0] ? String(runningBots[0].id) : '');
  }, [playMode, runningBots, selectedBotId]);

  useEffect(() => {
    if (playMode !== 'radio') return;
    if (selectedStationId && stationList.some((s) => String(s.id) === selectedStationId)) return;
    setSelectedStationId(stationList[0] ? String(stationList[0].id) : '');
  }, [playMode, stationList, selectedStationId]);

  const openPlayDialog = (mode: Exclude<PlayDialogMode, null>, clientName: string) => {
    setPlayClientName(clientName);
    setYtUrl('');
    setPlayMode(mode);
  };

  const closePlayDialog = () => {
    setPlayMode(null);
    setPlayClientName('');
    setYtUrl('');
  };

  const closeKickDialog = () => {
    setKickTarget(null);
    setKickReason('Kicked by admin');
    setKickError('');
  };

  const closeBanDialog = () => {
    setBanTarget(null);
    setBanDuration('3600');
    setBanReason('Banned by admin');
    setBanError('');
  };

  const closePokeDialog = () => {
    setPokeTarget(null);
    setPokeMsg('');
    setPokeError('');
  };

  const handleKick = () => {
    if (!kickTarget || kickSubmitting.current) return;
    const target = kickTarget;
    kickSubmitting.current = true;
    setKickError('');
    kickClient.mutate(
      {
        configId: target.configId,
        sid: target.sid,
        clid: target.clid,
        reasonid: 5,
        reasonmsg: kickReason.trim(),
      },
      {
        onSuccess: () => {
          toast.success(`Kicked ${target.name}`);
          closeKickDialog();
        },
        onError: (error) => {
          const message = `Could not kick ${target.name}: ${apiErrorMessage(error, 'The server did not accept the request')}`;
          setKickError(message);
          toast.error(message);
        },
        onSettled: () => { kickSubmitting.current = false; },
      },
    );
  };

  const handleBan = () => {
    if (!banTarget || banSubmitting.current) return;
    const target = banTarget;
    banSubmitting.current = true;
    setBanError('');
    banClient.mutate(
      {
        configId: target.configId,
        sid: target.sid,
        clid: target.clid,
        time: Number(banDuration),
        banreason: banReason.trim(),
      },
      {
        onSuccess: () => {
          toast.success(`Banned ${target.name}`);
          closeBanDialog();
        },
        onError: (error) => {
          const message = `Could not ban ${target.name}: ${apiErrorMessage(error, 'The server did not accept the request')}`;
          setBanError(message);
          toast.error(message);
        },
        onSettled: () => { banSubmitting.current = false; },
      },
    );
  };

  const handlePoke = () => {
    if (!pokeTarget || !pokeMsg.trim() || pokeSubmitting.current) return;
    const target = pokeTarget;
    const messageText = pokeMsg.trim();
    pokeSubmitting.current = true;
    setPokeError('');
    pokeClient.mutate(
      { configId: target.configId, sid: target.sid, clid: target.clid, msg: messageText },
      {
        onSuccess: () => {
          toast.success(`Poked ${target.name}`);
          closePokeDialog();
        },
        onError: (error) => {
          const message = `Could not poke ${target.name}: ${apiErrorMessage(error, 'The server did not accept the request')}`;
          setPokeError(message);
          toast.error(message);
        },
        onSettled: () => { pokeSubmitting.current = false; },
      },
    );
  };

  const handlePlayYouTube = () => {
    const botId = parseInt(selectedBotId, 10);
    const url = ytUrl.trim();
    if (!botId || !url) {
      toast.error('Select a music bot and paste a YouTube, Spotify, or Apple Music URL');
      return;
    }
    playUrl.mutate(
      { botId, url },
      {
        onSuccess: (res: any) => {
          const count = res?.queued ?? 1;
          toast.success(
            res?.playlist
              ? `Playing playlist (${count} tracks) on music bot`
              : 'Playing on music bot',
          );
          closePlayDialog();
        },
        onError: (err: any) => {
          toast.error(err?.response?.data?.error || err?.message || 'Failed to play URL');
        },
      },
    );
  };

  const handlePlayRadio = () => {
    const botId = parseInt(selectedBotId, 10);
    const stationId = parseInt(selectedStationId, 10);
    if (!botId || !stationId) {
      toast.error('Select a music bot and a radio station');
      return;
    }
    playRadio.mutate(
      { botId, stationId },
      {
        onSuccess: () => {
          toast.success('Playing radio on music bot');
          closePlayDialog();
        },
        onError: (err: any) => {
          toast.error(err?.response?.data?.error || err?.message || 'Failed to play radio');
        },
      },
    );
  };

  const columns: ColumnDef<any>[] = useMemo(() => {
    const cols: ColumnDef<any>[] = [
      {
        accessorKey: 'client_nickname',
        header: 'Nickname',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-mono-data text-primary">
              {row.original.client_nickname?.[0]?.toUpperCase() || '?'}
            </div>
            <span className="font-medium">{row.original.client_nickname}</span>
          </div>
        ),
      },
      {
        accessorKey: 'client_country',
        header: 'Country',
        cell: ({ getValue }) => <span className="font-mono-data text-xs">{(getValue() as string) || '-'}</span>,
      },
      ...(isAdmin
        ? [{
            accessorKey: 'connection_client_ip',
            header: 'IP',
            cell: ({ row }: { row: { original: Record<string, unknown> } }) => {
              const ip = String(row.original.connection_client_ip || '-');
              return (
                <div className="flex items-center gap-1 font-mono-data text-xs">
                  <span>{ip}</span>
                  {ip !== '-' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Copy IP ${ip}`}
                      onClick={() => copyIp(ip)}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              );
            },
          } as ColumnDef<any>]
        : []),
      {
        accessorKey: 'client_idle_time',
        header: 'Idle',
        cell: ({ getValue }) => <span className="font-mono-data text-xs text-muted-foreground">{formatUptime(Math.floor((getValue() as number) / 1000))}</span>,
      },
      {
        accessorKey: 'client_away',
        header: 'Status',
        cell: ({ row }) => {
          const o = row.original;
          if (Number(o.client_output_muted) === 1 && Number(o.client_away) === 1) {
            return <Badge className="bg-orange-500/15 text-orange-700 text-[10px]">Speaker away</Badge>;
          }
          if (Number(o.client_output_muted) === 1 && Number(o.client_input_muted) === 1) {
            return <Badge className="bg-orange-500/15 text-orange-700 text-[10px]">Speaker + mic muted</Badge>;
          }
          if (Number(o.client_output_muted) === 1) {
            return <Badge className="bg-orange-500/15 text-orange-700 text-[10px]">Speaker muted</Badge>;
          }
          if (Number(o.client_away) === 1) return <Badge variant="warning" className="text-[10px]">Away</Badge>;
          if (Number(o.client_input_muted) === 1) return <Badge variant="secondary" className="text-[10px]">Mic muted</Badge>;
          return <Badge variant="success" className="text-[10px]">Active</Badge>;
        },
      },
    ];
    if (isAdmin) {
      cols.push({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const c = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="cursor-pointer" aria-label={`Actions for ${c.client_nickname}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => {
                    if (!selectedConfigId || !selectedSid) return;
                    setPokeTarget({ configId: selectedConfigId, sid: selectedSid, clid: c.clid, name: c.client_nickname });
                    setPokeMsg('');
                    setPokeError('');
                  }}
                >
                  <Zap className="mr-2 h-4 w-4" /> Poke
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => openPlayDialog('youtube', c.client_nickname)}
                >
                  <Youtube className="mr-2 h-4 w-4" /> Play YouTube / Spotify / Apple Music
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => openPlayDialog('radio', c.client_nickname)}
                >
                  <Radio className="mr-2 h-4 w-4" /> Play Radio
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => {
                    if (!selectedConfigId || !selectedSid) return;
                    setKickTarget({ configId: selectedConfigId, sid: selectedSid, clid: c.clid, name: c.client_nickname });
                    setKickReason('Kicked by admin');
                    setKickError('');
                  }}
                >
                  <LogOut className="mr-2 h-4 w-4" /> Kick from Server
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive cursor-pointer"
                  onClick={() => {
                    if (!selectedConfigId || !selectedSid) return;
                    setBanTarget({ configId: selectedConfigId, sid: selectedSid, clid: c.clid, name: c.client_nickname });
                    setBanDuration('3600');
                    setBanReason('Banned by admin');
                    setBanError('');
                  }}
                >
                  <Ban className="mr-2 h-4 w-4" /> Ban client
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      });
    }
    return cols;
  }, [isAdmin, selectedConfigId, selectedSid]);

  const hasClientData = Array.isArray(data);
  const gateError = error || virtualServersError;
  const isFetchingGate = isFetching || virtualServersFetching;
  const retryGate = () => {
    void refetchVirtualServers();
    void refetch();
  };

  if (!selectedConfigId || !selectedSid) return <EmptyState icon={Users} title="No server selected" />;
  if ((isLoading || virtualServersLoading) && !hasClientData) return <PageLoader />;
  if (gateError && !hasClientData) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Users}
          title={teamSpeakConnectionTitle(gateError)}
          description={apiErrorMessage(
            gateError,
            isTeamSpeakStarting(gateError)
              ? 'TeamSpeak Query is still coming up after startup. Wait a moment and retry.'
              : 'Could not load clients from the TeamSpeak server.',
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
  const backgroundError = gateError
    ? apiErrorMessage(
      gateError,
      isTeamSpeakStarting(gateError)
        ? 'TeamSpeak Query is still starting. Client data may be incomplete until it comes online.'
        : 'Client refresh failed. The last successful client list is still displayed.',
    )
    : null;
  const refreshTone = teamSpeakRefreshTone(gateError);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Clients"
        icon={Users}
        description={`${formatNumber(clients.length)} online`}
        metadata={(
          <RefreshStatus
            isRefreshing={isFetchingGate}
            tone={refreshTone}
            idleLabel="Live client updates active"
            refreshingLabel="Refreshing clients…"
            degradedLabel="Client updates interrupted"
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

      <DataTable
        columns={columns}
        data={clients}
        searchEnabled
        searchLabel="Search clients"
        searchPlaceholder="Search clients..."
        tableLabel="Clients table"
        density="compact"
        stickyHeader
        emptyText="No clients found"
        filteredEmptyText="No clients match your search"
      />

      {/* Kick confirmation */}
      <Dialog
        open={!!kickTarget}
        onOpenChange={(open) => { if (!open && !kickClient.isPending) closeKickDialog(); }}
      >
        <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); kickReasonInput.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Kick from Server</DialogTitle>
            <DialogDescription>
              Kick <span className="font-medium text-foreground">{kickTarget?.name}</span> from the current virtual server. They may reconnect unless separately banned.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="kick-reason">Reason</Label>
            <Input
              id="kick-reason"
              ref={kickReasonInput}
              value={kickReason}
              onChange={(event) => setKickReason(event.target.value)}
              autoFocus
              disabled={kickClient.isPending}
            />
          </div>
          {kickError && <p role="alert" className="text-sm text-destructive">{kickError}</p>}
          <DialogFooter>
            <Button className="min-h-10" variant="outline" onClick={closeKickDialog} disabled={kickClient.isPending}>Cancel</Button>
            <Button
              className="min-h-10"
              variant="destructive"
              onClick={handleKick}
              disabled={kickClient.isPending}
              aria-busy={kickClient.isPending}
            >
              <LogOut className="h-4 w-4 mr-1" />
              {kickClient.isPending ? 'Kicking…' : 'Kick from Server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ban confirmation */}
      <Dialog
        open={!!banTarget}
        onOpenChange={(open) => { if (!open && !banClient.isPending) closeBanDialog(); }}
      >
        <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); banReasonInput.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Ban client</DialogTitle>
            <DialogDescription>
              This will disconnect <span className="font-medium text-foreground">{banTarget?.name}</span> and prevent them from reconnecting for the selected duration.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ban-duration">Duration</Label>
              <Select value={banDuration} onValueChange={setBanDuration} disabled={banClient.isPending}>
                <SelectTrigger id="ban-duration" aria-label="Duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3600">1 hour</SelectItem>
                  <SelectItem value="86400">1 day</SelectItem>
                  <SelectItem value="604800">1 week</SelectItem>
                  <SelectItem value="2592000">30 days</SelectItem>
                  <SelectItem value="0">Permanent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ban-reason">Reason</Label>
              <Input
                id="ban-reason"
                ref={banReasonInput}
                value={banReason}
                onChange={(event) => setBanReason(event.target.value)}
                autoFocus
                disabled={banClient.isPending}
              />
            </div>
          </div>
          {banError && <p role="alert" className="text-sm text-destructive">{banError}</p>}
          <DialogFooter>
            <Button className="min-h-10" variant="outline" onClick={closeBanDialog} disabled={banClient.isPending}>Cancel</Button>
            <Button
              className="min-h-10"
              variant="destructive"
              onClick={handleBan}
              disabled={banClient.isPending}
              aria-busy={banClient.isPending}
            >
              <Ban className="h-4 w-4 mr-1" />
              {banClient.isPending ? 'Banning…' : 'Ban client'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Poke Dialog */}
      <Dialog
        open={!!pokeTarget}
        onOpenChange={(open) => { if (!open && !pokeClient.isPending) closePokeDialog(); }}
      >
        <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); pokeMessageInput.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Poke {pokeTarget?.name}</DialogTitle>
            <DialogDescription>
              Send a short notification to {pokeTarget?.name}. The dialog stays open if the server rejects it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="poke-message">Message</Label>
            <Input
              id="poke-message"
              ref={pokeMessageInput}
              value={pokeMsg}
              onChange={(e) => setPokeMsg(e.target.value)}
              placeholder="Hey!"
              autoFocus
              disabled={pokeClient.isPending}
            />
          </div>
          {pokeError && <p role="alert" className="text-sm text-destructive">{pokeError}</p>}
          <DialogFooter>
            <Button className="min-h-10" variant="outline" onClick={closePokeDialog} disabled={pokeClient.isPending}>Cancel</Button>
            <Button
              className="min-h-10"
              onClick={handlePoke}
              disabled={!pokeMsg.trim() || pokeClient.isPending}
              aria-busy={pokeClient.isPending}
            >
              <Zap className="h-4 w-4 mr-1" />
              {pokeClient.isPending ? 'Sending…' : 'Send poke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Play YouTube / Playlist */}
      <Dialog open={playMode === 'youtube'} onOpenChange={(open) => !open && closePlayDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Play URL{playClientName ? ` (from ${playClientName})` : ''}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Paste a YouTube / YouTube Music, Spotify, or Apple Music song or playlist URL. Playback uses the selected music bot&apos;s channel (Apple Music / Spotify resolve via YouTube).
          </p>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Music bot</Label>
              <Select value={selectedBotId} onValueChange={setSelectedBotId}>
                <SelectTrigger className="cursor-pointer">
                  <SelectValue placeholder={runningBots.length === 0 ? 'No running bots' : 'Select bot...'} />
                </SelectTrigger>
                <SelectContent>
                  {runningBots.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)} className="cursor-pointer">
                      {b.name} — {b.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">YouTube / Spotify / Apple Music URL</Label>
              <Input
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                placeholder="https://music.apple.com/... or YouTube / Spotify URL"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePlayDialog}>Cancel</Button>
            <Button
              onClick={handlePlayYouTube}
              disabled={!selectedBotId || !ytUrl.trim() || playUrl.isPending || runningBots.length === 0}
            >
              <Youtube className="h-4 w-4 mr-1" />
              {playUrl.isPending ? 'Starting…' : 'Play'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Play Radio */}
      <Dialog open={playMode === 'radio'} onOpenChange={(open) => !open && closePlayDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Play Radio{playClientName ? ` (from ${playClientName})` : ''}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Stream a saved radio station on a running music bot. Add stations under Music → Radio.
          </p>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Music bot</Label>
              <Select value={selectedBotId} onValueChange={setSelectedBotId}>
                <SelectTrigger className="cursor-pointer">
                  <SelectValue placeholder={runningBots.length === 0 ? 'No running bots' : 'Select bot...'} />
                </SelectTrigger>
                <SelectContent>
                  {runningBots.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)} className="cursor-pointer">
                      {b.name} — {b.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Station</Label>
              <Select value={selectedStationId} onValueChange={setSelectedStationId}>
                <SelectTrigger className="cursor-pointer">
                  <SelectValue placeholder={stationList.length === 0 ? 'No stations' : 'Select station...'} />
                </SelectTrigger>
                <SelectContent>
                  {stationList.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)} className="cursor-pointer">
                      {s.name}{s.genre ? ` (${s.genre})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePlayDialog}>Cancel</Button>
            <Button
              onClick={handlePlayRadio}
              disabled={!selectedBotId || !selectedStationId || playRadio.isPending || runningBots.length === 0 || stationList.length === 0}
            >
              <Radio className="h-4 w-4 mr-1" />
              {playRadio.isPending ? 'Starting…' : 'Play'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
