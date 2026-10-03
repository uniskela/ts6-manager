/**
 * Bot console (`/bot-hub/:botId`): what one bot is playing, its queue, and
 * every way to start something on it. Starts use the existing endpoints and
 * the global "Replace what is playing?" prompt.
 */

import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Bot } from 'lucide-react';
import type { PlaybackState } from '@ts6/common';
import { NowPlaying } from '@/components/media/NowPlaying';
import { StreamSourceSwitch } from '@/components/video/StreamSourceSwitch';
import { StreamViewers } from '@/components/video/StreamViewers';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useBotMedia, useMusicBotState } from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';
import { hubTone } from '@/lib/bot-hub';
import { useEffect, useState } from 'react';
import { LinkSource } from './LinkSource';
import { MusicSource } from './MusicSource';
import { RadioSource } from './RadioSource';
import { IptvSource } from './IptvSource';
import { SourcePicker, type ConsoleSourceTab } from './SourcePicker';
import { UpNextQueue } from './UpNextQueue';
import { BotSettingsMenu } from './BotSettingsMenu';
import { BotAvatar } from '@/components/shared/BotAvatar';

/** Source tabs in order Music · Link · Radio · IPTV. */
export const CONSOLE_TABS: ConsoleSourceTab[] = [
  { id: 'music', label: 'Music', render: (ctx) => <MusicSource {...ctx} /> },
  { id: 'link', label: 'Link', render: (ctx) => <LinkSource {...ctx} /> },
  { id: 'radio', label: 'Radio', render: (ctx) => <RadioSource {...ctx} /> },
  { id: 'iptv', label: 'IPTV', render: (ctx) => <IptvSource {...ctx} /> },
];

/** The bot's TeamSpeak connection, shown next to its name. */
const CONNECTION_BADGE: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'outline' }> = {
  connected: { label: 'Connected', variant: 'success' },
  playing: { label: 'Connected', variant: 'success' },
  paused: { label: 'Connected', variant: 'success' },
  starting: { label: 'Connecting', variant: 'warning' },
  stopped: { label: 'Offline', variant: 'outline' },
  error: { label: 'Error', variant: 'destructive' },
};

/** Keep elapsed playback displays current while the console is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Render one bot's playback state, queue, and source tabs. */
export default function BotConsole() {
  const botId = Number(useParams().botId);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const media = useBotMedia();
  const now = useNow();
  const bot = (media.data ?? []).find((b) => b.botId === botId);
  const tone = bot ? hubTone(bot) : 'offline';
  const online = !!bot && tone !== 'offline';
  const stateQuery = useMusicBotState(online ? botId : null);
  const state = stateQuery.data as PlaybackState | undefined;

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
  const connection = CONNECTION_BADGE[bot.status] ?? CONNECTION_BADGE.connected;

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link to="/bot-hub" className="hover:text-foreground">Bot Hub</Link> / <span>{bot.botName}</span>
      </nav>
      <PageHeader
        title={bot.botName}
        leading={<BotAvatar botId={bot.botId} name={bot.botName} mode={bot.avatarMode} md5={bot.avatarMd5} />}
        badge={<Badge variant={connection.variant}>{connection.label}</Badge>}
        description={`${bot.serverName ?? `Server ${bot.serverConfigId}`}${bot.channelName ? ` · #${bot.channelName}` : ''}`}
        actions={(
          <BotSettingsMenu botId={bot.botId} botName={bot.botName} status={bot.status} size="default"
            onDeleted={() => navigate('/bot-hub', { replace: true })} />
        )}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby="now-playing" className="space-y-4">
          <NowPlaying
            bot={bot}
            now={now}
            variant="full"
            footer={online ? (
              <UpNextQueue botId={bot.botId} state={state} keptFor={keptFor}
                loadError={stateQuery.isError ? stateQuery.error : null} />
            ) : undefined}
          />
          {tone === 'live' && <StreamSourceSwitch botId={bot.botId} />}
          {tone === 'live' && <StreamViewers botId={bot.botId} now={now} />}
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
