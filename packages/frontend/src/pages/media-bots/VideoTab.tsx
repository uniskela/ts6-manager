import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMusicBots } from '@/hooks/use-music-bots';
import { EmptyState } from '@/components/shared/EmptyState';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Video } from 'lucide-react';
import { VideoStreamTab } from '@/components/video/VideoStreamTab';
import type { MusicBotSummary } from '@ts6/common';


// ─── Video Streaming Tab ─────────────────────────────────────────────────────

export function VideoTab() {
  const { data } = useMusicBots();
  const bots = Array.isArray(data) ? data : [];
  const [searchParams, setSearchParams] = useSearchParams();
  // `?bot=` lets the Bot hub open a specific bot's stream controls.
  const linkedBot = Number(searchParams.get('bot')) || null;
  const [selectedBotId, setSelectedBotId] = useState<number | null>(linkedBot);

  const selectBot = (id: number) => {
    setSelectedBotId(id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('bot', String(id));
      return next;
    }, { replace: true });
  };

  // Keep selection in sync when the bot query param changes later.
  useEffect(() => {
    if (linkedBot != null) setSelectedBotId(linkedBot);
  }, [linkedBot]);

  // Auto-select first running bot
  const runningBots = bots.filter((b: MusicBotSummary) => b.status !== 'stopped' && b.status !== 'error');
  useEffect(() => {
    if (!selectedBotId && runningBots.length > 0) {
      selectBot(runningBots[0].id);
    }
  // Intentionally omit selectBot: only react to selection / bot list changes.
  }, [runningBots, selectedBotId]);

  const selectedBot = bots.find((b: MusicBotSummary) => b.id === selectedBotId);

  return (
    <div className="space-y-4">
      {bots.length === 0 ? (
        <EmptyState icon={Video} title="No bots available" description="Create a media bot first, then use it for video streaming." />
      ) : (
        <>
          {/* Bot selector */}
          <div className="flex items-center gap-3">
            <Label className="shrink-0">Select Bot:</Label>
            <Select
              value={selectedBotId ? String(selectedBotId) : ''}
              onValueChange={(v) => selectBot(parseInt(v))}
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Choose a bot..." />
              </SelectTrigger>
              <SelectContent>
                {bots.map((b: MusicBotSummary) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name} — {b.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedBot ? (
            <VideoStreamTab
              botId={selectedBot.id}
              botStatus={selectedBot.status}
              botVolume={selectedBot.volume}
              server={{
                id: selectedBot.serverConfigId,
                name: selectedBot.serverConfig?.name ?? `Server ${selectedBot.serverConfigId}`,
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Select a bot to manage video streaming.</p>
          )}
        </>
      )}
    </div>
  );
}

