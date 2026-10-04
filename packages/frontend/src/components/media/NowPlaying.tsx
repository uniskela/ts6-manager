import { useState } from 'react';
import {
  AlertTriangle, Music, Pause, Play, Radio, SkipForward, Square, Video,
} from 'lucide-react';
import type { BotMediaOverview } from '@ts6/common';
import { VideoPlayer } from '@/components/video/VideoPlayer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import {
  usePausePlayback, useResumePlayback, useSkipTrack, useSetVolume,
  useMusicBotState, useStopPlayback, useStopVideoStream,
} from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';
import {
  hubFacts, hubHeadline, hubLastStop, hubTone, queuePosition, videoDetails, type HubTone,
} from '@/lib/bot-hub';
import { formatClock } from '@/lib/video-streaming';
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
  return props.variant === 'full' ? <FullNowPlaying {...props} /> : <CompactNowPlaying {...props} />;
}

function CompactNowPlaying(props: NowPlayingProps): JSX.Element {
  const { bot, now, footer, avatar } = props;
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
        <div className="flex items-start justify-between gap-3">
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

/** Labelled volume slider; music, video and IPTV share one level per bot. */
function VolumeControl({ bot, volume, onDrag, onCommit }: {
  bot: BotMediaOverview; volume: number; onDrag(v: number): void; onCommit(v: number): void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Volume</span>
        <span className="font-mono tabular-nums">{volume}%</span>
      </div>
      <Slider
        value={[volume]}
        max={100}
        step={1}
        aria-label={`Volume for ${bot.botName}`}
        onValueChange={([val]) => onDrag(val)}
        onValueCommit={([val]) => onCommit(val)}
      />
    </div>
  );
}

/**
 * The console's Now playing card: one block per media type (music, radio,
 * video, idle), its own controls including Stop, then the caller's footer
 * (Up next).
 */
function FullNowPlaying({ bot, now, footer }: NowPlayingProps): JSX.Element {
  const pausePlayback = usePausePlayback();
  const resumePlayback = useResumePlayback();
  const skipTrack = useSkipTrack();
  const setVolume = useSetVolume();
  const stopMusic = useStopPlayback();
  const stopVideo = useStopVideoStream();
  const [draggingVolume, setDraggingVolume] = useState<number | null>(null);

  const tone = hubTone(bot);
  const active = tone === 'music' || tone === 'live';
  const { data: musicState } = useMusicBotState(active ? bot.botId : null);
  const radio = tone === 'music' && !!bot.music?.live;
  const isPaused = bot.status === 'paused' || musicState?.status === 'paused';
  const playbackPending = pausePlayback.isPending || resumePlayback.isPending || skipTrack.isPending;
  const volume = draggingVolume ?? musicState?.volume ?? 50;
  const lastStop = hubLastStop(bot, now);
  const stopError = tone === 'music' ? stopMusic.error : tone === 'live' ? stopVideo.error : null;

  const badge = TONE_BADGE[tone];
  const badgeLabel = bot.session?.state === 'starting' ? 'Starting'
    : tone === 'music' && isPaused ? 'Paused'
      : radio ? 'Radio'
        : badge.label;

  const volumeControl = (
    <VolumeControl bot={bot} volume={volume} onDrag={setDraggingVolume}
      onCommit={(val) => { setVolume.mutate({ botId: bot.botId, volume: val }); setDraggingVolume(null); }} />
  );
  const music = bot.music;
  const subline = radio
    ? ['Live radio · plays until stopped', music?.position != null ? `up ${formatClock(music.position * 1000)}` : null]
    : [music?.artist, queuePosition(musicState)];
  const details = videoDetails(bot, now);

  return (
    <Card className={cn(tone === 'offline' && 'opacity-70')}>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 id="now-playing" className="text-base font-semibold">Now playing</h2>
          <Badge variant={badge.variant} className="shrink-0 gap-1">
            {tone === 'live' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
            {badgeLabel}
          </Badge>
        </div>

        {tone === 'music' && music && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {radio ? <Radio className="h-6 w-6" aria-hidden="true" /> : <Music className="h-6 w-6" aria-hidden="true" />}
              </div>
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">{radio ? hubHeadline(bot) : (music.title ?? 'Unknown track')}</p>
                {subline.some(Boolean) && (
                  <p className="truncate text-sm text-muted-foreground">{subline.filter(Boolean).join(' · ')}</p>
                )}
              </div>
            </div>

            {!radio && music.duration ? (
              <div className="space-y-1">
                <div className="h-1.5 rounded-full bg-muted" role="progressbar" aria-label="Track progress"
                  aria-valuemin={0} aria-valuemax={music.duration} aria-valuenow={music.position ?? 0}>
                  <div className="h-1.5 rounded-full bg-primary"
                    style={{ width: `${Math.min(100, ((music.position ?? 0) / music.duration) * 100)}%` }} />
                </div>
                <div className="flex justify-between font-mono text-xs tabular-nums text-muted-foreground">
                  <span>{clock(music.position ?? 0)}</span><span>{clock(music.duration)}</span>
                </div>
              </div>
            ) : null}

            {/* ponytail: 3 nowrap buttons overflow ~390px; Stop full-width below sm */}
            <div className={cn('grid min-w-0 gap-2', radio ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3')}>
              {isPaused ? (
                <Button variant="outline" className="h-11 min-w-0" aria-label={`Resume ${bot.botName}`} disabled={playbackPending}
                  onClick={() => resumePlayback.mutate(bot.botId)}>
                  <Play className="mr-1.5 h-4 w-4" aria-hidden="true" /> Resume
                </Button>
              ) : (
                <Button variant="outline" className="h-11 min-w-0" aria-label={`Pause ${bot.botName}`} disabled={playbackPending}
                  onClick={() => pausePlayback.mutate(bot.botId)}>
                  <Pause className="mr-1.5 h-4 w-4" aria-hidden="true" /> Pause
                </Button>
              )}
              {!radio && (
                <Button variant="outline" className="h-11 min-w-0" aria-label={`Skip track on ${bot.botName}`} disabled={playbackPending}
                  onClick={() => skipTrack.mutate(bot.botId)}>
                  <SkipForward className="mr-1.5 h-4 w-4" aria-hidden="true" /> Skip
                </Button>
              )}
              <Button variant="outline" className={cn('h-11 min-w-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive', !radio && 'col-span-2 sm:col-span-1')}
                disabled={stopMusic.isPending} onClick={() => stopMusic.mutate(bot.botId)}>
                <Square className="mr-1.5 h-4 w-4" aria-hidden="true" /> {radio ? 'Stop radio' : 'Stop'}
              </Button>
            </div>
            {volumeControl}
          </div>
        )}

        {tone === 'live' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Video className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <p className="truncate text-base font-semibold">{hubHeadline(bot)}</p>
            </div>
            <VideoPlayer
              botId={bot.botId}
              streaming={bot.session?.state === 'active'}
              idleDetail={bot.session?.state === 'starting' ? 'Starting stream…' : null}
              className="max-w-none w-full"
            />
            {details.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border bg-muted/30 p-3">
                {details.map((d) => (
                  <div key={d.label} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{d.label}</dt>
                    <dd className="break-words text-sm">{d.value}</dd>
                  </div>
                ))}
              </dl>
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
            {volumeControl}
            {bot.session?.state === 'active' && (
              <Button variant="outline" className="h-11 w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={stopVideo.isPending} onClick={() => stopVideo.mutate(bot.botId)}>
                <Square className="mr-1.5 h-4 w-4" aria-hidden="true" /> Stop stream
              </Button>
            )}
          </div>
        )}

        {(tone === 'idle' || tone === 'offline') && (
          <div className="rounded-md border border-dashed px-4 py-6 text-center">
            <p className="text-sm font-medium">
              {tone === 'idle' ? 'Nothing is playing' : bot.status === 'error' ? 'The bot hit an error' : 'The bot is offline'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {tone === 'idle' ? 'Pick something under Play something.' : 'Use Start bot to connect it to TeamSpeak.'}
            </p>
          </div>
        )}

        {stopError && <p role="alert" className="text-xs text-destructive">{apiErrorMessage(stopError, 'Could not stop')}</p>}
        {lastStop && <p className="text-xs text-muted-foreground">{lastStop}</p>}
        {footer}
      </CardContent>
    </Card>
  );
}
