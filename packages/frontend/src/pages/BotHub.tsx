/**
 * Bot hub — the one list of media bots: what each is playing (music or
 * video, never both on a bot; one video stream at a time), its console,
 * and its settings (new, edit, start/stop, widget link, delete).
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Bot, LayoutGrid, Library, Music, Plus, Power, Square, Tv, Video,
} from 'lucide-react';
import type { BotMediaOverview } from '@ts6/common';
import { toast } from 'sonner';
import { NowPlaying } from '@/components/media/NowPlaying';
import { PageHeader } from '@/components/shared/PageHeader';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { RefreshStatus } from '@/components/shared/RefreshStatus';
import { CONNECTION_SETUP_PATH, ConnectionRequiredNotice, useConnectionAvailability } from '@/components/shared/NoServerSelectedState';
import { Button } from '@/components/ui/button';
import {
  useBotMedia, useStartMusicBot, useStopPlayback, useStopVideoStream,
} from '@/hooks/use-music-bots';
import { useServerStore } from '@/stores/server.store';
import { hubTone } from '@/lib/bot-hub';
import { apiErrorMessage } from '@/lib/api-error';
import { BotAvatar } from '@/components/shared/BotAvatar';
import { BotFormDialog } from './bot-hub/BotFormDialog';
import { BotSettingsMenu } from './bot-hub/BotSettingsMenu';

const SECTIONS = [
  { to: '/bots', icon: Bot, label: 'Bot Flows' },
  { to: '/media-bots', icon: Library, label: 'Media Library' },
  { to: '/media-bots?tab=streaming', icon: Video, label: 'Streaming defaults' },
  { to: '/iptv', icon: Tv, label: 'IPTV' },
] as const;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function BotCard({ bot, now }: { bot: BotMediaOverview; now: number }) {
  const stopMusic = useStopPlayback();
  const stopVideo = useStopVideoStream();
  const startBot = useStartMusicBot();

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
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline" className="h-9">
              <Link to={`/bot-hub/${bot.botId}`} aria-label={`Open console for ${bot.botName}`}>Open console</Link>
            </Button>
            {tone === 'offline' && (
              <Button size="sm" variant="ghost" className="h-9" disabled={startBot.isPending}
                aria-label={`Start ${bot.botName}`}
                onClick={() => startBot.mutate(bot.botId, {
                  onSuccess: () => toast.success('Bot started'),
                  onError: (err) => toast.error(apiErrorMessage(err, 'Failed to start bot')),
                })}>
                <Power className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Start bot
              </Button>
            )}
            {tone === 'live' && bot.session?.state === 'active' && (
              <Button size="sm" variant="ghost" className="h-9 text-destructive" disabled={stopping}
                onClick={() => stopVideo.mutate(bot.botId)}>
                <Square className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Stop stream
              </Button>
            )}
            {tone === 'music' && (
              <Button size="sm" variant="ghost" className="h-9" disabled={stopping} onClick={() => stopMusic.mutate(bot.botId)}>
                <Square className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Stop media
              </Button>
            )}
            <div className="ml-auto">
              <BotSettingsMenu botId={bot.botId} botName={bot.botName} status={bot.status} />
            </div>
          </div>
        </>
      }
    />
  );
}

export default function BotHub() {
  const query = useBotMedia();
  const now = useNow();
  const { selectedConfigId } = useServerStore();
  const { isPending: connectionsPending, hasNoConnections } = useConnectionAvailability();
  const [createOpen, setCreateOpen] = useState(false);
  const bots = query.data ?? [];
  const active = bots.filter((b) => b.session);
  const others = bots.filter((b) => !b.session);
  const createBlocked = connectionsPending || hasNoConnections;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bot Hub"
        icon={LayoutGrid}
        description="Your media bots: what each is playing, its console, and its settings."
        metadata={<RefreshStatus isRefreshing={query.isFetching} idleLabel="Live media status" refreshingLabel="Refreshing media status…" />}
        actions={(
          <Button disabled={createBlocked} onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> New bot
          </Button>
        )}
      />

      <nav aria-label="Bot sections" className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <Button key={s.to} asChild size="sm" variant="outline" className="h-10">
            <Link to={s.to}>
              <s.icon className="mr-1.5 h-4 w-4 text-primary" aria-hidden="true" /> {s.label}
            </Link>
          </Button>
        ))}
      </nav>

      {bots.length > 0 && hasNoConnections && (
        <ConnectionRequiredNotice>New media bots need a TeamSpeak server connection.</ConnectionRequiredNotice>
      )}

      <section aria-labelledby="hub-bots" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="hub-bots" className="text-base font-semibold">Bots</h2>
          <p className="text-xs text-muted-foreground">
            A bot plays music or video, never both. One video stream runs at a time.
          </p>
        </div>

        {query.isLoading ? (
          <PageLoader />
        ) : query.isError ? (
          <EmptyState icon={AlertTriangle} title="Could not load bot media" description={apiErrorMessage(query.error, 'Try again in a moment.')} />
        ) : bots.length === 0 && hasNoConnections ? (
          <EmptyState icon={Music} title="Connect a TeamSpeak server first" description="Media bots join a server connection. Add one in Settings → Connections, then create your first bot.">
            <Button size="sm" asChild><Link to={CONNECTION_SETUP_PATH}>Open connection setup</Link></Button>
          </EmptyState>
        ) : bots.length === 0 ? (
          <EmptyState icon={Music} title="No media bots yet" description="Create a media bot to play music, radio, video or IPTV into a channel.">
            <Button size="sm" disabled={createBlocked} onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> Create a bot
            </Button>
          </EmptyState>
        ) : (
          <>
            {active.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing is playing right now.</p>
            )}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[...active, ...others].map((bot) => <BotCard key={bot.botId} bot={bot} now={now} />)}
            </div>
          </>
        )}
      </section>

      <BotFormDialog open={createOpen} bot={null} defaultServerId={selectedConfigId} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
