import { useState, useEffect } from 'react';
import {
  useMusicBots,
  useMusicBotState,
  useEnqueue,
  useLoadPlaylist,
  useRemoveFromQueue,
  useClearQueue,
  usePlayFromQueue,
  useMoveQueueItem,
} from '@/hooks/use-music-bots';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Music,
  Plus,
  Trash2,
  Play,
  ListMusic,
  X,
  GripVertical,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatTime } from './shared';
import { PlaySongDialog } from './PlaySongDialog';


// ─── Queue Tab ───────────────────────────────────────────────────────────────

export function QueueTab() {
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
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <Label className="text-xs text-muted-foreground">Bot:</Label>
        <Select value={selectedBot ? String(selectedBot) : ''} onValueChange={(v) => setSelectedBot(parseInt(v))}>
          <SelectTrigger className="w-48 h-8 text-xs"><SelectValue placeholder="Select bot" /></SelectTrigger>
          <SelectContent>
            {botList.map((b: any) => (
              <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
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
        <Card className="max-w-full overflow-x-auto">
          <CardContent className="p-0">
            {/* Header */}
            <div className="grid min-w-[40rem] grid-cols-[2rem_minmax(0,1fr)_5rem_5rem_3rem_3rem] gap-2 border-b border-border/50 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
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
                    className={`group grid min-w-[40rem] grid-cols-[2rem_minmax(0,1fr)_5rem_5rem_3rem_3rem] items-center gap-2 px-3 py-1.5 transition-colors ${isActive ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
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
                    <div className="touch-action-reveal flex flex-col items-center gap-0.5 transition-opacity">
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
                    <div className="touch-action-reveal transition-opacity">
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

