import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { musicBotsApi } from '@/api/music.api';
import {
  useStartMusicBot,
  useStopMusicBot,
  useMusicBotState,
  usePausePlayback,
  useResumePlayback,
  useStopPlayback,
  useSkipTrack,
  usePreviousTrack,
  useSeek,
  useSetVolume,
  useSetShuffle,
  useSetRepeat,
} from '@/hooks/use-music-bots';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import {
  Trash2,
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Square,
  Volume2,
  VolumeX,
  Shuffle,
  Repeat,
  Repeat1,
  Power,
  PowerOff,
  Pencil,
  Link,
  Music2,
  Radio,
} from 'lucide-react';
import { MediaPlaySplitButton } from '@/components/media/MediaPlaySplitButton';
import type { MediaPlayAction } from '@/lib/media-bot-play';
import { toast } from 'sonner';
import type { MusicBotSummary, PlaybackState } from '@ts6/common';
import { formatTime } from './shared';


const statusColors: Record<string, string> = {
  stopped: 'bg-zinc-500',
  starting: 'bg-amber-500 animate-pulse',
  connected: 'bg-emerald-500',
  playing: 'bg-emerald-500 animate-pulse',
  paused: 'bg-amber-500',
  error: 'bg-red-500',
};


// ─── Bot Player Card ─────────────────────────────────────────────────────────

export function BotPlayerCard({ bot, onEdit, onDelete, onPlayAction, lastStopLine }: {
  bot: MusicBotSummary;
  onEdit: () => void;
  onDelete: () => void;
  onPlayAction: (action: MediaPlayAction) => void;
  lastStopLine?: string | null;
}) {
  const navigate = useNavigate();
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

  const handlePlayAction = (action: MediaPlayAction) => {
    if (action === 'song' || action === 'playlist') {
      onPlayAction(action);
      return;
    }
    if (action === 'iptv') {
      const params = new URLSearchParams({ bot: String(bot.id) });
      if (bot.serverConfigId) params.set('server', String(bot.serverConfigId));
      navigate(`/iptv?${params}`);
      onPlayAction(action);
      return;
    }
    const params = new URLSearchParams({
      tab: action,
      bot: String(bot.id),
    });
    if (bot.serverConfigId) params.set('server', String(bot.serverConfigId));
    navigate(`/media-bots?${params}`);
    onPlayAction(action);
  };

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
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Open player widget for ${bot.name}`}
              onClick={() => {
                musicBotsApi.playerWidgetToken(bot.id).then(setWidgetData);
                setShowWidget(true);
              }}
            >
              <Link className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit ${bot.name}`} onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" aria-label={`Delete ${bot.name}`} onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Status badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px] capitalize">{bot.status}</Badge>
          {bot.nickname && bot.nickname !== bot.name && (
            <Badge variant="outline" className="text-[10px]">{bot.nickname}</Badge>
          )}
          {bot.serverConfig && (
            <Badge variant="secondary" className="text-[10px]">{bot.serverConfig.name}</Badge>
          )}
        </div>

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
                aria-label={`${state.shuffle ? 'Disable' : 'Enable'} shuffle for ${bot.name}`}
                aria-pressed={state.shuffle}
                onClick={() => shuffleMut.mutate({ botId: bot.id, enabled: !state.shuffle })}
              >
                <Shuffle className={`h-3.5 w-3.5 ${state.shuffle ? 'text-primary' : ''}`} />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Previous track for ${bot.name}`}
                onClick={() => previousTrack.mutate(bot.id)}
              >
                <SkipBack className="h-3.5 w-3.5" />
              </Button>
              {isPlaying ? (
                <Button variant="outline" size="icon" className="h-8 w-8" aria-label={`Pause ${bot.name}`}
                  onClick={() => pausePlayback.mutate(bot.id)}
                >
                  <Pause className="h-4 w-4" />
                </Button>
              ) : (
                <Button variant="outline" size="icon" className="h-8 w-8" aria-label={`Resume ${bot.name}`}
                  onClick={() => resumePlayback.mutate(bot.id)}
                >
                  <Play className="h-4 w-4 ml-0.5" />
                </Button>
              )}
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Next track for ${bot.name}`}
                onClick={() => skipTrack.mutate(bot.id)}
              >
                <SkipForward className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Change repeat mode for ${bot.name}`}
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

        {!state?.nowPlaying && lastStopLine && (
          <p className="text-xs text-muted-foreground">{lastStopLine}</p>
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
              <MediaPlaySplitButton
                botId={bot.id}
                botName={bot.name}
                className="flex-1"
                onAction={handlePlayAction}
              />
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

