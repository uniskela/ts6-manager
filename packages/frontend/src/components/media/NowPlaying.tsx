import { useState } from 'react';
import {
  AlertTriangle, Music, Pause, Play, Radio, SkipForward, Video,
} from 'lucide-react';
import type { BotMediaOverview } from '@ts6/common';
import { VideoPlayer } from '@/components/video/VideoPlayer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import {
  usePausePlayback, useResumePlayback, useSkipTrack, useSetVolume,
  useMusicBotState,
} from '@/hooks/use-music-bots';
import { hubFacts, hubHeadline, hubLastStop, hubTone, type HubTone } from '@/lib/bot-hub';
import { cn } from '@/lib/utils';

const TONE_BADGE: Record<HubTone, { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' }> = {
  live: { label: 'LIVE', variant: 'destructive' },
  music: { label: 'Playing', variant: 'default' },
  idle: { label: 'Idle', variant: 'secondary' },
  offline: { label: 'Offline', variant: 'outline' },
};

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface NowPlayingProps {
  bot: BotMediaOverview;        // from @ts6/common, as SessionCard uses today
  now: number;                  // ms, from the page's 1 s clock
  variant: 'compact' | 'full';  // phase 2's console uses 'full'
  footer?: React.ReactNode;     // the hub passes its Open / Stop buttons here
  avatar?: React.ReactNode;
}

export function NowPlaying(props: NowPlayingProps): JSX.Element {
  const { bot, now, footer, variant, avatar } = props;
  const pausePlayback = usePausePlayback();
  const resumePlayback = useResumePlayback();
  const skipTrack = useSkipTrack();
  const setVolume = useSetVolume();
  const [draggingVolume, setDraggingVolume] = useState<number | null>(null);

  const tone = hubTone(bot);
  const showVolume = tone === 'music' || tone === 'live';
  const { data: musicState } = useMusicBotState(showVolume ? bot.botId : null);
  const badge = TONE_BADGE[tone];
  const facts = hubFacts(bot, now);
  const lastStop = tone === 'idle' || tone === 'offline' ? hubLastStop(bot, now) : null;
  // One playback command at a time: repeat clicks would send duplicate skips.
  const playbackPending = pausePlayback.isPending || resumePlayback.isPending || skipTrack.isPending;
  const isPaused = bot.status === 'paused' || musicState?.status === 'paused';
  const volume = draggingVolume ?? musicState?.volume ?? 50;

  return (
    <Card className={cn(tone === 'offline' && 'opacity-70')}>
      <CardContent className="space-y-3 p-4">
        <div className={cn('flex items-start gap-3', variant === 'full' ? 'justify-end' : 'justify-between')}>
          {/* The console's page header already names the bot, server and channel. */}
          {variant === 'compact' && (
            <div className="flex min-w-0 items-center gap-2">
              {avatar}
              <div className="min-w-0">
                <p className="truncate font-medium">{bot.botName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {bot.serverName ?? `Server ${bot.serverConfigId}`}
                  {bot.channelName ? ` · #${bot.channelName}` : ''}
                </p>
              </div>
            </div>
          )}
          <Badge variant={badge.variant} className="shrink-0 gap-1">
            {tone === 'live' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
            {bot.session?.state === 'starting' ? 'Starting' : badge.label}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {tone === 'live' ? <Video className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            : tone === 'music' ? (bot.music?.live
              ? <Radio className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              : <Music className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />)
              : null}
          <p className={cn('truncate text-sm', tone === 'idle' || tone === 'offline' ? 'text-muted-foreground' : 'font-medium')}>
            {hubHeadline(bot)}
          </p>
        </div>

        {variant === 'full' && tone === 'music' && bot.music && (bot.music.live ? (
          <p className="text-xs text-muted-foreground">Plays until stopped.</p>
        ) : bot.music.duration ? (
          <div className="space-y-1">
            <div className="h-1.5 rounded-full bg-muted" role="progressbar" aria-label="Track progress"
              aria-valuemin={0} aria-valuemax={bot.music.duration} aria-valuenow={bot.music.position ?? 0}>
              <div className="h-1.5 rounded-full bg-primary"
                style={{ width: `${Math.min(100, ((bot.music.position ?? 0) / bot.music.duration) * 100)}%` }} />
            </div>
            <div className="flex justify-between font-mono text-xs text-muted-foreground">
              <span>{clock(bot.music.position ?? 0)}</span><span>{clock(bot.music.duration)}</span>
            </div>
          </div>
        ) : null)}

        {facts.length > 0 && (
          <p className="text-xs text-muted-foreground">{facts.join(' · ')}</p>
        )}
        {bot.video?.health?.warning && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-3">{bot.video.health.warning}</span>
          </p>
        )}
        {bot.video?.encoder?.fallbackReason && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-2">Hardware encoder fell back to software: {bot.video.encoder.fallbackReason}</span>
          </p>
        )}

        {tone === 'live' && (
          <div className="space-y-2">
            <VideoPlayer
              botId={bot.botId}
              streaming={bot.session?.state === 'active'}
              idleDetail={bot.session?.state === 'starting' ? 'Starting stream…' : null}
              className="max-w-none w-full"
            />
            <div className="space-y-1 rounded-md border bg-muted/30 p-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Volume</span>
                <span>{volume}%</span>
              </div>
              <Slider
                value={[volume]}
                max={100}
                step={1}
                aria-label={`Volume for ${bot.botName}`}
                onValueChange={([val]) => setDraggingVolume(val)}
                onValueCommit={([val]) => {
                  setVolume.mutate({ botId: bot.botId, volume: val });
                  setDraggingVolume(null);
                }}
              />
            </div>
          </div>
        )}

        {tone === 'music' && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-2">
            <div className="flex items-center justify-center gap-1">
              {isPaused ? (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Resume ${bot.botName}`}
                  disabled={playbackPending}
                  onClick={() => resumePlayback.mutate(bot.botId)}
                >
                  <Play className="h-4 w-4 ml-0.5" />
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Pause ${bot.botName}`}
                  disabled={playbackPending}
                  onClick={() => pausePlayback.mutate(bot.botId)}
                >
                  <Pause className="h-4 w-4" />
                </Button>
              )}
              {!bot.music?.live && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Skip track on ${bot.botName}`}
                  disabled={playbackPending}
                  onClick={() => skipTrack.mutate(bot.botId)}
                >
                  <SkipForward className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Slider
              value={[volume]}
              max={100}
              step={1}
              aria-label={`Volume for ${bot.botName}`}
              onValueChange={([val]) => setDraggingVolume(val)}
              onValueCommit={([val]) => {
                setVolume.mutate({ botId: bot.botId, volume: val });
                setDraggingVolume(null);
              }}
            />
          </div>
        )}

        {lastStop && <p className="text-xs text-muted-foreground">{lastStop}</p>}
        {footer}
      </CardContent>
    </Card>
  );
}
