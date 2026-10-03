/**
 * Bot hub — one place for what every bot is doing: active media sessions
 * (music or video, never both on a bot; one video stream at a time) plus the
 * entry points to Bot Flows, Media Bots, video streaming and IPTV.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Bot, LayoutGrid, Music, Square, Tv, Video,
} from 'lucide-react';
import type { BotMediaOverview } from '@ts6/common';
import { NowPlaying } from '@/components/media/NowPlaying';
import { PageHeader } from '@/components/shared/PageHeader';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { RefreshStatus } from '@/components/shared/RefreshStatus';
import { Button } from '@/components/ui/button';
import {
  useBotMedia, useStopPlayback, useStopVideoStream,
} from '@/hooks/use-music-bots';
import { hubTone } from '@/lib/bot-hub';
import { apiErrorMessage } from '@/lib/api-error';
import { BotAvatar } from '@/components/shared/BotAvatar';

const SECTIONS = [
  { to: '/bots', icon: Bot, title: 'Bot Flows', text: 'Event-driven automations and chat commands.' },
  { to: '/media-bots', icon: Music, title: 'Media Bots', text: 'Bots, queues, library, playlists, radio, and !play requests.' },
  { to: '/media-bots?tab=video', icon: Video, title: 'Video streaming', text: 'Stream a URL or file into a channel; quality and encoder defaults.' },
  { to: '/iptv', icon: Tv, title: 'IPTV', text: 'Playlists and live channels streamed through a bot.' },
] as const;

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

  const tone = hubTone(bot);
  const stopping = stopMusic.isPending || stopVideo.isPending;
  const error = stopMusic.error ?? stopVideo.error;

  return (
    <NowPlaying
      bot={bot}
      now={now}
      variant="compact"
      avatar={<BotAvatar botId={bot.botId} name={bot.botName} mode={bot.avatarMode} md5={bot.avatarMd5} />}
      footer={
        <>
          {error && <p className="text-xs text-destructive">{apiErrorMessage(error, 'Could not stop')}</p>}
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to={`/bot-hub/${bot.botId}`} aria-label={`Open console for ${bot.botName}`}>Open console</Link>
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
        </>
      }
    />
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
