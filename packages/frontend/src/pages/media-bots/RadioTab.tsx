import { useState, useRef, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useRadioStations,
  useRadioPresets,
  useBrowseRadioStations,
  useCreateRadioStation,
  useUpdateRadioStation,
  useDeleteRadioStation,
  useResetRadioStationIds,
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
import { Plus, Trash2, Radio, Search } from 'lucide-react';
import { toast } from 'sonner';
import { apiErrorMessage } from '@/lib/api-error';
import type { RadioStationInfo, RadioPreset, RadioBrowserStationInfo } from '@ts6/common';


// ─── Radio Tab ───────────────────────────────────────────────────────────────

/** Manage a server's radio stations. Stations play from a bot's console in the Bot Hub. */
export function RadioTab() {
  const [searchParams] = useSearchParams();
  const linkedServer = Number(searchParams.get('server')) || null;
  const { selectedConfigId, setServer } = useServerStore();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<number | null>(linkedServer || selectedConfigId);
  const configId = serverId || selectedConfigId;

  const { data: stations, isLoading } = useRadioStations(configId);
  const { data: presets } = useRadioPresets(configId);
  const browseStations = useBrowseRadioStations();
  const createStation = useCreateRadioStation();
  const updateStation = useUpdateRadioStation();
  const stationPending = createStation.isPending || updateStation.isPending;
  const deleteStation = useDeleteRadioStation();
  const resetStationIds = useResetRadioStationIds();

  const [showAdd, setShowAdd] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [showBrowse, setShowBrowse] = useState(false);
  const [browseQuery, setBrowseQuery] = useState('');
  const [browseResults, setBrowseResults] = useState<RadioBrowserStationInfo[]>([]);
  const [browseSearchState, setBrowseSearchState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  // Bumped when the dialog resets or the query changes so a slow search cannot restore stale results.
  const browseRequestId = useRef(0);
  const [addForm, setAddForm] = useState({ name: '', url: '', genre: '' });
  const [editingStation, setEditingStation] = useState<RadioStationInfo | null>(null);
  const stationSaveInFlight = useRef(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const serverList = Array.isArray(servers) ? servers : [];
  const stationList = (Array.isArray(stations) ? stations : []) as RadioStationInfo[];
  const presetList = (Array.isArray(presets) ? presets : []) as RadioPreset[];
  const existingUrls = new Set(stationList.map((s) => s.url));

  useEffect(() => {
    if (linkedServer) {
      setServerId(linkedServer);
      setServer(linkedServer);
    }
  }, [linkedServer, setServer]);

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

  const handleBrowseSearch = () => {
    if (!configId || !browseQuery.trim()) return;
    const requestId = ++browseRequestId.current;
    setBrowseResults([]);
    setBrowseSearchState('pending');
    browseStations.mutate(
      { configId, q: browseQuery.trim() },
      {
        onSuccess: (data) => {
          if (requestId !== browseRequestId.current) return;
          setBrowseResults(Array.isArray(data) ? data as RadioBrowserStationInfo[] : []);
          setBrowseSearchState('success');
        },
        onError: (error) => {
          if (requestId !== browseRequestId.current) return;
          setBrowseSearchState('error');
          toast.error(apiErrorMessage(error, 'Radio Browser search failed'));
        },
      },
    );
  };

  const handleAddBrowseStation = (station: RadioBrowserStationInfo) => {
    if (!configId || existingUrls.has(station.url)) return;
    createStation.mutate({
      configId,
      data: {
        name: station.name,
        url: station.url,
        genre: station.genre || undefined,
        imageUrl: station.imageUrl || undefined,
        stationuuid: station.stationuuid,
      },
    }, {
      onSuccess: () => toast.success(`Added: ${station.name}`),
      onError: (error) => toast.error(apiErrorMessage(error, `Failed to add: ${station.name}`)),
    });
  };

  if (!configId) {
    return <EmptyState icon={Radio} title="Select a server" description="Choose a server to manage radio stations." />;
  }

  return (
    <div className="space-y-4">
      {/* Server selector + station actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(configId)} onValueChange={(v) => setServerId(parseInt(v))}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Server..." /></SelectTrigger>
          <SelectContent>
            {serverList.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            browseRequestId.current += 1;
            setBrowseQuery('');
            setBrowseResults([]);
            setBrowseSearchState('idle');
            setShowBrowse(true);
          }}
        >
          <Search className="h-4 w-4 mr-1" /> Search stations
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

      <p className="text-sm text-muted-foreground">
        Play a station from a bot&apos;s console in the <Link to="/bot-hub" className="text-primary underline-offset-4 hover:underline">Bot Hub</Link>.
      </p>

      {/* Station List */}
      {isLoading ? <PageLoader /> : stationList.length === 0 ? (
        <EmptyState icon={Radio} title="No radio stations" description="Add stations manually, from presets, or search Community Radio Browser, then play them from a bot's console." />
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
                    aria-label={`Edit ${station.name}`}
                    onClick={() => {
                      setEditingStation(station);
                      setAddForm({ name: station.name, url: station.url, genre: station.genre || '' });
                      setShowAdd(true);
                    }}
                  >
                    Edit
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

      {/* Community Radio Browser search */}
      <Dialog open={showBrowse} onOpenChange={setShowBrowse}>
        <DialogContent className="max-w-lg [--dialog-max-height:80vh] flex flex-col overflow-auto">
          <DialogHeader>
            <DialogTitle>Search stations</DialogTitle>
            <DialogDescription>
              Find internet radio stations and add them to this server&apos;s list.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              handleBrowseSearch();
            }}
          >
            <Input
              value={browseQuery}
              onChange={(e) => {
                browseRequestId.current += 1;
                setBrowseQuery(e.target.value);
                setBrowseResults([]);
                setBrowseSearchState('idle');
              }}
              placeholder="Name, e.g. Jazz, BBC, Techno…"
              disabled={browseSearchState === 'pending'}
              aria-label="Search stations"
            />
            <Button type="submit" disabled={!browseQuery.trim() || browseSearchState === 'pending'}>
              Search
            </Button>
          </form>
          <div className="flex-1 max-h-[400px] overflow-y-auto">
            {browseSearchState === 'pending' ? (
              <p className="text-xs text-muted-foreground text-center py-8">Searching…</p>
            ) : browseSearchState === 'error' ? (
              <p className="text-xs text-muted-foreground text-center py-8">Search failed. Try again.</p>
            ) : browseResults.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">
                {browseSearchState === 'success' ? 'No stations found.' : 'Enter a name to search.'}
              </p>
            ) : (
              browseResults.map((station) => {
                const alreadyAdded = existingUrls.has(station.url);
                return (
                  <div key={station.stationuuid} className="flex items-center gap-3 px-2 py-2 hover:bg-muted/50 transition-colors rounded">
                    <Radio className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{station.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {[station.genre, station.countrycode, station.codec && `${station.codec}${station.bitrate ? ` ${station.bitrate}k` : ''}`]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs shrink-0"
                      onClick={() => handleAddBrowseStation(station)}
                      disabled={alreadyAdded || createStation.isPending}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      {alreadyAdded ? 'Added' : 'Add'}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Station data from{' '}
            <a
              href="https://www.radio-browser.info/"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              Community Radio Browser
            </a>
            .
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBrowse(false)}>Done</Button>
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

