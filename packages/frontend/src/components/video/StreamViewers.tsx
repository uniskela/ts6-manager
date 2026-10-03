/** Who is watching a bot's video stream, with a Kick action per viewer. */

import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useKickVideoViewer, useVideoStreamStatus } from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';

function watchedFor(joinedAt: number, now: number): string {
  const duration = Math.max(0, Math.floor((now - joinedAt) / 1000));
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function StreamViewers({ botId, now }: { botId: number; now: number }) {
  const { data: streamStatus } = useVideoStreamStatus(botId);
  const kickViewer = useKickVideoViewer();

  if (!streamStatus?.streaming) return null;
  const viewers: Array<{ clid: number; joinedAt: number; iceState?: string }> = streamStatus.viewers ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Viewers ({streamStatus.viewerCount})</CardTitle>
      </CardHeader>
      <CardContent>
        {viewers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No viewers connected</p>
        ) : (
          <ul className="space-y-2">
            {viewers.map((viewer) => (
              <li key={viewer.clid} className="flex items-center justify-between rounded bg-muted/50 px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${viewer.iceState === 'connected' ? 'bg-green-500' : 'bg-yellow-500'}`} aria-hidden="true" />
                  <span className="text-sm">Client #{viewer.clid}</span>
                  <span className="text-xs text-muted-foreground">{watchedFor(viewer.joinedAt, now)}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 text-xs text-red-500 hover:text-red-400"
                  aria-label={`Kick client #${viewer.clid}`}
                  disabled={kickViewer.isPending}
                  onClick={() => kickViewer.mutate({ botId, clid: viewer.clid }, {
                    onError: (err) => toast.error(apiErrorMessage(err, 'Could not kick the viewer')),
                  })}
                >
                  Kick
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
