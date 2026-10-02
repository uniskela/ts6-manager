import { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMusicBots } from '@/hooks/use-music-bots';
import {
  useRadioStations,
  useRadioPresets,
  useCreateRadioStation,
  useUpdateRadioStation,
  useDeleteRadioStation,
  useResetRadioStationIds,
  usePlayRadio,
} from '@/hooks/use-radio-stations';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Plus, Trash2, Play, Radio } from 'lucide-react';
import { toast } from 'sonner';
import { toastMediaStarted } from '@/lib/media-start-toast';
import { apiErrorMessage } from '@/lib/api-error';
import type { MusicBotSummary, RadioStationInfo, RadioPreset } from '@ts6/common';


// ─── Radio Tab ───────────────────────────────────────────────────────────────

export function RadioTab() {
  const [searchParams] = useSearchParams();
  const linkedBot = Number(searchParams.get('bot')) || null;
  const linkedServer = Number(searchParams.get('server')) || null;
  const { selectedConfigId, setServer } = useServerStore();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<number | null>(linkedServer || selectedConfigId);
  const configId = serverId || selectedConfigId;

  const { data: stations, isLoading } = useRadioStations(configId);
  const { data: presets } = useRadioPresets(configId);
  const createStation = useCreateRadioStation();
  const updateStation = useUpdateRadioStation();
  const stationPending = createStation.isPending || updateStation.isPending;
  const deleteStation = useDeleteRadioStation();
  const resetStationIds = useResetRadioStationIds();
  const playRadio = usePlayRadio();

  const { data: bots } = useMusicBots();
  const runningBots = (Array.isArray(bots) ? bots : []).filter(
    (b: MusicBotSummary) => b.status !== 'stopped' && b.status !== 'error'
  );

  const [selectedBotId, setSelectedBotId] = useState<number | null>(linkedBot);
  const appliedLinkedBot = useRef<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', url: '', genre: '' });
  const [editingStation, setEditingStation] = useState<RadioStationInfo | null>(null);
  const stationSaveInFlight = useRef(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const serverList = Array.isArray(servers) ? servers : [];
  const stationList = (Array.isArray(stations) ? stations : []) as RadioStationInfo[];
  const presetList = (Array.isArray(presets) ? presets : []) as RadioPreset[];
  const runningBotIds = runningBots.map((b: MusicBotSummary) => b.id).join(',');

  useEffect(() => {
    if (linkedServer) {
      setServerId(linkedServer);
      setServer(linkedServer);
    }
  }, [linkedServer, setServer]);

  // Apply ?bot= once when that bot is running; do not fight later manual selection.
  useEffect(() => {
    if (!linkedBot) {
      appliedLinkedBot.current = null;
      return;
    }
    if (linkedBot === appliedLinkedBot.current) return;
    if (runningBots.some((b: MusicBotSummary) => b.id === linkedBot)) {
      setSelectedBotId(linkedBot);
      appliedLinkedBot.current = linkedBot;
    }
  }, [linkedBot, runningBotIds, runningBots]);

  useEffect(() => {
    setSelectedBotId((current) => {
      if (current && runningBots.some((b: MusicBotSummary) => b.id === current)) return current;
      return runningBots[0]?.id ?? null;
    });
  }, [runningBotIds, runningBots]);

  const handleAddStation = () => {
    if (!configId || !addForm.name.trim() || !addForm.url.trim() || stationSaveInFlight.current) return;
    // Guard dismissal immediately, before the mutation's pending state renders.
    stationSaveInFlight.current = true;
    if (editingStation) {
      updateStation.mutate({
        configId: editingStation.serverConfigId,
        id: editingStation.id,
        data: {
          name: addForm.name,
          ...(addForm.url !== editingStation.url ? { url: addForm.url } : {}),
          genre: addForm.genre,
        },
      }, {
        onSuccess: () => { toast.success('Station updated'); setShowAdd(false); setEditingStation(null); setAddForm({ name: '', url: '', genre: '' }); },
        onError: (error) => toast.error(apiErrorMessage(error, 'Failed to update station')),
        onSettled: () => { stationSaveInFlight.current = false; },
      });
      return;
    }
    createStation.mutate({
      configId,
      data: { name: addForm.name, url: addForm.url, genre: addForm.genre || undefined },
    }, {
      onSuccess: () => { toast.success('Station added'); setShowAdd(false); setAddForm({ name: '', url: '', genre: '' }); },
      onError: () => toast.error('Failed to add station'),
      onSettled: () => { stationSaveInFlight.current = false; },
    });
  };

  const handleAddPreset = (preset: RadioPreset) => {
    if (!configId) return;
    createStation.mutate({
      configId,
      data: { name: preset.name, url: preset.url, genre: preset.genre },
    }, {
      onSuccess: () => toast.success(`Added: ${preset.name}`),
      onError: () => toast.error(`Failed to add: ${preset.name}`),
    });
  };

  const handlePlay = (stationId: number) => {
    if (!selectedBotId) {
      toast.error('Select a running bot first');
      return;
    }
    playRadio.mutate({ botId: selectedBotId, stationId }, {
      onSuccess: () => toastMediaStarted('Playing radio'),
      onError: () => toast.error('Failed to play radio'),
    });
  };

  if (!configId) {
    return <EmptyState icon={Radio} title="Select a server" description="Choose a server to manage radio stations." />;
  }

  return (
    <div className="space-y-4">
      {/* Server + Bot selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(configId)} onValueChange={(v) => setServerId(parseInt(v))}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Server..." /></SelectTrigger>
          <SelectContent>
            {serverList.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="h-6" />

        <Label className="text-xs text-muted-foreground">Play on:</Label>
        <Select
          value={selectedBotId ? String(selectedBotId) : ''}
          onValueChange={(v) => setSelectedBotId(parseInt(v))}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder={runningBots.length === 0 ? 'No running bots' : 'Select bot...'} />
          </SelectTrigger>
          <SelectContent>
            {runningBots.map((b: MusicBotSummary) => (
              <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        <Button
          variant="outline"
          size="sm"
          disabled={!configId || resetStationIds.isPending || stationList.length === 0}
          onClick={() => {
            if (!configId) return;
            resetStationIds.mutate(configId, {
              onSuccess: () => toast.success('Radio station IDs compacted'),
              onError: () => toast.error('Failed to reset station IDs'),
            });
          }}
        >
          Reset IDs
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowPresets(true)}>
          <Radio className="h-4 w-4 mr-1" /> Presets
        </Button>
        <Button size="sm" onClick={() => {
          setEditingStation(null);
          setAddForm({ name: '', url: '', genre: '' });
          setShowAdd(true);
        }}>
          <Plus className="h-4 w-4 mr-1" /> Add Station
        </Button>
      </div>

      {runningBots.length === 0 && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3">
          <p className="text-xs text-amber-500">Start a media bot first to play radio stations.</p>
        </div>
      )}

      {/* Station List */}
      {isLoading ? <PageLoader /> : stationList.length === 0 ? (
        <EmptyState icon={Radio} title="No radio stations" description="Add stations manually or from presets to start streaming." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {stationList.map((station) => (
            <Card key={station.id} className="group hover:border-primary/30 transition-colors">
              <CardContent className="p-3 flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Radio className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{station.name}</p>
                  {station.genre && (
                    <Badge variant="outline" className="text-[9px] mt-0.5">{station.genre}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => {
                      setEditingStation(station);
                      setAddForm({ name: station.name, url: station.url, genre: station.genre || '' });
                      setShowAdd(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="default"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={`Play ${station.name}`}
                    onClick={() => handlePlay(station.id)}
                    disabled={!selectedBotId || playRadio.isPending}
                  >
                    <Play className="h-4 w-4 ml-0.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="touch-action-reveal h-8 w-8 text-destructive transition-opacity hover:text-destructive"
                    aria-label={`Delete ${station.name}`}
                    onClick={() => setDeleteId(station.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add / Edit Station Dialog */}
      <Dialog open={showAdd} onOpenChange={(open) => {
        if (stationSaveInFlight.current) return;
        setShowAdd(open);
        if (!open) {
          setEditingStation(null);
          setAddForm({ name: '', url: '', genre: '' });
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingStation ? 'Edit station' : 'Add Radio Station'}</DialogTitle>
            <DialogDescription>{editingStation ? 'Edit this station’s name, stream URL, and mood or genre.' : 'Add a custom internet radio station by providing its stream URL.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="radio-station-name" className="text-xs">Name</Label>
              <Input id="radio-station-name" disabled={stationPending} value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Station name" />
            </div>
            <div>
              <Label htmlFor="radio-station-url" className="text-xs">Stream URL</Label>
              <Input id="radio-station-url" disabled={stationPending} value={addForm.url} onChange={(e) => setAddForm({ ...addForm, url: e.target.value })} placeholder="https://stream.example.com/live" />
            </div>
            <div>
              <Label htmlFor="radio-station-genre" className="text-xs">Mood or genre</Label>
              <Input id="radio-station-genre" disabled={stationPending} value={addForm.genre} onChange={(e) => setAddForm({ ...addForm, genre: e.target.value })} placeholder="Chill, Focus, Party…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={stationPending} onClick={() => {
              if (!stationSaveInFlight.current) setShowAdd(false);
            }}>Cancel</Button>
            <Button onClick={handleAddStation} disabled={!addForm.name.trim() || !addForm.url.trim() || stationPending}>
              {editingStation ? 'Save' : 'Add Station'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Presets Dialog */}
      <Dialog open={showPresets} onOpenChange={setShowPresets}>
        <DialogContent className="max-w-lg [--dialog-max-height:80vh] flex flex-col overflow-auto">
          <DialogHeader>
            <DialogTitle>Radio Presets</DialogTitle>
            <DialogDescription>Add popular radio stations with one click.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 max-h-[400px] overflow-y-auto">
            {presetList.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No presets available.</p>
            ) : presetList.map((preset, i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2 hover:bg-muted/50 transition-colors rounded">
                <Radio className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{preset.name}</p>
                  <p className="text-[10px] text-muted-foreground">{preset.genre}</p>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
                  onClick={() => handleAddPreset(preset)}
                  disabled={createStation.isPending}
                >
                  <Plus className="h-3 w-3 mr-1" /> Add
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPresets(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Radio Station?"
        description="This will remove this station from your list."
        onConfirm={() => {
          if (deleteId && configId) deleteStation.mutate({ configId, id: deleteId }, {
            onSuccess: () => { toast.success('Station removed'); setDeleteId(null); },
          });
        }}
        destructive
      />
    </div>
  );
}

