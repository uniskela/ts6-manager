/**
 * Bot hub — one place for what every bot is doing: active media sessions
 * (music or video, never both on a bot; one video stream at a time) plus the
 * entry points to Bot Flows, Media Bots, video streaming and IPTV.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Bot, LayoutGrid, Music, Pause, Play, Radio, SkipForward, Square, Tv, Video,
} from 'lucide-react';
import type { BotMediaOverview } from '@ts6/common';
import { PageHeader } from '@/components/shared/PageHeader';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { RefreshStatus } from '@/components/shared/RefreshStatus';
import { VideoPlayer } from '@/components/video/VideoPlayer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import {
  useBotMedia, usePausePlayback, useResumePlayback, useSkipTrack, useSetVolume,
  useStopPlayback, useStopVideoStream, useMusicBotState,
} from '@/hooks/use-music-bots';
import { hubFacts, hubHeadline, hubLastStop, hubTone, type HubTone } from '@/lib/bot-hub';
import { apiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { to: '/bots', icon: Bot, title: 'Bot Flows', text: 'Event-driven automations and chat commands.' },
  { to: '/media-bots', icon: Music, title: 'Media Bots', text: 'Bots, queues, library, playlists, radio, and !play requests.' },
  { to: '/media-bots?tab=video', icon: Video, title: 'Video streaming', text: 'Stream a URL or file into a channel; quality and encoder defaults.' },
  { to: '/iptv', icon: Tv, title: 'IPTV', text: 'Playlists and live channels streamed through a bot.' },
] as const;

const TONE_BADGE: Record<HubTone, { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' }> = {
  live: { label: 'LIVE', variant: 'destructive' },
  music: { label: 'Playing', variant: 'default' },
  idle: { label: 'Idle', variant: 'secondary' },
  offline: { label: 'Offline', variant: 'outline' },
};

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function SessionCard({ bot, now }: { bot: BotMediaOverview; now: number }) {
  const stopMusic = useStopPlayback();
  const stopVideo = useStopVideoStream();
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
  const openHref = tone === 'live'
    ? `/media-bots?tab=video&bot=${bot.botId}`
    : tone === 'music'
      ? (bot.music?.live ? `/media-bots?tab=radio&bot=${bot.botId}` : `/media-bots?bot=${bot.botId}`)
      : '/media-bots';
  const stopping = stopMusic.isPending || stopVideo.isPending;
  // One playback command at a time: repeat clicks would send duplicate skips.
  const playbackPending = pausePlayback.isPending || resumePlayback.isPending || skipTrack.isPending;
  const error = stopMusic.error ?? stopVideo.error;
  const isPaused = bot.status === 'paused' || musicState?.status === 'paused';
  const volume = draggingVolume ?? musicState?.volume ?? 50;

  return (
    <Card className={cn(tone === 'offline' && 'opacity-70')}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{bot.botName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {bot.serverName ?? `Server ${bot.serverConfigId}`}
              {bot.channelName ? ` · #${bot.channelName}` : ''}
            </p>
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
        {error && <p className="text-xs text-destructive">{apiErrorMessage(error, 'Could not stop')}</p>}

        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to={openHref}>Open</Link>
          </Button>
          {tone === 'live' && bot.session?.state === 'active' && (
            <Button size="sm" variant="ghost" className="text-destructive" disabled={stopping}
              onClick={() => stopVideo.mutate(bot.botId)}>
              <Square className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Stop stream
            </Button>
          )}
          {tone === 'music' && (
            <Button size="sm" variant="ghost" disabled={stopping} onClick={() => stopMusic.mutate(bot.botId)}>
              <Square className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Stop media
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function BotHub() {
  const query = useBotMedia();
  const now = useNow();
  const bots = query.data ?? [];
  const active = bots.filter((b) => b.session);
  const others = bots.filter((b) => !b.session);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bot Hub"
        icon={LayoutGrid}
        description="What your bots are playing right now, and where to manage them."
        metadata={<RefreshStatus isRefreshing={query.isFetching} idleLabel="Live media status" refreshingLabel="Refreshing media status…" />}
      />

      <section aria-labelledby="hub-sections" className="space-y-2">
        <h2 id="hub-sections" className="sr-only">Sections</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SECTIONS.map((s) => (
            <Link key={s.to} to={s.to}
              className="group rounded-lg border bg-card p-4 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-center gap-2">
                <s.icon className="h-4 w-4 text-primary" aria-hidden="true" />
                <span className="font-medium">{s.title}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{s.text}</p>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="hub-now-playing" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="hub-now-playing" className="text-base font-semibold">Now playing</h2>
          <p className="text-xs text-muted-foreground">
            A bot plays music or video, never both. One video stream runs at a time.
          </p>
        </div>

        {query.isLoading ? (
          <PageLoader />
        ) : query.isError ? (
          <EmptyState icon={AlertTriangle} title="Could not load bot media" description={apiErrorMessage(query.error, 'Try again in a moment.')} />
        ) : bots.length === 0 ? (
          <EmptyState icon={Music} title="No media bots yet" description="Create a media bot to play music, radio, video or IPTV into a channel.">
            <Button asChild size="sm"><Link to="/media-bots">Go to Media Bots</Link></Button>
          </EmptyState>
        ) : (
          <>
            {active.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing is playing right now.</p>
            )}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[...active, ...others].map((bot) => <SessionCard key={bot.botId} bot={bot} now={now} />)}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
