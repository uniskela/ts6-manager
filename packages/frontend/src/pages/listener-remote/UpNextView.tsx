import { Card, CardContent } from '@/components/ui/card';
import { formatTrackLength, type RemoteState } from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export function UpNextView({ state, loading }: { readonly state: RemoteState | null; readonly loading: boolean }) {
  const items = state?.upNext ?? [];
  const count = state?.upNextCount ?? items.length;
  return (
    <Card>
      <CardContent className="p-4">
        <section aria-labelledby="up-next" className="space-y-2">
          <h2 id="up-next" className="text-base font-semibold">Up next{state ? ` (${count})` : ''}</h2>
          <UpNextItems state={state} loading={loading} items={items} />
          {state && count > items.length && (
            <p className="text-xs text-muted-foreground">Showing {items.length} of {count}.</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function UpNextItems({ state, loading, items }: {
  readonly state: RemoteState | null;
  readonly loading: boolean;
  readonly items: RemoteState['upNext'];
}) {
  if (!state) {
    if (!loading) return null;
    return <StatusNote>Loading the queue…</StatusNote>;
  }
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing is queued.</p>;
  return (
    <ol aria-label="Up next" className="max-h-64 space-y-1.5 overflow-y-auto lg:max-h-[45dvh]">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 rounded-md border bg-card p-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.title}</p>
            {item.artist && <p className="truncate text-xs text-muted-foreground">{item.artist}</p>}
          </div>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatTrackLength(item.duration) ?? ''}</span>
        </li>
      ))}
    </ol>
  );
}
