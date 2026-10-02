import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { musicRequestsApi } from '@/api/music-requests.api';
import { useSongs } from '@/hooks/use-music-library';
import { usePlaylists } from '@/hooks/use-playlists';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
  Plus,
  Play,
  Upload,
  ListMusic,
  FileAudio,
  Music2,
  Clock,
} from 'lucide-react';
import type { SongInfo, PlaylistSummary } from '@ts6/common';
import { formatTime } from './shared';


// ─── Play Song Dialog ─────────────────────────────────────────────────────────

export function PlaySongDialog({ botId, onClose, onPlaySong, onPlayUrl, onEnqueue, onLoadPlaylist, mode = 'play', initialTab = 'songs' }: {
  botId: number | null;
  onClose: () => void;
  onPlaySong: (songId: number) => void;
  onPlayUrl: (url: string) => void;
  onEnqueue: (songId: number) => void;
  onLoadPlaylist: (playlistId: number) => void;
  /** play = Bots tab (play/queue/load); queue = Queue tab (enqueue / append only). */
  mode?: 'play' | 'queue';
  initialTab?: 'songs' | 'playlists' | 'history';
}) {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<number | null>(selectedConfigId);
  const configId = serverId || selectedConfigId;
  const { data: songs } = useSongs(configId);
  const { data: playlists } = usePlaylists(configId ?? undefined);
  const { data: history = [] } = useQuery({
    queryKey: ['music-requests', configId],
    queryFn: () => musicRequestsApi.list(configId!),
    enabled: !!configId && mode === 'play',
  });
  const [tab, setTab] = useState<'songs' | 'playlists' | 'history'>(initialTab);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (botId !== null) setTab(initialTab);
  }, [botId, initialTab]);

  const serverList = Array.isArray(servers) ? servers : [];
  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const playlistList = (Array.isArray(playlists) ? playlists : []) as PlaylistSummary[];
  const isQueueMode = mode === 'queue';

  const filtered = filter
    ? songList.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()) || (s.artist || '').toLowerCase().includes(filter.toLowerCase()))
    : songList;

  return (
    <Dialog open={botId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg [--dialog-max-height:80vh] flex flex-col">
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
                  <div className="touch-action-reveal flex shrink-0 items-center gap-1 transition-opacity">
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
                <Button variant="default" size="sm" className="touch-action-reveal h-7 px-2 text-[10px] transition-opacity"
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
                <div className="touch-action-reveal flex shrink-0 items-center gap-1 transition-opacity">
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

