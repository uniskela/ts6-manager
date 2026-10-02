import { useState, type ReactNode } from 'react';
import { Power } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useStartMusicBot } from '@/hooks/use-music-bots';
import { cn } from '@/lib/utils';

export interface ConsoleSourceContext {
  botId: number;
  serverConfigId: number;
  botOnline: boolean;
  /** Deep links such as `?iptv=` (never start media on their own). */
  searchParams: URLSearchParams;
}

export interface ConsoleSourceTab {
  id: 'music' | 'link' | 'radio' | 'iptv';
  label: string;
  render(ctx: ConsoleSourceContext): ReactNode;
}

/** "Play something": one tab per media source, registered in `CONSOLE_TABS`. */
export function SourcePicker({ tabs, ctx, initialTab }: {
  tabs: ConsoleSourceTab[];
  ctx: ConsoleSourceContext;
  initialTab?: ConsoleSourceTab['id'];
}) {
  const [active, setActive] = useState<ConsoleSourceTab['id'] | undefined>(initialTab ?? tabs[0]?.id);
  const startBot = useStartMusicBot();
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <h2 className="text-base font-semibold">Play something</h2>
        {!ctx.botOnline ? (
          <div className="space-y-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <p>Start the bot to play something.</p>
            <Button size="sm" disabled={startBot.isPending} onClick={() => startBot.mutate(ctx.botId)}>
              <Power className="mr-1.5 h-4 w-4" aria-hidden="true" /> Start bot
            </Button>
          </div>
        ) : tabs.length === 0 || !current ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Sources arrive in the next 1.10.0 updates.
          </p>
        ) : (
          <>
            <div role="tablist" aria-label="Source" className="flex gap-1 overflow-x-auto rounded-lg bg-muted/40 p-1">
              {tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={t.id === current.id}
                  className={cn(
                    'min-h-10 shrink-0 rounded-md px-3 text-sm',
                    t.id === current.id ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setActive(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div role="tabpanel" aria-label={current.label}>{current.render(ctx)}</div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
