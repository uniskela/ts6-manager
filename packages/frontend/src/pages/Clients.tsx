import { useEffect, useMemo, useState } from 'react';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
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
import { formatUptime } from '@/lib/utils';
import { Users, MoreHorizontal, LogOut, Ban, Zap, Youtube, Radio, Copy } from 'lucide-react';
import { type ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import type { MusicBotSummary, RadioStationInfo } from '@ts6/common';

type PlayDialogMode = 'youtube' | 'radio' | null;

export default function Clients() {
  const { selectedConfigId, selectedSid } = useServerStore();
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const { data, isLoading, error, refetch, isFetching } = useClients();
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

  const [pokeTarget, setPokeTarget] = useState<{ clid: number; name: string } | null>(null);
  const [pokeMsg, setPokeMsg] = useState('');
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
                      className="h-6 w-6"
                      aria-label="Copy IP"
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
        header: '',
        cell: ({ row }) => {
          const c = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => { setPokeTarget({ clid: c.clid, name: c.client_nickname }); setPokeMsg(''); }}
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
                    kickClient.mutate({ clid: c.clid, reasonid: 5, reasonmsg: 'Kicked by admin' });
                    toast.success(`Kicked ${c.client_nickname}`);
                  }}
                >
                  <LogOut className="mr-2 h-4 w-4" /> Kick from Server
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive cursor-pointer"
                  onClick={() => {
                    banClient.mutate({ clid: c.clid, time: 3600, banreason: 'Banned by admin' });
                    toast.success(`Banned ${c.client_nickname}`);
                  }}
                >
                  <Ban className="mr-2 h-4 w-4" /> Ban (1 hour)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      });
    }
    return cols;
  }, [isAdmin, kickClient, banClient]);

  if (!selectedConfigId || !selectedSid) return <EmptyState icon={Users} title="No server selected" />;
  if (isLoading) return <PageLoader />;
  if (error) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Users}
          title="Connection failed"
          description={(error as any)?.response?.data?.error || (error as any)?.message || 'Could not load clients from the TeamSpeak server.'}
        />
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Clients</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{clients.length} online</p>
        </div>
      </div>

      <DataTable columns={columns} data={clients} searchKey="client_nickname" searchPlaceholder="Search clients..." />

      {/* Poke Dialog */}
      <Dialog open={!!pokeTarget} onOpenChange={() => setPokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Poke {pokeTarget?.name}</DialogTitle>
          </DialogHeader>
          <div>
            <Label className="text-xs">Message</Label>
            <Input value={pokeMsg} onChange={(e) => setPokeMsg(e.target.value)} placeholder="Hey!" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPokeTarget(null)}>Cancel</Button>
            <Button onClick={() => {
              if (pokeTarget && pokeMsg) {
                pokeClient.mutate({ clid: pokeTarget.clid, msg: pokeMsg });
                toast.success(`Poked ${pokeTarget.name}`);
                setPokeTarget(null);
              }
            }}>
              <Zap className="h-4 w-4 mr-1" /> Poke
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
