/**
 * Bot console (`/bot-hub/:botId`): what one bot is playing, its queue, and
 * every way to start something on it. Starts use the existing endpoints and
 * the global "Replace what is playing?" prompt.
 */

import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Bot, Square } from 'lucide-react';
import type { PlaybackState } from '@ts6/common';
import { NowPlaying } from '@/components/media/NowPlaying';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { useBotMedia, useMusicBotState, useStopPlayback, useStopVideoStream } from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';
import { hubTone } from '@/lib/bot-hub';
import { useEffect, useState } from 'react';
import { LinkSource } from './LinkSource';
import { MusicSource } from './MusicSource';
import { RadioSource } from './RadioSource';
import { SourcePicker, type ConsoleSourceTab } from './SourcePicker';
import { UpNextQueue } from './UpNextQueue';

/** Source tabs in order Music · Link · Radio · IPTV (IPTV lands in a later PR). */
export const CONSOLE_TABS: ConsoleSourceTab[] = [
  { id: 'music', label: 'Music', render: (ctx) => <MusicSource {...ctx} /> },
  { id: 'link', label: 'Link', render: (ctx) => <LinkSource {...ctx} /> },
  { id: 'radio', label: 'Radio', render: (ctx) => <RadioSource {...ctx} /> },
];

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function BotConsole() {
  const botId = Number(useParams().botId);
  const [searchParams] = useSearchParams();
  const media = useBotMedia();
  const now = useNow();
  const bot = (media.data ?? []).find((b) => b.botId === botId);
  const tone = bot ? hubTone(bot) : 'offline';
  const online = !!bot && tone !== 'offline';
  const stateQuery = useMusicBotState(online ? botId : null);
  const state = stateQuery.data as PlaybackState | undefined;
  const stopMusic = useStopPlayback();
  const stopVideo = useStopVideoStream();

  if (media.isLoading) return <PageLoader />;
  if (media.isError) {
    return <EmptyState icon={AlertTriangle} title="Could not load bot media" description={apiErrorMessage(media.error, 'Try again in a moment.')} />;
  }
  if (!bot) {
    return (
      <EmptyState icon={Bot} title="Bot not found" description="This bot doesn't exist or was deleted.">
        <Button asChild size="sm"><Link to="/bot-hub">Back to Bot Hub</Link></Button>
      </EmptyState>
    );
  }

  const keptFor = bot.music?.live ? 'radio' : bot.session?.kind === 'video' ? 'video' : null;
  const stopError = stopMusic.error ?? stopVideo.error;

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link to="/bot-hub" className="hover:text-foreground">Bot Hub</Link> / <span>{bot.botName}</span>
      </nav>
      <PageHeader
        title={bot.botName}
        icon={Bot}
        description={`${bot.serverName ?? `Server ${bot.serverConfigId}`}${bot.channelName ? ` · #${bot.channelName}` : ''}`}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby="now-playing" className="space-y-3">
          <h2 id="now-playing" className="text-base font-semibold">Now playing</h2>
          <NowPlaying
            bot={bot}
            now={now}
            variant="full"
            footer={(
              <>
                {stopError && <p className="text-xs text-destructive">{apiErrorMessage(stopError, 'Could not stop')}</p>}
                {tone === 'live' && bot.session?.state === 'active' && (
                  <Button size="sm" variant="outline" className="h-10 w-full text-destructive" disabled={stopVideo.isPending}
                    onClick={() => stopVideo.mutate(bot.botId)}>
                    <Square className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Stop stream
                  </Button>
                )}
                {tone === 'music' && (
                  <Button size="sm" variant="outline" className="h-10 w-full text-destructive" disabled={stopMusic.isPending}
                    onClick={() => stopMusic.mutate(bot.botId)}>
                    <Square className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {bot.music?.live ? 'Stop radio' : 'Stop'}
                  </Button>
                )}
                {online && (
                  <UpNextQueue botId={bot.botId} state={state} keptFor={keptFor}
                    loadError={stateQuery.isError ? stateQuery.error : null} />
                )}
              </>
            )}
          />
        </section>

        <SourcePicker
          tabs={CONSOLE_TABS}
          ctx={{ botId: bot.botId, serverConfigId: bot.serverConfigId, botOnline: online, searchParams }}
          initialTab={searchParams.get('iptv') ? 'iptv' : undefined}
        />
      </div>
    </div>
  );
}
