import { useState, useRef, useEffect, useCallback } from 'react';
import axios from 'axios';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { musicRequestsApi } from '@/api/music-requests.api';
import { musicBotsApi } from '@/api/music.api';
import {
  useMusicBots, useCreateMusicBot, useUpdateMusicBot, useDeleteMusicBot,
  useStartMusicBot, useStopMusicBot, useMusicBotState,
  usePlaySong, usePlayUrl, usePausePlayback, useResumePlayback, useStopPlayback,
  useSkipTrack, usePreviousTrack, useSeek, useSetVolume,
  useEnqueue, useLoadPlaylist, useRemoveFromQueue, useClearQueue,
  useSetShuffle, useSetRepeat,
  usePlayFromQueue, useMoveQueueItem,
} from '@/hooks/use-music-bots';
import { useSongs, useUploadSong, useDeleteSong, useYouTubeSearch, useYouTubeDownload, useYouTubeInfo, useYouTubeDownloadBatch, useYouTubeRegister, useScanLibrary, useYouTubeImportPlaylist, useYouTubeImportStatus } from '@/hooks/use-music-library';
import { useRadioStations, useRadioPresets, useCreateRadioStation, useDeleteRadioStation, useResetRadioStationIds, usePlayRadio } from '@/hooks/use-radio-stations';
import { usePlaylists, usePlaylist, useCreatePlaylist, useUpdatePlaylist, useDeletePlaylist, useAddSongToPlaylist, useAddPlaylistToPlaylist, useRemoveSongFromPlaylist } from '@/hooks/use-playlists';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Music, Plus, Trash2, Play, Pause, SkipForward, SkipBack, Square,
  Volume2, VolumeX, Upload, Search, Download, ListMusic, Shuffle,
  Repeat, Repeat1, Power, PowerOff, RefreshCw, Pencil, X, Loader2,
  Youtube, FileAudio, Link, GripVertical, Music2, Radio, Clock,
  Video, MessageSquare,
} from 'lucide-react';
import { VideoStreamTab } from '@/components/video/VideoStreamTab';
import { toast } from 'sonner';
import { formatBytes } from '@/lib/utils';
import type { MusicBotSummary, PlaybackState, SongInfo, PlaylistSummary, PlaylistDetail, PlaylistMode, YouTubeSearchResult, RadioStationInfo, RadioPreset, ChatCommandInfo } from '@ts6/common';
import {
  useChatCommands, useCreateChatCommand, useUpdateChatCommand, useDeleteChatCommand,
} from '@/hooks/use-chat-commands';
import { Textarea } from '@/components/ui/textarea';

// ─── Helper ──────────────────────────────────────────────────────────────────

function formatTime(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface UrlLoadInfo {
  type: 'video' | 'playlist';
  items: YouTubeSearchResult[];
  title?: string;
  sourceTrackCount?: number;
  matchedCount?: number;
  cappedAt?: number;
}

function youtubeInfoErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
    return 'Matching tracks is taking longer than expected — try again in a minute';
  }
  if (axios.isAxiosError(err) && err.response?.data?.error) {
    return String(err.response.data.error);
  }
  return 'Failed to load URL info';
}

function urlInfoPlaylistLabel(info: UrlLoadInfo): string {
  if (info.type !== 'playlist') return 'Single Video';
  if (info.sourceTrackCount != null && info.matchedCount != null) {
    const cap = info.cappedAt ?? info.items.length;
    return `${info.matchedCount} matched of ${info.sourceTrackCount} (first ${cap} searched)`;
  }
  return `Playlist (${info.items.length} videos)`;
}

function urlItemSelectKey(index: number): string {
  return String(index);
}

function allUrlItemKeys(count: number): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < count; i++) keys.add(urlItemSelectKey(i));
  return keys;
}

function selectedUrlItems(items: YouTubeSearchResult[], selectedKeys: Set<string>): YouTubeSearchResult[] {
  return items.filter((_, i) => selectedKeys.has(urlItemSelectKey(i)));
}

interface ImportJobStatus {
  phase?: 'matching' | 'importing';
  processed?: number;
  total?: number;
  matchProcessed?: number;
  matchTotal?: number;
  matched?: number;
  downloaded?: number;
  registered?: number;
  skipped?: number;
  errors?: string[];
}

function importJobProgressLabel(job: ImportJobStatus | undefined | null): string {
  if (!job) return '?';
  if (job.phase === 'matching') {
    return `Matching ${job.matchProcessed ?? 0}/${job.matchTotal ?? '?'} (${job.matched ?? 0} hits)`;
  }
  return `Importing ${job.processed ?? 0}/${job.total ?? '?'}`;
}

function importJobCompleteMessage(job: ImportJobStatus): string {
  const parts: string[] = [];
  if ((job.registered ?? 0) > 0) parts.push(`${job.registered} registered`);
  if ((job.downloaded ?? 0) > 0) parts.push(`${job.downloaded} downloaded`);
  if ((job.skipped ?? 0) > 0) parts.push(`${job.skipped} skipped`);
  return parts.length ? `Import complete: ${parts.join(', ')}` : 'Import complete';
}

const statusColors: Record<string, string> = {
  stopped: 'bg-zinc-500',
  starting: 'bg-amber-500 animate-pulse',
  connected: 'bg-emerald-500',
  playing: 'bg-emerald-500 animate-pulse',
  paused: 'bg-amber-500',
  error: 'bg-red-500',
};

// ─── Bot Player Card ─────────────────────────────────────────────────────────

