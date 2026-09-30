import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Clock, ExternalLink, ListMusic, Loader2, Music, Play } from 'lucide-react';
import { musicRequestsApi, type MusicRequest } from '@/api/music-requests.api';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConnectionRequiredNotice } from '@/components/shared/NoServerSelectedState';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useMusicBots, usePlayUrl } from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/utils';
import { useServerStore } from '@/stores/server.store';
import type { MusicBotSummary } from '@ts6/common';
import { toast } from 'sonner';

function runningBotsForServer(bots: MusicBotSummary[], configId: number | null): MusicBotSummary[] {
  if (!configId) return [];
  return bots.filter(
    (b) =>
      b.serverConfigId === configId &&
      (b.status === 'connected' || b.status === 'playing' || b.status === 'paused'),
  );
}

export function RequestsTab() {
  const { selectedConfigId: configId } = useServerStore();
  const botQuery = useMusicBots();
  const bots = Array.isArray(botQuery.data) ? botQuery.data : [];
  const running = useMemo(() => runningBotsForServer(bots, configId), [bots, configId]);
  const [botId, setBotId] = useState<number | null>(null);
  const playUrl = usePlayUrl();

  useEffect(() => {
    if (running.length === 0) {
      setBotId(null);
      return;
    }
    if (botId == null || !running.some((b) => b.id === botId)) {
      setBotId(running[0].id);
    }
  }, [running, botId]);

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['music-requests', configId],
    queryFn: () => musicRequestsApi.list(configId!),
    enabled: !!configId,
  });

  if (!configId) {
    return (
      <ConnectionRequiredNotice>
        Select a TeamSpeak connection to view !play request history.
      </ConnectionRequiredNotice>
    );
  }

  if (isLoading) return <PageLoader />;

  const selectedBot = running.find((b) => b.id === botId) ?? null;
  const canAct = !!selectedBot;
  const busy = playUrl.isPending;

  const runAction = (req: MusicRequest, enqueue: boolean) => {
    if (!selectedBot) {
      toast.error('Start a media bot on this server first');
      return;
    }
    playUrl.mutate(
      { botId: selectedBot.id, url: req.url, enqueue },
      {
        onSuccess: () =>
          toast.success(enqueue ? `Queued on ${selectedBot.name}` : `Playing on ${selectedBot.name}`),
        onError: (err) =>
          toast.error(apiErrorMessage(err, enqueue ? 'Failed to enqueue' : 'Failed to play')),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Requests</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Songs requested via <code className="text-[10px] bg-muted px-1 rounded">!play</code> on this server.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Target bot</span>
          {running.length === 0 ? (
            <p className="text-xs text-muted-foreground h-8 flex items-center">No running media bots</p>
          ) : running.length === 1 ? (
            <p className="text-xs h-8 flex items-center font-medium">{running[0].name}</p>
          ) : (
            <Select
              value={botId != null ? String(botId) : undefined}
              onValueChange={(v) => setBotId(Number(v))}
            >
              <SelectTrigger className="h-8 w-48 text-xs">
                <SelectValue placeholder="Select bot…" />
              </SelectTrigger>
              <SelectContent>
                {running.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div className="relative flex flex-col border border-border rounded-lg bg-card min-h-[280px]">
        {requests.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <EmptyState
              icon={Music}
              title="No music requests yet"
              description="When users request songs with !play, they appear here."
            />
          </div>
        ) : (
          <ScrollArea className="max-h-[min(70vh,640px)]">
            <div className="p-3 grid gap-2">
              {requests.map((req) => (
                <div
                  key={req.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 p-3 rounded-lg',
                    'bg-muted/30 border border-border/50',
                  )}
                >
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0 border border-primary/20">
                    <Music className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{req.title}</p>
                    <p className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground font-mono-data">
                      <Clock className="w-3 h-3 shrink-0" />
                      Requested {formatDistanceToNow(new Date(req.requestedAt), { addSuffix: true })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={!canAct || busy}
                      onClick={() => runAction(req, false)}
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      <span className="ml-1">Play</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={!canAct || busy}
                      onClick={() => runAction(req, true)}
                    >
                      <ListMusic className="h-3 w-3" />
                      <span className="ml-1">Enqueue</span>
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" asChild>
                      <a href={req.url} target="_blank" rel="noopener noreferrer" title="Open URL">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
