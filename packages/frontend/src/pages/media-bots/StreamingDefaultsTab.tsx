/**
 * Media Library → Streaming defaults: the video settings every new stream
 * starts from (global, or overridden for the selected server). Streams
 * themselves start from each bot's console.
 */

import { Link } from 'react-router-dom';
import { RuntimeMediaDiagnostics } from '@/components/media/RuntimeMediaDiagnostics';
import { VideoStreamDefaultsCard } from '@/components/video/VideoStreamDefaultsCard';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';

export function StreamingDefaultsTab() {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const selected = (Array.isArray(servers) ? servers : []).find((s: { id: number }) => Number(s.id) === selectedConfigId) as
    | { id: number; name: string }
    | undefined;
  const server = selected ? { id: Number(selected.id), name: selected.name } : null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Start a stream from a bot&apos;s console in the <Link to="/bot-hub" className="text-primary underline-offset-4 hover:underline">Bot Hub</Link>.
          Changes there apply to that one stream; these defaults stay as they are.
        </p>
        <VideoStreamDefaultsCard server={server} />
      </div>
      <RuntimeMediaDiagnostics
        className="lg:sticky lg:top-4"
        focus={['sidecar', 'ffmpeg', 'ffprobe', 'yt-dlp']}
        showPrerequisite
        compact
      />
    </div>
  );
}