function BotPlayerCard({ bot, onEdit, onDelete, onPlay }: {
  bot: MusicBotSummary;
  onEdit: () => void;
  onDelete: () => void;
  onPlay: () => void;
}) {
  const startBot = useStartMusicBot();
  const stopBot = useStopMusicBot();
  const { data: state } = useMusicBotState(
    bot.status !== 'stopped' ? bot.id : null,
  ) as { data: PlaybackState | undefined };

  const pausePlayback = usePausePlayback();
  const resumePlayback = useResumePlayback();
  const stopPlayback = useStopPlayback();
  const skipTrack = useSkipTrack();
  const previousTrack = usePreviousTrack();
  const setVolume = useSetVolume();
  const seekMut = useSeek();
  const shuffleMut = useSetShuffle();
  const repeatMut = useSetRepeat();

  // Widget token dialog
  const [showWidget, setShowWidget] = useState(false);
  const [widgetData, setWidgetData] = useState<{ token: string; jsonUrl: string; bbcodeUrl: string } | null>(null);

  // Local drag state so sliders don't snap back during interaction
  const [draggingSeek, setDraggingSeek] = useState<number | null>(null);
  const [draggingVolume, setDraggingVolume] = useState<number | null>(null);

  const isRunning = bot.status !== 'stopped' && bot.status !== 'error';
  const isPlaying = state?.status === 'playing';
  const isPaused = state?.status === 'paused';
  const isStreaming = state?.isStreaming ?? false;

  return (
    <Card className="group hover:border-primary/30 transition-colors">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`h-2 w-2 rounded-full shrink-0 ${statusColors[bot.status] || 'bg-zinc-500'}`} />
            <CardTitle className="text-sm font-medium truncate">{bot.name}</CardTitle>
            <Badge variant="secondary" className="text-[9px] font-mono-data shrink-0">ID {bot.id}</Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Player Widget"
              onClick={() => {
                musicBotsApi.playerWidgetToken(bot.id).then(setWidgetData);
                setShowWidget(true);
              }}
            >
              <Link className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Status badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px] capitalize">{bot.status}</Badge>
          <Badge variant="outline" className="text-[10px]">{bot.nickname}</Badge>
          {bot.serverConfig && (
            <Badge variant="secondary" className="text-[10px]">{bot.serverConfig.name}</Badge>
          )}
        </div>

        {/* Play button when connected but idle */}
        {isRunning && !state?.nowPlaying && (
          <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={onPlay}>
            <Play className="h-3.5 w-3.5 mr-1.5" /> Play Song...
          </Button>
        )}

        {/* Now Playing */}
        {state?.nowPlaying && (
          <div className="rounded-md bg-muted/50 p-2.5 space-y-2">
            <div className="flex items-center gap-2 min-w-0">
              {isStreaming ? <Radio className="h-3.5 w-3.5 text-red-500 shrink-0" /> : <Music2 className="h-3.5 w-3.5 text-primary shrink-0" />}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{state.nowPlaying.title}</p>
                {state.nowPlaying.artist && (
                  <p className="text-[10px] text-muted-foreground truncate">{state.nowPlaying.artist}</p>
                )}
              </div>
              {isStreaming && (
                <Badge variant="destructive" className="text-[9px] shrink-0 animate-pulse">LIVE</Badge>
              )}
            </div>
            {/* Progress bar (hidden for streams) */}
            {!isStreaming && (
              <div className="space-y-1">
                <Slider
                  value={[draggingSeek ?? state.position ?? 0]}
                  max={state.duration || 1}
                  step={1}
                  onValueChange={([val]) => setDraggingSeek(val)}
                  onValueCommit={([val]) => { seekMut.mutate({ botId: bot.id, seconds: val }); setDraggingSeek(null); }}
                  className="cursor-pointer"
                />
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{formatTime(draggingSeek ?? state.position)}</span>
                  <span>{formatTime(state.duration)}</span>
                </div>
              </div>
            )}
            {/* Controls */}
            <div className="flex items-center justify-center gap-1">
              <Button
                variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => shuffleMut.mutate({ botId: bot.id, enabled: !state.shuffle })}
              >
                <Shuffle className={`h-3.5 w-3.5 ${state.shuffle ? 'text-primary' : ''}`} />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => previousTrack.mutate(bot.id)}
              >
                <SkipBack className="h-3.5 w-3.5" />
              </Button>
              {isPlaying ? (
                <Button variant="outline" size="icon" className="h-8 w-8"
                  onClick={() => pausePlayback.mutate(bot.id)}
                >
                  <Pause className="h-4 w-4" />
                </Button>
              ) : (
                <Button variant="outline" size="icon" className="h-8 w-8"
                  onClick={() => resumePlayback.mutate(bot.id)}
                >
                  <Play className="h-4 w-4 ml-0.5" />
                </Button>
              )}
              <Button variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => skipTrack.mutate(bot.id)}
              >
                <SkipForward className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => {
                  const modes = ['off', 'track', 'queue'] as const;
                  const idx = modes.indexOf(state.repeat);
                  repeatMut.mutate({ botId: bot.id, mode: modes[(idx + 1) % 3] });
                }}
              >
                {state.repeat === 'track' ? (
                  <Repeat1 className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <Repeat className={`h-3.5 w-3.5 ${state.repeat === 'queue' ? 'text-primary' : ''}`} />
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Volume */}
        {isRunning && (
          <div className="flex items-center gap-2">
            <VolumeX className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Slider
              value={[draggingVolume ?? state?.volume ?? bot.volume]}
              max={100}
              step={1}
              onValueChange={([val]) => setDraggingVolume(val)}
              onValueCommit={([val]) => { setVolume.mutate({ botId: bot.id, volume: val }); setDraggingVolume(null); }}
              className="flex-1"
            />
            <Volume2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-[10px] text-muted-foreground w-7 text-right">{draggingVolume ?? state?.volume ?? bot.volume}%</span>
          </div>
        )}

        {/* Queue preview */}
        {state?.queue && state.queue.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground font-medium">Queue ({state.queue.length})</p>
            <div className="space-y-0.5 max-h-24 overflow-y-auto">
              {state.queue.slice(0, 5).map((item, i) => (
                <div key={item.id} className="flex items-center gap-2 text-[10px] py-0.5">
                  <span className="text-muted-foreground w-4 text-right">{i + 1}</span>
                  <span className="truncate flex-1">{item.title}</span>
                  <span className="text-muted-foreground">{formatTime(item.duration)}</span>
                </div>
              ))}
              {state.queue.length > 5 && (
                <p className="text-[10px] text-muted-foreground text-center">+{state.queue.length - 5} more</p>
              )}
            </div>
          </div>
        )}

        {/* Start/Stop */}
        <div className="flex items-center gap-1.5 pt-1">
          {isRunning ? (
            <>
              <Button variant="outline" size="sm" className="h-7 text-xs flex-1"
                onClick={() => stopBot.mutate(bot.id, { onSuccess: () => toast.success('Bot stopped') })}
                disabled={stopBot.isPending}
              >
                <PowerOff className="h-3 w-3 mr-1" /> Stop
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs"
                onClick={onPlay}
              >
                <Music2 className="h-3 w-3 mr-1" /> Play...
              </Button>
              {state?.nowPlaying && (
                <Button variant="ghost" size="sm" className="h-7 text-xs"
                  onClick={() => stopPlayback.mutate(bot.id)}
                >
                  <Square className="h-3 w-3 mr-1" /> Stop Audio
                </Button>
              )}
            </>
          ) : (
            <Button variant="default" size="sm" className="h-7 text-xs flex-1"
              onClick={() => startBot.mutate(bot.id, {
                onSuccess: () => toast.success('Bot started'),
                onError: () => toast.error('Failed to start bot'),
              })}
              disabled={startBot.isPending}
            >
              <Power className="h-3 w-3 mr-1" /> Start
            </Button>
          )}
        </div>
      </CardContent>

      {/* Player Widget Dialog */}
      <Dialog open={showWidget} onOpenChange={setShowWidget}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Player Widget</DialogTitle>
            <DialogDescription className="text-xs">
              Embed these URLs in your TeamSpeak channel description or website.
            </DialogDescription>
          </DialogHeader>
          {widgetData && (
            <div className="space-y-3">
              <div>
                <Label className="text-[10px] text-muted-foreground">BBCode URL (for channel description)</Label>
                <div className="flex gap-1.5 mt-1">
                  <Input readOnly className="h-7 text-[11px] font-mono-data" value={widgetData.bbcodeUrl} />
                  <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
                    onClick={() => { navigator.clipboard.writeText(widgetData.bbcodeUrl); toast.success('Copied!'); }}
                  >Copy</Button>
                </div>
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground">JSON URL (for websites/integrations)</Label>
                <div className="flex gap-1.5 mt-1">
                  <Input readOnly className="h-7 text-[11px] font-mono-data" value={widgetData.jsonUrl} />
                  <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
                    onClick={() => { navigator.clipboard.writeText(widgetData.jsonUrl); toast.success('Copied!'); }}
                  >Copy</Button>
                </div>
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground">Token</Label>
                <Input readOnly className="h-7 text-[11px] font-mono-data mt-1" value={widgetData.token} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Play Song Dialog ─────────────────────────────────────────────────────────

function PlaySongDialog({ botId, onClose, onPlaySong, onPlayUrl, onEnqueue, onLoadPlaylist, mode = 'play' }: {
  botId: number | null;
  onClose: () => void;
  onPlaySong: (songId: number) => void;
  onPlayUrl: (url: string) => void;
  onEnqueue: (songId: number) => void;
  onLoadPlaylist: (playlistId: number) => void;
  /** play = Bots tab (play/queue/load); queue = Queue tab (enqueue / append only). */
  mode?: 'play' | 'queue';
}) {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<number | null>(selectedConfigId);
  const configId = serverId || selectedConfigId;
  const { data: songs } = useSongs(configId);
  const { data: playlists } = usePlaylists();
  const { data: history = [] } = useQuery({
    queryKey: ['music-requests', configId],
    queryFn: () => musicRequestsApi.list(configId!),
    enabled: !!configId && mode === 'play',
  });
  const [tab, setTab] = useState<'songs' | 'playlists' | 'history'>('songs');
  const [filter, setFilter] = useState('');

  const serverList = Array.isArray(servers) ? servers : [];
  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const playlistList = (Array.isArray(playlists) ? playlists : []) as PlaylistSummary[];
  const isQueueMode = mode === 'queue';

  const filtered = filter
    ? songList.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()) || (s.artist || '').toLowerCase().includes(filter.toLowerCase()))
    : songList;

  return (
    <Dialog open={botId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{isQueueMode ? 'Add to Queue' : 'Play Music'}</DialogTitle>
          <DialogDescription>
            {isQueueMode
              ? 'Select a song or playlist to append to this bot\'s queue.'
              : 'Select a song or playlist to play on this bot.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-2">
          <Button variant={tab === 'songs' ? 'default' : 'outline'} size="sm" className="h-7 text-xs"
            onClick={() => setTab('songs')}
          >
            <FileAudio className="h-3 w-3 mr-1" /> Songs
          </Button>
          <Button variant={tab === 'playlists' ? 'default' : 'outline'} size="sm" className="h-7 text-xs"
            onClick={() => setTab('playlists')}
          >
            <ListMusic className="h-3 w-3 mr-1" /> Playlists
          </Button>
          {!isQueueMode && (
            <Button variant={tab === 'history' ? 'default' : 'outline'} size="sm" className="h-7 text-xs"
              onClick={() => setTab('history')}
            >
              <Clock className="h-3 w-3 mr-1" /> History
            </Button>
          )}
          <div className="flex-1" />
          {tab === 'songs' && (
            <Select value={String(configId || '')} onValueChange={(v) => setServerId(parseInt(v))}>
              <SelectTrigger className="w-36 h-7 text-xs"><SelectValue placeholder="Server..." /></SelectTrigger>
              <SelectContent>
                {serverList.map((s: any) => (
                  <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {tab === 'songs' && (
          <>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter songs..."
              className="h-8 text-xs"
            />
            <div className="flex-1 max-h-[400px] mt-2 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">No songs found. Upload songs in the Library tab first.</p>
              ) : filtered.map((song) => (
                <div key={song.id} className="flex items-center gap-2 py-1.5 px-2 hover:bg-muted/30 transition-colors rounded group">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{song.title}</p>
                    {song.artist && <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>}
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{formatTime(song.duration)}</span>
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!isQueueMode && (
                      <Button variant="default" size="sm" className="h-6 text-[10px] px-2"
                        onClick={() => onPlaySong(song.id)}
                      >
                        <Play className="h-3 w-3 mr-0.5" /> Play
                      </Button>
                    )}
                    <Button variant={isQueueMode ? 'default' : 'outline'} size="sm" className="h-6 text-[10px] px-2"
                      onClick={() => onEnqueue(song.id)}
                    >
                      <Plus className="h-3 w-3 mr-0.5" /> Queue
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'playlists' && (
          <div className="flex-1 max-h-[400px] overflow-y-auto">
            {playlistList.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No playlists. Create one in the Playlists tab.</p>
            ) : playlistList.map((pl) => (
              <div key={pl.id} className="flex items-center gap-2 py-2 px-2 hover:bg-muted/30 transition-colors rounded group">
                <ListMusic className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">{pl.name}</p>
                  <p className="text-[10px] text-muted-foreground">{pl.songCount} song{pl.songCount !== 1 ? 's' : ''}</p>
                </div>
                <Button variant="default" size="sm" className="h-6 text-[10px] px-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => onLoadPlaylist(pl.id)}
                >
                  {isQueueMode ? (
                    <><Plus className="h-3 w-3 mr-0.5" /> Add to queue</>
                  ) : (
                    <><Play className="h-3 w-3 mr-0.5" /> Load & Play</>
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}

        {!isQueueMode && tab === 'history' && (
          <div className="flex-1 max-h-[400px] overflow-y-auto">
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No music requests found. Use !play in chat to build history.</p>
            ) : history.map((req: any) => (
              <div key={req.id} className="flex items-center gap-2 py-1.5 px-2 hover:bg-muted/30 transition-colors rounded group">
                <Music2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate" title={req.title}>{req.title}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="default" size="sm" className="h-6 text-[10px] px-2"
                    onClick={() => onPlayUrl(req.url)}
                  >
                    <Play className="h-3 w-3 mr-0.5" /> Play
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bots Tab ────────────────────────────────────────────────────────────────

function BotsTab() {
  const { data, isLoading } = useMusicBots();
  const { data: servers } = useServers();
  const { selectedConfigId } = useServerStore();
  const createBot = useCreateMusicBot();
  const updateBot = useUpdateMusicBot();
  const deleteBot = useDeleteMusicBot();
  const playSong = usePlaySong();
  const playUrl = usePlayUrl();
  const enqueueSong = useEnqueue();
  const loadPlaylist = useLoadPlaylist();

  const [showCreate, setShowCreate] = useState(false);
  const [editBot, setEditBot] = useState<MusicBotSummary | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showPlayDialog, setShowPlayDialog] = useState<number | null>(null);

  // Create form
  const [form, setForm] = useState({
    name: '', serverConfigId: '', nickname: 'MusicBot', serverPassword: '', defaultChannel: '', channelPassword: '', voicePort: 9987, volume: 50, autoStart: false,
  });

  const bots = Array.isArray(data) ? data : [];
  const serverList = Array.isArray(servers) ? servers : [];

  if (isLoading) return <PageLoader />;

  const handleCreate = () => {
    const configId = parseInt(form.serverConfigId);
    if (!configId) { toast.error('Please select a server'); return; }
    createBot.mutate({
      name: form.name,
      serverConfigId: configId,
      nickname: form.nickname || 'MusicBot',
      serverPassword: form.serverPassword || undefined,
      defaultChannel: form.defaultChannel || undefined,
      channelPassword: form.channelPassword || undefined,
      voicePort: form.voicePort,
      volume: form.volume,
      autoStart: form.autoStart,
    }, {
      onSuccess: () => { toast.success('Music bot created'); setShowCreate(false); resetForm(); },
      onError: () => toast.error('Failed to create bot'),
    });
  };

  const handleUpdate = () => {
    if (!editBot) return;
    updateBot.mutate({ id: editBot.id, data: {
      name: form.name,
      nickname: form.nickname,
      serverPassword: form.serverPassword || undefined,
      defaultChannel: form.defaultChannel || undefined,
      channelPassword: form.channelPassword || undefined,
      voicePort: form.voicePort,
      volume: form.volume,
      autoStart: form.autoStart,
    }}, {
      onSuccess: () => { toast.success('Bot updated'); setEditBot(null); },
      onError: () => toast.error('Failed to update bot'),
    });
  };

  const resetForm = () => setForm({ name: '', serverConfigId: '', nickname: 'MusicBot', serverPassword: '', defaultChannel: '', channelPassword: '', voicePort: 9987, volume: 50, autoStart: false });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{bots.length} music bot{bots.length !== 1 ? 's' : ''}</p>
        <Button size="sm" onClick={() => { resetForm(); setShowCreate(true); }}>
          <Plus className="h-4 w-4 mr-1" /> New Bot
        </Button>
      </div>

      {bots.length === 0 ? (
        <EmptyState icon={Music} title="No music bots yet" description="Create your first voice bot to play music on your TeamSpeak server." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {bots.map((bot: MusicBotSummary) => (
            <BotPlayerCard
              key={bot.id}
              bot={bot}
              onEdit={() => {
                setForm({
                  name: bot.name,
                  serverConfigId: String(bot.serverConfigId),
                  nickname: bot.nickname,
                  serverPassword: bot.serverPassword || '',
                  defaultChannel: bot.defaultChannel || '',
                  channelPassword: bot.channelPassword || '',
                  voicePort: bot.voicePort ?? 9987,
                  volume: bot.volume,
                  autoStart: bot.autoStart,
                });
                setEditBot(bot);
              }}
              onDelete={() => setDeleteId(bot.id)}
              onPlay={() => setShowPlayDialog(bot.id)}
            />
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={showCreate || editBot !== null} onOpenChange={(open) => { if (!open) { setShowCreate(false); setEditBot(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editBot ? 'Edit Music Bot' : 'New Music Bot'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My Music Bot" />
            </div>
            {!editBot && (
              <div>
                <Label className="text-xs">Server</Label>
                <Select value={form.serverConfigId} onValueChange={(v) => setForm({ ...form, serverConfigId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select server..." /></SelectTrigger>
                  <SelectContent>
                    {serverList.map((s: any) => (
                      <SelectItem key={s.id} value={String(s.id)}>{s.name} ({s.host})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label className="text-xs">Voice Port</Label>
              <Input type="number" value={form.voicePort} onChange={(e) => setForm({ ...form, voicePort: parseInt(e.target.value) || 9987 })} placeholder="9987" />
            </div>
            <div>
              <Label className="text-xs">Nickname</Label>
              <Input value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="MusicBot" />
            </div>
            <div>
              <Label className="text-xs">Server Password</Label>
              <Input type="password" value={form.serverPassword} onChange={(e) => setForm({ ...form, serverPassword: e.target.value })} placeholder="Leave empty if none" />
            </div>
            <div>
              <Label className="text-xs">Default Channel</Label>
              <Input value={form.defaultChannel} onChange={(e) => setForm({ ...form, defaultChannel: e.target.value })} placeholder="Channel name or ID (optional)" />
            </div>
            <div>
              <Label className="text-xs">Channel Password</Label>
              <Input type="password" value={form.channelPassword} onChange={(e) => setForm({ ...form, channelPassword: e.target.value })} placeholder="Leave empty if none" />
            </div>
            <div>
              <Label className="text-xs">Volume ({form.volume}%)</Label>
              <Slider value={[form.volume]} max={100} step={1} onValueChange={([v]) => setForm({ ...form, volume: v })} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.autoStart} onCheckedChange={(v) => setForm({ ...form, autoStart: v })} />
              <Label className="text-xs">Auto-start on server startup</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); setEditBot(null); }}>Cancel</Button>
            <Button onClick={editBot ? handleUpdate : handleCreate} disabled={!form.name || (!editBot && !form.serverConfigId) || createBot.isPending || updateBot.isPending}>
              {editBot ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Music Bot?"
        description="This will permanently delete this music bot and disconnect it from the server."
        onConfirm={() => {
          if (deleteId) deleteBot.mutate(deleteId, { onSuccess: () => { toast.success('Bot deleted'); setDeleteId(null); } });
        }}
        destructive
      />

      {/* Play Song Dialog */}
      <PlaySongDialog
        botId={showPlayDialog}
        onClose={() => setShowPlayDialog(null)}
        onPlaySong={(songId) => {
          if (showPlayDialog) {
            playSong.mutate({ botId: showPlayDialog, songId }, {
              onSuccess: () => { toast.success('Playing'); setShowPlayDialog(null); },
              onError: () => toast.error('Failed to play song'),
            });
          }
        }}
        onPlayUrl={(url) => {
          if (showPlayDialog) {
            playUrl.mutate({ botId: showPlayDialog, url }, {
              onSuccess: () => { toast.success('Playing URL'); setShowPlayDialog(null); },
              onError: () => toast.error('Failed to play URL'),
            });
          }
        }}
        onEnqueue={(songId) => {
          if (showPlayDialog) {
            enqueueSong.mutate({ botId: showPlayDialog, songId }, {
              onSuccess: () => toast.success('Added to queue'),
              onError: () => toast.error('Failed to enqueue'),
            });
          }
        }}
        onLoadPlaylist={(playlistId) => {
          if (showPlayDialog) {
            loadPlaylist.mutate({ botId: showPlayDialog, playlistId, clearFirst: true }, {
              onSuccess: () => { toast.success('Playlist loaded'); setShowPlayDialog(null); },
              onError: () => toast.error('Failed to load playlist'),
            });
          }
        }}
      />
    </div>
  );
}

// ─── Library Tab ─────────────────────────────────────────────────────────────

function LibraryTab() {
  const qc = useQueryClient();
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [libServerId, setLibServerId] = useState<number | null>(selectedConfigId);
  const configId = libServerId || selectedConfigId;

  const { data: songs, isLoading } = useSongs(configId);
  const uploadSong = useUploadSong();
  const scanLibrary = useScanLibrary();
  const deleteSong = useDeleteSong();
  const ytSearch = useYouTubeSearch();
  const ytDownload = useYouTubeDownload();

  const ytInfo = useYouTubeInfo();
  const ytBatchDownload = useYouTubeDownloadBatch();
  const ytImportPlaylist = useYouTubeImportPlaylist();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [ytResults, setYtResults] = useState<YouTubeSearchResult[]>([]);
  const [showYt, setShowYt] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [ytUrl, setYtUrl] = useState('');
  const [urlInfo, setUrlInfo] = useState<UrlLoadInfo | null>(null);
  const [selectedUrlIds, setSelectedUrlIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [importPlaylistName, setImportPlaylistName] = useState('');
  const { data: importJob } = useYouTubeImportStatus(configId, importJobId);

  const serverList = Array.isArray(servers) ? servers : [];
  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const filtered = filter
    ? songList.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()) || (s.artist || '').toLowerCase().includes(filter.toLowerCase()))
    : songList;

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !configId) return;
    Array.from(files).forEach((file) => {
      const formData = new FormData();
      formData.append('file', file);
      uploadSong.mutate({ configId, formData }, {
        onSuccess: () => toast.success(`Uploaded: ${file.name}`),
        onError: () => toast.error(`Failed to upload: ${file.name}`),
      });
    });
    e.target.value = '';
  };

  const handleYtSearch = () => {
    if (!searchQuery.trim() || !configId) return;
    ytSearch.mutate({ configId, query: searchQuery }, {
      onSuccess: (data: any) => {
        setYtResults(Array.isArray(data) ? data : data?.results || []);
        setShowYt(true);
      },
      onError: () => toast.error('YouTube search failed'),
    });
  };

  const handleYtDownload = (url: string) => {
    if (!configId) return;
    ytDownload.mutate({ configId, url }, {
      onSuccess: () => toast.success('Download started'),
      onError: () => toast.error('Download failed'),
    });
  };

  const sourceIcon = (source: string) => {
    switch (source) {
      case 'youtube': return <Youtube className="h-3 w-3" />;
      case 'url': return <Link className="h-3 w-3" />;
      default: return <FileAudio className="h-3 w-3" />;
    }
  };

  const handleLoadUrl = () => {
    if (!ytUrl.trim() || !configId) return;
    ytInfo.mutate({ configId, url: ytUrl }, {
      onSuccess: (data: UrlLoadInfo) => {
        setUrlInfo(data);
        if (data.type === 'playlist') {
          setSelectedUrlIds(allUrlItemKeys(data.items.length));
        }
      },
      onError: (err: unknown) => toast.error(youtubeInfoErrorMessage(err)),
    });
  };

  const handleBatchDownload = () => {
    if (!configId || !urlInfo) return;
    const selected = selectedUrlItems(urlInfo.items, selectedUrlIds);
    const urls = selected.map((item) => `https://youtube.com/watch?v=${item.id}`);
    setBatchProgress(`Downloading 0/${urls.length}...`);
    ytBatchDownload.mutate({ configId, urls }, {
      onSuccess: (data: any) => {
        setBatchProgress(null);
        toast.success(`Downloaded ${data.downloaded}/${data.total} songs`);
        if (data.errors?.length) toast.error(`${data.errors.length} failed`);
        setUrlInfo(null);
        setYtUrl('');
      },
      onError: () => { setBatchProgress(null); toast.error('Batch download failed'); },
    });
  };

  const toggleUrlSelect = (index: number) => {
    const key = urlItemSelectKey(index);
    setSelectedUrlIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleImportPlaylist = (reimport = false) => {
    if (!configId || !ytUrl.trim()) return;
    ytImportPlaylist.mutate({
      configId,
      url: ytUrl.trim(),
      playlistName: importPlaylistName.trim() || urlInfo?.title,
      reimport,
    }, {
      onSuccess: (data: any) => {
        setImportJobId(data.jobId);
        toast.success('Playlist import started');
      },
      onError: () => toast.error('Failed to start playlist import'),
    });
  };

  useEffect(() => {
    if (importJob?.status === 'completed') {
      toast.success(importJobCompleteMessage(importJob));
      qc.invalidateQueries({ queryKey: ['songs', configId] });
      qc.invalidateQueries({ queryKey: ['playlists'] });
      setImportJobId(null);
      setUrlInfo(null);
      setYtUrl('');
    } else if (importJob?.status === 'failed') {
      toast.error(importJob.errors[0] || 'Playlist import failed');
      setImportJobId(null);
    }
  }, [importJob?.status, configId, qc, importJob]);

  if (!configId) {
    return <EmptyState icon={Music} title="Select a server" description="Choose a server to manage its music library." />;
  }

  return (
    <div className="space-y-4">
      {/* Server selector + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(configId)} onValueChange={(v) => setLibServerId(parseInt(v))}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Server..." /></SelectTrigger>
          <SelectContent>
            {serverList.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter songs..."
          className="w-48"
        />
        <input ref={fileInputRef} type="file" accept="audio/*" multiple hidden onChange={handleUpload} />
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadSong.isPending}>
          <Upload className="h-4 w-4 mr-1" /> {uploadSong.isPending ? 'Uploading...' : 'Upload'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!configId || scanLibrary.isPending}
          onClick={() => {
            if (!configId) return;
            scanLibrary.mutate(configId, {
              onSuccess: (data: any) => {
                const imported = data?.imported ?? 0;
                const updated = data?.updated ?? 0;
                if (imported === 0 && updated === 0) {
                  toast.success('Scan complete — nothing new');
                } else {
                  const parts = [];
                  if (imported) parts.push(`imported ${imported}`);
                  if (updated) parts.push(`updated ${updated} YouTube file(s)`);
                  toast.success(`Scan complete — ${parts.join(', ')}`);
                }
              },
              onError: () => toast.error('Library scan failed'),
            });
          }}
        >
          <Search className="h-4 w-4 mr-1" /> {scanLibrary.isPending ? 'Scanning...' : 'Scan folder'}
        </Button>
      </div>

      {/* YouTube URL / Playlist Paste */}
      <Card className="border-dashed">
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Link className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLoadUrl()}
                placeholder="Paste YouTube, Apple Music, or Playlist URL..."
                className="pl-9"
              />
            </div>
            <Button variant="outline" size="sm" onClick={handleLoadUrl} disabled={ytInfo.isPending || !ytUrl.trim()}>
              {ytInfo.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Youtube className="h-4 w-4 mr-1" />}
              Load
            </Button>
            {ytInfo.isPending && (
              <span className="text-[10px] text-muted-foreground">Large Apple Music playlists can take 1–2 minutes</span>
            )}
            {ytUrl.trim() && !urlInfo && (
              <>
                <Input
                  className="h-8 w-40 text-xs"
                  placeholder="Playlist name (optional)"
                  value={importPlaylistName}
                  onChange={(e) => setImportPlaylistName(e.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleImportPlaylist(false)}
                  disabled={ytImportPlaylist.isPending || !!importJobId}
                >
                  {importJobId ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      {importJobProgressLabel(importJob)}
                    </>
                  ) : (
                    <>
                      <ListMusic className="h-3 w-3 mr-1" /> Import as Playlist
                    </>
                  )}
                </Button>
              </>
            )}
            {urlInfo && (
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setUrlInfo(null); setYtUrl(''); }}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* URL Info Results */}
          {urlInfo && (
            <div className="space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <Badge variant="secondary" className="text-xs">
                  {urlInfoPlaylistLabel(urlInfo)}
                </Badge>
                {urlInfo.type === 'playlist' && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]"
                      onClick={() => setSelectedUrlIds(allUrlItemKeys(urlInfo.items.length))}
                    >
                      Select All
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]"
                      onClick={() => setSelectedUrlIds(new Set())}
                    >
                      Deselect All
                    </Button>
                    <Button variant="default" size="sm" className="h-7 text-xs"
                      onClick={handleBatchDownload}
                      disabled={selectedUrlIds.size === 0 || ytBatchDownload.isPending}
                    >
                      {ytBatchDownload.isPending ? (
                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> {batchProgress || 'Downloading...'}</>
                      ) : (
                        <><Download className="h-3 w-3 mr-1" /> Download {selectedUrlIds.size} Selected</>
                      )}
                    </Button>
                    <Input
                      className="h-7 w-40 text-xs"
                      placeholder="Playlist name (optional)"
                      value={importPlaylistName}
                      onChange={(e) => setImportPlaylistName(e.target.value)}
                    />
                    <Button variant="secondary" size="sm" className="h-7 text-xs"
                      onClick={() => handleImportPlaylist(false)}
                      disabled={ytImportPlaylist.isPending || !!importJobId}
                    >
                      {importJobId ? (
                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> {importJobProgressLabel(importJob)}</>
                      ) : (
                        <><ListMusic className="h-3 w-3 mr-1" /> Import as Playlist</>
                      )}
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs"
                      onClick={() => handleImportPlaylist(true)}
                      disabled={ytImportPlaylist.isPending || !!importJobId}
                      title="Re-import adds missing tracks and re-links existing downloads"
                    >
                      Re-import
                    </Button>
                  </div>
                )}
              </div>
              <ScrollArea className="max-h-60">
                {urlInfo.items.map((item, index) => (
                  <div
                    key={`${item.id}-${index}`}
                    className={`flex items-center gap-3 px-2 py-1.5 rounded transition-colors ${
                      urlInfo.type === 'playlist'
                        ? `cursor-pointer ${selectedUrlIds.has(urlItemSelectKey(index)) ? 'bg-primary/10' : 'hover:bg-muted/50'}`
                        : 'hover:bg-muted/50'
                    }`}
                    onClick={() => urlInfo.type === 'playlist' && toggleUrlSelect(index)}
                  >
                    {urlInfo.type === 'playlist' && (
                      <input
                        type="checkbox"
                        checked={selectedUrlIds.has(urlItemSelectKey(index))}
                        onChange={() => toggleUrlSelect(index)}
                        className="shrink-0 accent-primary"
                      />
                    )}
                    {item.thumbnail && (
                      <img src={item.thumbnail} alt="" className="h-8 w-12 rounded object-cover shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{item.title}</p>
                      <p className="text-[10px] text-muted-foreground">{item.artist} - {formatTime(item.duration)}</p>
                    </div>
                    {urlInfo.type === 'video' && (
                      <Button variant="default" size="sm" className="h-7 text-xs shrink-0"
                        onClick={(e) => { e.stopPropagation(); handleYtDownload(`https://youtube.com/watch?v=${item.id}`); }}
                        disabled={ytDownload.isPending}
                      >
                        <Download className="h-3 w-3 mr-1" /> Download
                      </Button>
                    )}
                  </div>
                ))}
              </ScrollArea>
            </div>
          )}
        </CardContent>
      </Card>

      {/* YouTube Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleYtSearch()}
            placeholder="Search YouTube..."
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={handleYtSearch} disabled={ytSearch.isPending || !searchQuery.trim()}>
          {ytSearch.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Youtube className="h-4 w-4 mr-1" />}
          Search
        </Button>
      </div>

      {/* YouTube Results */}
      {showYt && ytResults.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs">YouTube Results ({ytResults.length})</CardTitle>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowYt(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-60 overflow-y-auto">
              {ytResults.map((r) => (
                <div key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 transition-colors">
                  {r.thumbnail && (
                    <img src={r.thumbnail} alt="" className="h-10 w-14 rounded object-cover shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{r.title}</p>
                    <p className="text-[10px] text-muted-foreground">{r.artist} - {formatTime(r.duration)}</p>
                  </div>
                  <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
                    onClick={() => handleYtDownload(`https://youtube.com/watch?v=${r.id}`)}
                    disabled={ytDownload.isPending}
                  >
                    <Download className="h-3 w-3 mr-1" /> Download
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Song List */}
      {isLoading ? <PageLoader /> : filtered.length === 0 ? (
        <EmptyState icon={Music} title="No songs yet" description="Upload audio files or download from YouTube to build your library." />
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] gap-2 px-3 py-2 bg-muted/50 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            <span>Title</span>
            <span className="w-20 text-right">Duration</span>
            <span className="w-16 text-center">Source</span>
            <span className="w-16 text-right">Size</span>
            <span className="w-16" />
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {filtered.map((song) => (
              <div key={song.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] gap-2 px-3 py-2 hover:bg-muted/30 transition-colors items-center border-t border-border/50">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{song.title}</p>
                  {song.artist && <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>}
                </div>
                <span className="text-xs text-muted-foreground w-20 text-right">{formatTime(song.duration)}</span>
                <span className="w-16 flex justify-center">
                  <Badge variant="outline" className="text-[9px] gap-1">{sourceIcon(song.source)} {song.source}</Badge>
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">{song.fileSize ? formatBytes(song.fileSize) : '-'}</span>
                <div className="w-16 flex justify-end">
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(song.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Song?"
        description="This will permanently remove this song from the library."
        onConfirm={() => {
          if (deleteId && configId) deleteSong.mutate({ configId, songId: deleteId }, {
            onSuccess: () => { toast.success('Song deleted'); setDeleteId(null); },
          });
        }}
        destructive
      />
    </div>
  );
}

// ─── Playlists Tab ───────────────────────────────────────────────────────────

function PlaylistsTab() {
  const qc = useQueryClient();
  const { selectedConfigId } = useServerStore();
  const { data, isLoading } = usePlaylists();
  const createPlaylist = useCreatePlaylist();
  const updatePlaylist = useUpdatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const addSong = useAddSongToPlaylist();
  const addFromPlaylist = useAddPlaylistToPlaylist();
  const removeSong = useRemoveSongFromPlaylist();
  const ytInfo = useYouTubeInfo();
  const ytDownload = useYouTubeDownload();
  const ytBatchDownload = useYouTubeDownloadBatch();
  const ytRegister = useYouTubeRegister();
  const ytImportPlaylist = useYouTubeImportPlaylist();

  const { data: songs } = useSongs(selectedConfigId);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<PlaylistMode>('local');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showAddSong, setShowAddSong] = useState(false);
  const [addTab, setAddTab] = useState<'songs' | 'playlists' | 'url'>('songs');
  const [songFilter, setSongFilter] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editMode, setEditMode] = useState<PlaylistMode>('local');
  const [addYtUrl, setAddYtUrl] = useState('');
  const [addUrlInfo, setAddUrlInfo] = useState<UrlLoadInfo | null>(null);
  const [addSelectedUrlIds, setAddSelectedUrlIds] = useState<Set<string>>(new Set());
  const [addBatchProgress, setAddBatchProgress] = useState<string | null>(null);
  const [addImportJobId, setAddImportJobId] = useState<string | null>(null);

  const { data: detail } = usePlaylist(selectedId) as { data: PlaylistDetail | undefined };
  const { data: addImportJob } = useYouTubeImportStatus(selectedConfigId, addImportJobId);

  const playlists = (Array.isArray(data) ? data : []) as PlaylistSummary[];
  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const playlistMode: PlaylistMode = detail?.mode === 'stream' ? 'stream' : 'local';
  const playlistSongIds = new Set((detail?.songs || []).map((s: any) => s.id));
  const isYtLinked = !!detail?.youtubePlaylistId;

  const songMatchesMode = (source: string) =>
    playlistMode === 'local' ? source === 'local' : source === 'youtube' || source === 'url';

  const availableSongs = songList.filter(
    (s) =>
      !playlistSongIds.has(s.id) &&
      songMatchesMode(s.source) &&
      (!songFilter ||
        s.title.toLowerCase().includes(songFilter.toLowerCase()) ||
        (s.artist || '').toLowerCase().includes(songFilter.toLowerCase())),
  );

  const otherPlaylists = playlists.filter((pl) => pl.id !== selectedId);

  const resetAddUrlState = () => {
    setAddYtUrl('');
    setAddUrlInfo(null);
    setAddSelectedUrlIds(new Set());
    setAddBatchProgress(null);
    setAddImportJobId(null);
  };

  const handleCreate = () => {
    createPlaylist.mutate(
      { name: newName, mode: newMode },
      {
        onSuccess: () => {
          toast.success('Playlist created');
          setShowCreate(false);
          setNewName('');
          setNewMode('local');
        },
        onError: () => toast.error('Failed to create playlist'),
      },
    );
  };

  const openEdit = () => {
    if (!detail) return;
    setEditName(detail.name);
    setEditMode(detail.mode === 'stream' ? 'stream' : 'local');
    setShowEdit(true);
  };

  const handleEditSave = () => {
    if (!selectedId || !editName.trim()) return;
    const modeChanging = editMode !== playlistMode && !isYtLinked;
    updatePlaylist.mutate(
      {
        id: selectedId,
        data: {
          name: editName.trim(),
          ...(isYtLinked ? {} : { mode: editMode }),
        },
      },
      {
        onSuccess: () => {
          toast.success('Playlist updated');
          if (modeChanging && (detail?.songs?.length ?? 0) > 0) {
            toast.message('Mode changed — remove songs that no longer match the new mode if needed');
          }
          setShowEdit(false);
        },
        onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to update playlist'),
      },
    );
  };

  const handleAddLoadUrl = () => {
    if (!addYtUrl.trim() || !selectedConfigId) return;
    ytInfo.mutate(
      { configId: selectedConfigId, url: addYtUrl.trim() },
      {
        onSuccess: (data: UrlLoadInfo) => {
          setAddUrlInfo(data);
          if (data.type === 'playlist') {
            setAddSelectedUrlIds(allUrlItemKeys(data.items.length));
          }
        },
        onError: (err: unknown) => toast.error(youtubeInfoErrorMessage(err)),
      },
    );
  };

  const toggleAddUrlSelect = (index: number) => {
    const key = urlItemSelectKey(index);
    setAddSelectedUrlIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAddSingleDownload = (item: { id: string; title?: string; artist?: string; duration?: number }) => {
    if (!selectedConfigId || !selectedId) return;
    const url = `https://youtube.com/watch?v=${item.id}`;

    // Stream playlists: register URL only (download on play). Local: download now.
    if (playlistMode === 'stream') {
      ytRegister.mutate(
        {
          configId: selectedConfigId,
          items: [{ url, title: item.title, artist: item.artist, duration: item.duration }],
        },
        {
          onSuccess: async (data: any) => {
            const song = Array.isArray(data?.results) ? data.results[0] : null;
            if (!song?.id) {
              toast.error('Failed to register track');
              return;
            }
            addSong.mutate(
              { playlistId: selectedId, songId: song.id },
              {
                onSuccess: () => toast.success('Added to stream playlist (on-demand)'),
                onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to add song'),
              },
            );
            setAddUrlInfo(null);
            setAddYtUrl('');
          },
          onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to register track'),
        },
      );
      return;
    }

    ytDownload.mutate(
      { configId: selectedConfigId, url },
      {
        onSuccess: (song: any) => {
          addSong.mutate(
            { playlistId: selectedId, songId: song.id },
            {
              onSuccess: () => toast.success('Added to playlist'),
              onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to add song'),
            },
          );
          setAddUrlInfo(null);
          setAddYtUrl('');
        },
        onError: () => toast.error('Download failed'),
      },
    );
  };

  const handleAddBatchDownload = () => {
    if (!selectedConfigId || !selectedId || !addUrlInfo) return;
    const selectedItems = selectedUrlItems(addUrlInfo.items, addSelectedUrlIds);
    if (selectedItems.length === 0) return;

    if (playlistMode === 'stream') {
      setAddBatchProgress(`Registering 0/${selectedItems.length}...`);
      ytRegister.mutate(
        {
          configId: selectedConfigId,
          items: selectedItems.map((i) => ({
            url: `https://youtube.com/watch?v=${i.id}`,
            title: i.title,
            artist: i.artist,
            duration: i.duration,
          })),
        },
        {
          onSuccess: async (data: any) => {
            setAddBatchProgress(null);
            const results = Array.isArray(data?.results) ? data.results : [];
            let added = 0;
            for (const song of results) {
              if (!song?.id || playlistSongIds.has(song.id)) continue;
              try {
                await addSong.mutateAsync({ playlistId: selectedId, songId: song.id });
                added++;
              } catch {
                /* skip */
              }
            }
            toast.success(
              added > 0
                ? `Added ${added} stream track${added === 1 ? '' : 's'} (download on play)`
                : 'Nothing new to add',
            );
            if (data.errors?.length) toast.error(`${data.errors.length} failed`);
            resetAddUrlState();
          },
          onError: (err: any) => {
            setAddBatchProgress(null);
            toast.error(err?.response?.data?.error || 'Failed to register tracks');
          },
        },
      );
      return;
    }

    const urls = selectedItems.map((i: any) => `https://youtube.com/watch?v=${i.id}`);
    setAddBatchProgress(`Downloading 0/${urls.length}...`);
    ytBatchDownload.mutate(
      { configId: selectedConfigId, urls },
      {
        onSuccess: async (data: any) => {
          setAddBatchProgress(null);
          const results = Array.isArray(data?.results) ? data.results : [];
          let added = 0;
          for (const song of results) {
            if (!song?.id || playlistSongIds.has(song.id)) continue;
            try {
              await addSong.mutateAsync({ playlistId: selectedId, songId: song.id });
              added++;
            } catch {
              // skip duplicates / mode mismatches
            }
          }
          toast.success(
            added > 0
              ? `Added ${added} song${added === 1 ? '' : 's'} from URL`
              : `Downloaded ${data.downloaded ?? 0}/${data.total ?? 0} — nothing new to add`,
          );
          if (data.errors?.length) toast.error(`${data.errors.length} failed`);
          resetAddUrlState();
        },
        onError: () => {
          setAddBatchProgress(null);
          toast.error('Batch download failed');
        },
      },
    );
  };

  const handleAddImportPlaylist = (reimport = false) => {
    if (!selectedConfigId || !selectedId || !addYtUrl.trim()) return;
    ytImportPlaylist.mutate(
      {
        configId: selectedConfigId,
        url: addYtUrl.trim(),
        playlistId: selectedId,
        reimport,
      },
      {
        onSuccess: (data: any) => {
          setAddImportJobId(data.jobId);
          toast.success('Playlist import started');
        },
        onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to start playlist import'),
      },
    );
  };

  useEffect(() => {
    if (addImportJob?.status === 'completed') {
      toast.success(importJobCompleteMessage(addImportJob));
      qc.invalidateQueries({ queryKey: ['songs', selectedConfigId] });
      qc.invalidateQueries({ queryKey: ['playlist', selectedId] });
      qc.invalidateQueries({ queryKey: ['playlists'] });
      resetAddUrlState();
    } else if (addImportJob?.status === 'failed') {
      toast.error(addImportJob.errors?.[0] || 'Playlist import failed');
      setAddImportJobId(null);
    }
  }, [addImportJob?.status, selectedConfigId, selectedId, qc, addImportJob]);

  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {playlists.length} playlist{playlists.length !== 1 ? 's' : ''}
        </p>
        <Button
          size="sm"
          onClick={() => {
            setNewName('');
            setNewMode('local');
            setShowCreate(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" /> New Playlist
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        <div className="space-y-1.5">
          {playlists.length === 0 ? (
            <EmptyState
              icon={ListMusic}
              title="No playlists"
              description="Create a local or stream playlist to organize your songs."
            />
          ) : (
            playlists.map((pl) => (
              <div
                key={pl.id}
                className={`flex items-center gap-2 p-2.5 rounded-md cursor-pointer transition-colors ${
                  selectedId === pl.id
                    ? 'bg-primary/10 border border-primary/30'
                    : 'hover:bg-muted/50 border border-transparent'
                }`}
                onClick={() => setSelectedId(pl.id)}
              >
                <ListMusic
                  className={`h-4 w-4 shrink-0 ${selectedId === pl.id ? 'text-primary' : 'text-muted-foreground'}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{pl.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Badge variant="outline" className="text-[9px] h-4 px-1">
                      {pl.mode === 'stream' ? 'stream' : 'local'}
                    </Badge>
                    <p className="text-[10px] text-muted-foreground">
                      {pl.songCount} song{pl.songCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteId(pl.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </div>

        {selectedId && detail ? (
          <Card>
            <CardHeader className="py-3 px-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="text-sm truncate">{detail.name}</CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {playlistMode === 'local'
                      ? 'Local only — library uploads / scanned local files'
                      : 'Stream only — YouTube / URL tracks'}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openEdit}>
                    <Pencil className="h-3 w-3 mr-1" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setAddTab(playlistMode === 'stream' ? 'url' : 'songs');
                      setSongFilter('');
                      resetAddUrlState();
                      setShowAddSong(true);
                    }}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Add Songs
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {detail.songs.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  No songs in this playlist
                </div>
              ) : (
                <div className="max-h-[400px] overflow-y-auto">
                  {detail.songs.map((song: any, i: number) => (
                    <div
                      key={song.id}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/30 transition-colors border-t border-border/50"
                    >
                      <span className="text-[10px] text-muted-foreground w-5 text-right">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">{song.title}</p>
                        {song.artist && (
                          <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
                        {song.source}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{formatTime(song.duration)}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={() =>
                          removeSong.mutate(
                            { playlistId: selectedId, songId: song.id },
                            { onSuccess: () => toast.success('Song removed') },
                          )
                        }
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="flex items-center justify-center text-xs text-muted-foreground py-16">
            Select a playlist to view its songs
          </div>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Playlist</DialogTitle>
            <DialogDescription>
              Local playlists hold uploaded/scanned files. Stream playlists hold YouTube / URL tracks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My Playlist"
                onKeyDown={(e) => e.key === 'Enter' && newName && handleCreate()}
              />
            </div>
            <div>
              <Label className="text-xs">Mode</Label>
              <Select value={newMode} onValueChange={(v) => setNewMode(v as PlaylistMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local only</SelectItem>
                  <SelectItem value="stream">Stream only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!newName || createPlaylist.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Playlist</DialogTitle>
            <DialogDescription>
              Rename this playlist or change whether it holds local or stream tracks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="My Playlist"
                onKeyDown={(e) => e.key === 'Enter' && editName.trim() && handleEditSave()}
              />
            </div>
            <div>
              <Label className="text-xs">Mode</Label>
              <Select
                value={editMode}
                onValueChange={(v) => setEditMode(v as PlaylistMode)}
                disabled={isYtLinked}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local only</SelectItem>
                  <SelectItem value="stream">Stream only</SelectItem>
                </SelectContent>
              </Select>
              {isYtLinked && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  YouTube-imported playlists stay in stream mode.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEdit(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleEditSave}
              disabled={!editName.trim() || updatePlaylist.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showAddSong}
        onOpenChange={(open) => {
          setShowAddSong(open);
          if (!open) {
            setSongFilter('');
            setAddTab('songs');
            resetAddUrlState();
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add to {detail?.name || 'playlist'}</DialogTitle>
            <DialogDescription>
              {playlistMode === 'local'
                ? 'Add local library songs, or copy matching songs from another playlist.'
                : 'Add via URL (saved for on-demand play — no download until played), pick stream library tracks, or copy from another playlist.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant={addTab === 'songs' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setAddTab('songs')}
            >
              <FileAudio className="h-3 w-3 mr-1" /> Songs
            </Button>
            <Button
              variant={addTab === 'playlists' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setAddTab('playlists')}
            >
              <ListMusic className="h-3 w-3 mr-1" /> From playlist
            </Button>
            {playlistMode === 'stream' && (
              <Button
                variant={addTab === 'url' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setAddTab('url')}
              >
                <Link className="h-3 w-3 mr-1" /> URL
              </Button>
            )}
          </div>

          {addTab === 'songs' ? (
            <>
              <Input
                value={songFilter}
                onChange={(e) => setSongFilter(e.target.value)}
                placeholder="Filter songs..."
              />
              <ScrollArea className="max-h-72">
                {availableSongs.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-8">
                    No matching {playlistMode === 'local' ? 'local' : 'stream'} songs available.
                  </p>
                ) : (
                  availableSongs.map((song) => (
                    <div
                      key={song.id}
                      className="flex items-center gap-2 py-1.5 hover:bg-muted/30 transition-colors rounded px-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs truncate">{song.title}</p>
                        {song.artist && (
                          <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
                        {song.source}
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px] shrink-0"
                        onClick={() => {
                          if (selectedId)
                            addSong.mutate(
                              { playlistId: selectedId, songId: song.id },
                              {
                                onSuccess: () => toast.success('Song added'),
                                onError: (err: any) =>
                                  toast.error(err?.response?.data?.error || 'Failed to add song'),
                              },
                            );
                        }}
                      >
                        <Plus className="h-3 w-3 mr-0.5" /> Add
                      </Button>
                    </div>
                  ))
                )}
              </ScrollArea>
            </>
          ) : addTab === 'playlists' ? (
            <ScrollArea className="max-h-72">
              {otherPlaylists.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  No other playlists to import from.
                </p>
              ) : (
                otherPlaylists.map((pl) => (
                  <div
                    key={pl.id}
                    className="flex items-center gap-2 py-1.5 hover:bg-muted/30 transition-colors rounded px-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{pl.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {pl.songCount} song{pl.songCount !== 1 ? 's' : ''} · {pl.mode === 'stream' ? 'stream' : 'local'}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] shrink-0"
                      disabled={addFromPlaylist.isPending}
                      onClick={() => {
                        if (!selectedId) return;
                        addFromPlaylist.mutate(
                          { playlistId: selectedId, sourcePlaylistId: pl.id },
                          {
                            onSuccess: (res: any) => {
                              const added = res?.added ?? 0;
                              toast.success(
                                added > 0
                                  ? `Added ${added} song${added === 1 ? '' : 's'} from “${pl.name}”`
                                  : 'No new matching songs to add',
                              );
                            },
                            onError: (err: any) =>
                              toast.error(err?.response?.data?.error || 'Failed to import playlist'),
                          },
                        );
                      }}
                    >
                      <Plus className="h-3 w-3 mr-0.5" /> Add all matching
                    </Button>
                  </div>
                ))
              )}
            </ScrollArea>
          ) : (
            <div className="space-y-3">
              {!selectedConfigId ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  Select a server in the sidebar to import from YouTube.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Link className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        value={addYtUrl}
                        onChange={(e) => setAddYtUrl(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddLoadUrl()}
                        placeholder="Paste YouTube, Apple Music, or Playlist URL..."
                        className="pl-9"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAddLoadUrl}
                      disabled={ytInfo.isPending || !addYtUrl.trim()}
                    >
                      {ytInfo.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Youtube className="h-4 w-4 mr-1" />
                      )}
                      Load
                    </Button>
                    {ytInfo.isPending && (
                      <span className="text-[10px] text-muted-foreground">
                        Large Apple Music playlists can take 1–2 minutes
                      </span>
                    )}
                    {addYtUrl.trim() && !addUrlInfo && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleAddImportPlaylist(false)}
                        disabled={ytImportPlaylist.isPending || !!addImportJobId || !selectedId}
                      >
                        {addImportJobId ? (
                          <>
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            {importJobProgressLabel(addImportJob)}
                          </>
                        ) : (
                          <>
                            <ListMusic className="h-3 w-3 mr-1" /> Import all
                          </>
                        )}
                      </Button>
                    )}
                  </div>

                  {addUrlInfo && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <Badge variant="secondary" className="text-xs">
                          {urlInfoPlaylistLabel(addUrlInfo)}
                        </Badge>
                        {addUrlInfo.type === 'playlist' && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-[10px]"
                              onClick={() =>
                                setAddSelectedUrlIds(allUrlItemKeys(addUrlInfo.items.length))
                              }
                            >
                              Select All
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-[10px]"
                              onClick={() => setAddSelectedUrlIds(new Set())}
                            >
                              Deselect All
                            </Button>
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={handleAddBatchDownload}
                              disabled={
                                addSelectedUrlIds.size === 0 ||
                                ytBatchDownload.isPending ||
                                ytRegister.isPending
                              }
                            >
                              {ytBatchDownload.isPending || ytRegister.isPending ? (
                                <>
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />{' '}
                                  {addBatchProgress || (playlistMode === 'stream' ? 'Adding...' : 'Downloading...')}
                                </>
                              ) : (
                                <>
                                  <Plus className="h-3 w-3 mr-1" /> Add {addSelectedUrlIds.size}{' '}
                                  Selected
                                </>
                              )}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => handleAddImportPlaylist(false)}
                              disabled={ytImportPlaylist.isPending || !!addImportJobId}
                            >
                              {addImportJobId ? (
                                <>
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                  {importJobProgressLabel(addImportJob)}
                                </>
                              ) : (
                                <>
                                  <ListMusic className="h-3 w-3 mr-1" /> Import all
                                </>
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                      <ScrollArea className="max-h-60">
                        {addUrlInfo.items.map((item, index) => (
                          <div
                            key={`${item.id}-${index}`}
                            className={`flex items-center gap-3 px-2 py-1.5 rounded transition-colors ${
                              addUrlInfo.type === 'playlist'
                                ? `cursor-pointer ${addSelectedUrlIds.has(urlItemSelectKey(index)) ? 'bg-primary/10' : 'hover:bg-muted/50'}`
                                : 'hover:bg-muted/50'
                            }`}
                            onClick={() =>
                              addUrlInfo.type === 'playlist' && toggleAddUrlSelect(index)
                            }
                          >
                            {addUrlInfo.type === 'playlist' && (
                              <input
                                type="checkbox"
                                checked={addSelectedUrlIds.has(urlItemSelectKey(index))}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => toggleAddUrlSelect(index)}
                                className="shrink-0 accent-primary"
                              />
                            )}
                            {item.thumbnail && (
                              <img
                                src={item.thumbnail}
                                alt=""
                                className="h-8 w-12 rounded object-cover shrink-0"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium truncate">{item.title}</p>
                              <p className="text-[10px] text-muted-foreground">
                                {item.artist} - {formatTime(item.duration)}
                              </p>
                            </div>
                            {addUrlInfo.type === 'video' && (
                              <Button
                                variant="default"
                                size="sm"
                                className="h-7 text-xs shrink-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleAddSingleDownload(item);
                                }}
                                disabled={ytDownload.isPending || ytRegister.isPending}
                              >
                                {ytDownload.isPending || ytRegister.isPending ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <>
                                    <Plus className="h-3 w-3 mr-1" /> Add
                                  </>
                                )}
                              </Button>
                            )}
                          </div>
                        ))}
                      </ScrollArea>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowAddSong(false);
                setSongFilter('');
                resetAddUrlState();
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Playlist?"
        description="This will permanently delete this playlist."
        onConfirm={() => {
          if (deleteId)
            deletePlaylist.mutate(deleteId, {
              onSuccess: () => {
                toast.success('Playlist deleted');
                if (selectedId === deleteId) setSelectedId(null);
                setDeleteId(null);
              },
            });
        }}
        destructive
      />
    </div>
  );
}

// ─── Commands Tab ────────────────────────────────────────────────────────────

function CommandsTab() {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<number | null>(selectedConfigId);
  const configId = serverId || selectedConfigId;

  const { data: commands, isLoading } = useChatCommands(configId);
  const createCommand = useCreateChatCommand();
  const updateCommand = useUpdateChatCommand();
  const deleteCommand = useDeleteChatCommand();

  const [showAdd, setShowAdd] = useState(false);
  const [editCmd, setEditCmd] = useState<ChatCommandInfo | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', response: '', description: '', enabled: true });

  const serverList = Array.isArray(servers) ? servers : [];
  const commandList = (Array.isArray(commands) ? commands : []) as ChatCommandInfo[];

  const resetForm = () => setForm({ name: '', response: '', description: '', enabled: true });

  const openEdit = (cmd: ChatCommandInfo) => {
    setEditCmd(cmd);
    setForm({
      name: cmd.name,
      response: cmd.response,
      description: cmd.description || '',
      enabled: cmd.enabled,
    });
  };

  const handleCreate = () => {
    if (!configId || !form.name.trim() || !form.response.trim()) {
      toast.error('Name and response are required');
      return;
    }
    createCommand.mutate(
      {
        configId,
        data: {
          name: form.name,
          response: form.response,
          description: form.description || undefined,
          enabled: form.enabled,
        },
      },
      {
        onSuccess: () => {
          toast.success('Command added');
          setShowAdd(false);
          resetForm();
        },
        onError: (err: any) =>
          toast.error(err?.response?.data?.error || 'Failed to add command'),
      },
    );
  };

  const handleUpdate = () => {
    if (!configId || !editCmd) return;
    updateCommand.mutate(
      {
        configId,
        id: editCmd.id,
        data: {
          name: form.name,
          response: form.response,
          description: form.description || null,
          enabled: form.enabled,
        },
      },
      {
        onSuccess: () => {
          toast.success('Command updated');
          setEditCmd(null);
          resetForm();
        },
        onError: (err: any) =>
          toast.error(err?.response?.data?.error || 'Failed to update command'),
      },
    );
  };

  if (!configId) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="Select a server"
        description="Choose a server to manage custom chat commands."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(configId)} onValueChange={(v) => setServerId(parseInt(v))}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Server..." />
          </SelectTrigger>
          <SelectContent>
            {serverList.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button
          size="sm"
          onClick={() => {
            resetForm();
            setShowAdd(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" /> Add command
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Users type <code className="text-[11px]">!help</code> in the music bot&apos;s channel chat for built-in
        commands. Custom commands below reply with your text in the same channel chat. Names cannot override
        built-ins like <code className="text-[11px]">play</code> or <code className="text-[11px]">help</code>.
      </p>

      {isLoading ? (
        <PageLoader />
      ) : commandList.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No custom commands"
          description="Add a command like !rules that replies with fixed text in chat."
        />
      ) : (
        <div className="space-y-1">
          {commandList.map((cmd) => (
            <div
              key={cmd.id}
              className="flex items-start gap-2 py-2 px-2 hover:bg-muted/30 transition-colors rounded group"
            >
              <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">!{cmd.name}</p>
                  {!cmd.enabled && (
                    <Badge variant="secondary" className="text-[10px]">
                      Disabled
                    </Badge>
                  )}
                </div>
                {cmd.description && (
                  <p className="text-[11px] text-muted-foreground truncate">{cmd.description}</p>
                )}
                <p className="text-[11px] text-muted-foreground/80 line-clamp-2 mt-0.5">{cmd.response}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(cmd)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  onClick={() => setDeleteId(cmd.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={showAdd}
        onOpenChange={(open) => {
          if (!open) {
            setShowAdd(false);
            resetForm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add chat command</DialogTitle>
            <DialogDescription>
              When someone types !name in the music bot channel, the bot replies with your response.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Command name</Label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">!</span>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="rules"
                  className="flex-1"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Help blurb (optional)</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Shown next to the command in !help"
              />
            </div>
            <div>
              <Label className="text-xs">Response</Label>
              <Textarea
                value={form.response}
                onChange={(e) => setForm({ ...form, response: e.target.value })}
                placeholder="Text the bot will send…"
                rows={4}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
              />
              <Label className="text-xs">Enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createCommand.isPending}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editCmd !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditCmd(null);
            resetForm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit !{editCmd?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Command name</Label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">!</span>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="flex-1"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Help blurb (optional)</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs">Response</Label>
              <Textarea
                value={form.response}
                onChange={(e) => setForm({ ...form, response: e.target.value })}
                rows={4}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
              />
              <Label className="text-xs">Enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditCmd(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={updateCommand.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete command?"
        description="Users will no longer be able to trigger this chat command."
        onConfirm={() => {
          if (!configId || deleteId === null) return;
          deleteCommand.mutate(
            { configId, id: deleteId },
            {
              onSuccess: () => {
                toast.success('Command deleted');
                setDeleteId(null);
              },
              onError: () => toast.error('Failed to delete command'),
            },
          );
        }}
        destructive
      />
    </div>
  );
}

// ─── Radio Tab ───────────────────────────────────────────────────────────────

function RadioTab() {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<number | null>(selectedConfigId);
  const configId = serverId || selectedConfigId;

  const { data: stations, isLoading } = useRadioStations(configId);
  const { data: presets } = useRadioPresets(configId);
  const createStation = useCreateRadioStation();
  const deleteStation = useDeleteRadioStation();
  const resetStationIds = useResetRadioStationIds();
  const playRadio = usePlayRadio();

  const { data: bots } = useMusicBots();
  const runningBots = (Array.isArray(bots) ? bots : []).filter(
    (b: MusicBotSummary) => b.status !== 'stopped' && b.status !== 'error'
  );

  const [selectedBotId, setSelectedBotId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', url: '', genre: '' });
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const serverList = Array.isArray(servers) ? servers : [];
  const stationList = (Array.isArray(stations) ? stations : []) as RadioStationInfo[];
  const presetList = (Array.isArray(presets) ? presets : []) as RadioPreset[];

  // Auto-select first running bot
  useEffect(() => {
    if (!selectedBotId && runningBots.length > 0) {
      setSelectedBotId(runningBots[0].id);
    }
  }, [runningBots, selectedBotId]);

  const handleAddStation = () => {
    if (!configId || !addForm.name || !addForm.url) return;
    createStation.mutate({
      configId,
      data: { name: addForm.name, url: addForm.url, genre: addForm.genre || undefined },
    }, {
      onSuccess: () => { toast.success('Station added'); setShowAdd(false); setAddForm({ name: '', url: '', genre: '' }); },
      onError: () => toast.error('Failed to add station'),
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
      onSuccess: () => toast.success('Playing radio'),
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
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add Station
        </Button>
      </div>

      {runningBots.length === 0 && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3">
          <p className="text-xs text-amber-500">Start a music bot first to play radio stations.</p>
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
                    variant="default"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handlePlay(station.id)}
                    disabled={!selectedBotId || playRadio.isPending}
                  >
                    <Play className="h-4 w-4 ml-0.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
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

      {/* Add Station Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Radio Station</DialogTitle>
            <DialogDescription>Add a custom internet radio station by providing its stream URL.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Station name" />
            </div>
            <div>
              <Label className="text-xs">Stream URL</Label>
              <Input value={addForm.url} onChange={(e) => setAddForm({ ...addForm, url: e.target.value })} placeholder="https://stream.example.com/live" />
            </div>
            <div>
              <Label className="text-xs">Genre (optional)</Label>
              <Input value={addForm.genre} onChange={(e) => setAddForm({ ...addForm, genre: e.target.value })} placeholder="Pop, Rock, Electronic..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={handleAddStation} disabled={!addForm.name || !addForm.url || createStation.isPending}>
              Add Station
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Presets Dialog */}
      <Dialog open={showPresets} onOpenChange={setShowPresets}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col overflow-auto">
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

// ─── Video Streaming Tab ─────────────────────────────────────────────────────

function VideoTab() {
  const { data } = useMusicBots();
  const bots = Array.isArray(data) ? data : [];
  const [selectedBotId, setSelectedBotId] = useState<number | null>(null);

  // Auto-select first running bot
  const runningBots = bots.filter((b: MusicBotSummary) => b.status !== 'stopped' && b.status !== 'error');
  useEffect(() => {
    if (!selectedBotId && runningBots.length > 0) {
      setSelectedBotId(runningBots[0].id);
    }
  }, [runningBots, selectedBotId]);

  const selectedBot = bots.find((b: MusicBotSummary) => b.id === selectedBotId);

  return (
    <div className="space-y-4">
      {bots.length === 0 ? (
        <EmptyState icon={Video} title="No bots available" description="Create a music bot first, then use it for video streaming." />
      ) : (
        <>
          {/* Bot selector */}
          <div className="flex items-center gap-3">
            <Label className="shrink-0">Select Bot:</Label>
            <Select
              value={selectedBotId ? String(selectedBotId) : ''}
              onValueChange={(v) => setSelectedBotId(parseInt(v))}
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Choose a bot..." />
              </SelectTrigger>
              <SelectContent>
                {bots.map((b: MusicBotSummary) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name} — {b.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedBot ? (
            <VideoStreamTab botId={selectedBot.id} botStatus={selectedBot.status} />
          ) : (
            <p className="text-sm text-muted-foreground">Select a bot to manage video streaming.</p>
          )}
        </>
      )}
    </div>
  );
}

// ─── Queue Tab ───────────────────────────────────────────────────────────────

function QueueTab() {
  const { data: bots } = useMusicBots();
  const [selectedBot, setSelectedBot] = useState<number | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const { data: state } = useMusicBotState(selectedBot);
  const removeFromQueue = useRemoveFromQueue();
  const clearQueue = useClearQueue();
  const playFromQueue = usePlayFromQueue();
  const moveQueueItem = useMoveQueueItem();
  const enqueueSong = useEnqueue();
  const loadPlaylist = useLoadPlaylist();

  const botList = Array.isArray(bots) ? bots : [];
  const queue: any[] = state?.queue ?? [];
  const currentIndex: number = state?.currentIndex ?? -1;

  // Auto-select first running bot
  useEffect(() => {
    if (!selectedBot && botList.length > 0) {
      const running = botList.find((b: any) => b.status !== 'stopped');
      setSelectedBot(running?.id ?? botList[0]?.id ?? null);
    }
  }, [botList, selectedBot]);

  return (
    <div className="space-y-4">
      {/* Bot selector */}
      <div className="flex items-center gap-3">
        <Label className="text-xs text-muted-foreground">Bot:</Label>
        <Select value={selectedBot ? String(selectedBot) : ''} onValueChange={(v) => setSelectedBot(parseInt(v))}>
          <SelectTrigger className="w-48 h-8 text-xs"><SelectValue placeholder="Select bot" /></SelectTrigger>
          <SelectContent>
            {botList.map((b: any) => (
              <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 ml-auto">
          {queue.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">{queue.length} tracks</Badge>
          )}
          {selectedBot && (
            <Button variant="default" size="sm" className="h-7 text-xs" onClick={() => setShowAddDialog(true)}>
              <Plus className="h-3 w-3 mr-1" /> Add to queue
            </Button>
          )}
          {queue.length > 0 && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => selectedBot && clearQueue.mutate(selectedBot)}>
              <Trash2 className="h-3 w-3 mr-1" /> Clear
            </Button>
          )}
        </div>
      </div>

      {!selectedBot ? (
        <EmptyState icon={Music} title="Select a bot to manage its queue" />
      ) : queue.length === 0 ? (
        <EmptyState
          icon={ListMusic}
          title="Queue is empty"
          description="Add songs or playlists to this bot's queue."
        >
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="h-3 w-3 mr-1" /> Add to queue
          </Button>
        </EmptyState>
      ) : (
        <Card>
          <CardContent className="p-0">
            {/* Header */}
            <div className="grid grid-cols-[2rem_minmax(0,1fr)_5rem_5rem_3rem_3rem] gap-2 px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border/50">
              <div>#</div>
              <div>Title</div>
              <div className="text-right">Duration</div>
              <div className="text-right">Source</div>
              <div />
              <div />
            </div>
            <div className="max-h-[500px] overflow-y-auto">
              {queue.map((item: any, i: number) => {
                const isActive = i === currentIndex;
                return (
                  <div
                    key={`${item.id}-${i}`}
                    className={`grid grid-cols-[2rem_minmax(0,1fr)_5rem_5rem_3rem_3rem] gap-2 px-3 py-1.5 items-center group transition-colors ${isActive ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
                  >
                    <div className="text-xs text-muted-foreground font-mono-data">
                      {isActive ? <Play className="h-3 w-3 text-primary" /> : i + 1}
                    </div>
                    <div className="min-w-0">
                      <button
                        className="text-xs truncate block text-left hover:text-primary transition-colors w-full"
                        onClick={() => selectedBot && playFromQueue.mutate({ botId: selectedBot, index: i })}
                        title="Click to play"
                      >
                        {item.title}
                      </button>
                      {item.artist && <p className="text-[10px] text-muted-foreground truncate">{item.artist}</p>}
                    </div>
                    <div className="text-[11px] text-muted-foreground text-right font-mono-data">
                      {item.duration ? formatTime(item.duration) : '—'}
                    </div>
                    <div className="text-right">
                      <Badge variant="outline" className="text-[9px] h-4 px-1">{item.source}</Badge>
                    </div>
                    <div className="flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {i > 0 && (
                        <button
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                          onClick={() => selectedBot && moveQueueItem.mutate({ botId: selectedBot, from: i, to: i - 1 })}
                          title="Move up"
                        >
                          <GripVertical className="h-3 w-3 rotate-180" />
                        </button>
                      )}
                      {i < queue.length - 1 && (
                        <button
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                          onClick={() => selectedBot && moveQueueItem.mutate({ botId: selectedBot, from: i, to: i + 1 })}
                          title="Move down"
                        >
                          <GripVertical className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                        onClick={() => selectedBot && removeFromQueue.mutate({ botId: selectedBot, index: i })}
                        title="Remove from queue"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <PlaySongDialog
        botId={showAddDialog && selectedBot ? selectedBot : null}
        mode="queue"
        onClose={() => setShowAddDialog(false)}
        onPlaySong={() => {}}
        onPlayUrl={() => {}}
        onEnqueue={(songId) => {
          if (!selectedBot) return;
          enqueueSong.mutate(
            { botId: selectedBot, songId },
            {
              onSuccess: () => toast.success('Added to queue'),
              onError: () => toast.error('Failed to enqueue'),
            },
          );
        }}
        onLoadPlaylist={(playlistId) => {
          if (!selectedBot) return;
          loadPlaylist.mutate(
            { botId: selectedBot, playlistId, clearFirst: false },
            {
              onSuccess: () => {
                toast.success('Playlist added to queue');
                setShowAddDialog(false);
              },
              onError: () => toast.error('Failed to add playlist'),
            },
          );
        }}
      />
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MusicBots() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Music className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Music Bots</h1>
        </div>
      </div>

      <Tabs defaultValue="bots" className="space-y-4">
        <TabsList>
          <TabsTrigger value="bots"><Music2 className="h-3.5 w-3.5 mr-1.5" /> Bots</TabsTrigger>
          <TabsTrigger value="queue"><ListMusic className="h-3.5 w-3.5 mr-1.5" /> Queue</TabsTrigger>
          <TabsTrigger value="video"><Video className="h-3.5 w-3.5 mr-1.5" /> Video</TabsTrigger>
          <TabsTrigger value="library"><FileAudio className="h-3.5 w-3.5 mr-1.5" /> Library</TabsTrigger>
          <TabsTrigger value="playlists"><ListMusic className="h-3.5 w-3.5 mr-1.5" /> Playlists</TabsTrigger>
          <TabsTrigger value="commands"><MessageSquare className="h-3.5 w-3.5 mr-1.5" /> Commands</TabsTrigger>
          <TabsTrigger value="radio"><Radio className="h-3.5 w-3.5 mr-1.5" /> Radio</TabsTrigger>
        </TabsList>

        <TabsContent value="bots"><BotsTab /></TabsContent>
        <TabsContent value="queue"><QueueTab /></TabsContent>
        <TabsContent value="video"><VideoTab /></TabsContent>
        <TabsContent value="library"><LibraryTab /></TabsContent>
        <TabsContent value="playlists"><PlaylistsTab /></TabsContent>
        <TabsContent value="commands"><CommandsTab /></TabsContent>
        <TabsContent value="radio"><RadioTab /></TabsContent>
      </Tabs>
    </div>
  );
}
