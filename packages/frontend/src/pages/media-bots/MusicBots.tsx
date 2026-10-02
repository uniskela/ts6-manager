import { useSearchParams } from 'react-router-dom';
import { useMusicBots } from '@/hooks/use-music-bots';
import { PageHeader } from '@/components/shared/PageHeader';
import { RefreshStatus, StaleDataNotice } from '@/components/shared/RefreshStatus';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Music,
  ListMusic,
  FileAudio,
  Music2,
  Radio,
  Clock,
  Video,
  MessageSquare,
} from 'lucide-react';
import { RequestsTab } from '@/components/media/RequestsTab';
import { apiErrorMessage } from '@/lib/api-error';
import { formatNumber } from '@/lib/formatting';
import { BotsTab } from './BotsTab';
import { QueueTab } from './QueueTab';
import { VideoTab } from './VideoTab';
import { LibraryTab } from './LibraryTab';
import { PlaylistsTab } from './PlaylistsTab';
import { CommandsTab } from './CommandsTab';
import { RadioTab } from './RadioTab';


/** Tabs addressable as `/media-bots?tab=…` (the Bot hub links to them). */
const MUSIC_TABS = ['bots', 'queue', 'video', 'library', 'playlists', 'commands', 'radio', 'requests'];


// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MusicBots() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam && MUSIC_TABS.includes(tabParam) ? tabParam : 'bots';
  const setActiveTab = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'bots') next.delete('tab'); else next.set('tab', tab);
    if (tab !== 'video') next.delete('bot');
    setSearchParams(next, { replace: true });
  };
  const botQuery = useMusicBots();
  const botCount = Array.isArray(botQuery.data) ? botQuery.data.length : 0;
  const backgroundError = botQuery.error
    ? apiErrorMessage(botQuery.error, 'Media bot refresh failed. The last successful state is still displayed where available.')
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Media Bots"
        icon={Music}
        description="Manage voice bots, playback, queues, media, radio, and !play requests."
        badge={<Badge variant="secondary">{formatNumber(botCount)} configured</Badge>}
        metadata={<RefreshStatus isRefreshing={botQuery.isFetching} idleLabel="Live bot status active" refreshingLabel="Refreshing bot status…" />}
      />

      {backgroundError && (
        <StaleDataNotice
          message={backgroundError}
          onRetry={() => { void botQuery.refetch(); }}
          isRetrying={botQuery.isFetching}
        />
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="bots"><Music2 className="h-3.5 w-3.5 mr-1.5" /> Bots</TabsTrigger>
          <TabsTrigger value="queue"><ListMusic className="h-3.5 w-3.5 mr-1.5" /> Queue</TabsTrigger>
          <TabsTrigger value="video"><Video className="h-3.5 w-3.5 mr-1.5" /> Video</TabsTrigger>
          <TabsTrigger value="library"><FileAudio className="h-3.5 w-3.5 mr-1.5" /> Library</TabsTrigger>
          <TabsTrigger value="playlists"><ListMusic className="h-3.5 w-3.5 mr-1.5" /> Playlists</TabsTrigger>
          <TabsTrigger value="commands"><MessageSquare className="h-3.5 w-3.5 mr-1.5" /> Commands</TabsTrigger>
          <TabsTrigger value="radio"><Radio className="h-3.5 w-3.5 mr-1.5" /> Radio</TabsTrigger>
          <TabsTrigger value="requests"><Clock className="h-3.5 w-3.5 mr-1.5" /> Requests</TabsTrigger>
        </TabsList>

        <TabsContent value="bots"><BotsTab /></TabsContent>
        <TabsContent value="queue"><QueueTab /></TabsContent>
        <TabsContent value="video"><VideoTab /></TabsContent>
        <TabsContent value="library"><LibraryTab /></TabsContent>
        <TabsContent value="playlists"><PlaylistsTab /></TabsContent>
        <TabsContent value="commands"><CommandsTab /></TabsContent>
        <TabsContent value="radio"><RadioTab /></TabsContent>
        <TabsContent value="requests"><RequestsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

