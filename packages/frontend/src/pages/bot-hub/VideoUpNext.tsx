import { useEffect, useMemo, useState } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SkipForward, Trash2 } from 'lucide-react';
import type { VideoQueueItemInfo, VideoQueueState } from '@ts6/common';
import { Button } from '@/components/ui/button';
import {
  useClearVideoQueue, useMoveQueuedVideo, usePlayQueuedVideo, usePlayVideoQueue, useRemoveQueuedVideo, useSkipVideo,
} from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';
import { moveUpNext, rowKeys, videoRowDetail } from './console-queue';
import { Row } from './UpNextQueue';

const NO_ITEMS: VideoQueueItemInfo[] = [];

/**
 * The bot's queued videos. Positions in this list are the upcoming indexes the
 * queue routes take; the playing video is not in it and changes with Skip.
 */
export function VideoUpNext({ botId, state, streaming, loadError, stripOnly = false }: {
  botId: number;
  state: VideoQueueState | undefined;
  /** A video is streaming on this bot. */
  streaming: boolean;
  /** The last queue request failed; shown when there is no queue to show instead. */
  loadError: unknown;
  /** The music lane owns Up next: show this queue as its one-line kept strip only. */
  stripOnly?: boolean;
}) {
  const move = useMoveQueuedVideo();
  const remove = useRemoveQueuedVideo();
  const playAt = usePlayQueuedVideo();
  const playQueue = usePlayVideoQueue();
  const skip = useSkipVideo();
  const clear = useClearVideoQueue();

  const serverItems = state?.upNext ?? NO_ITEMS;
  // Optimistic order while a move is in flight, as in the music lane.
  const [localItems, setLocalItems] = useState<VideoQueueItemInfo[] | null>(null);
  useEffect(() => {
    if (!move.isPending) setLocalItems(null);
  }, [serverItems, move.isPending]);
  const items = localItems ?? serverItems;
  const keys = useMemo(() => rowKeys(items), [items]);
  const starting = playAt.isPending || playQueue.isPending || skip.isPending;
  const busy = move.isPending || remove.isPending || clear.isPending || starting;
  const failed = [skip, playAt, playQueue, move, remove, clear].find((m) => m.isError)?.error;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    // One move at a time: a second drop would send indexes from the unsaved order.
    if (move.isPending || !over || active.id === over.id) return;
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setLocalItems(moveUpNext(items, from, to));
    move.mutate({ botId, from, to });
  };

  if (stripOnly) {
    if (items.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
        <span>{items.length === 1 ? '1 queued video is kept.' : `${items.length} queued videos are kept.`}</span>
        <Button variant="outline" size="sm" className="h-9" disabled={busy} aria-label="Play video queue"
          onClick={() => playQueue.mutate({ botId })}>
          {playQueue.isPending ? 'Starting…' : 'Play queue'}
        </Button>
      </div>
    );
  }

  if (!state) {
    // Nothing to manage on an idle bot until the queue has loaded.
    if (!streaming && !loadError) return null;
    return (
      <section aria-labelledby="up-next" className="space-y-3 border-t pt-4">
        <h2 id="up-next" className="text-sm font-semibold">Up next</h2>
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load the video queue. {apiErrorMessage(loadError, 'Try again in a moment.')}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading the queue…</p>
        )}
      </section>
    );
  }

  if (!streaming && items.length === 0) return null;

  return (
    <section aria-labelledby="up-next" className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 id="up-next" className="text-sm font-semibold">Up next ({items.length})</h2>
          {items.length > 1 && <span className="text-xs text-muted-foreground">Drag to reorder</span>}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" size="sm" className="h-9" disabled={!streaming || busy}
            aria-label="Skip to the next video" onClick={() => skip.mutate({ botId })}>
            <SkipForward className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {skip.isPending ? 'Skipping…' : 'Skip'}
          </Button>
          <Button variant="ghost" size="sm" className="h-9" disabled={items.length === 0 || busy}
            onClick={() => clear.mutate({ botId })}>
            <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Clear
          </Button>
        </div>
      </div>

      {loadError != null && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh the video queue. {apiErrorMessage(loadError, 'Try again in a moment.')}
        </p>
      )}
      {failed != null && (
        <p role="alert" className="text-sm text-destructive">
          {apiErrorMessage(failed, 'That change to the video queue did not go through.')}
        </p>
      )}

      {state.kept && items.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
          <span>Up next ({items.length}) is kept. Nothing is streaming.</span>
          <Button variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => playQueue.mutate({ botId })}>
            {playQueue.isPending ? 'Starting…' : 'Play queue'}
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No more videos queued. Add one from the Link tab.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={keys} strategy={verticalListSortingStrategy}>
            <ol aria-label="Up next" className="max-h-[28rem] space-y-1.5 overflow-y-auto">
              {items.map((item, i) => (
                <Row key={keys[i]} rowKey={keys[i]} item={{ title: item.title, artist: videoRowDetail(item) }}
                  disabled={busy} dragDisabled={move.isPending}
                  onPlay={() => playAt.mutate({ botId, index: i })}
                  onRemove={() => remove.mutate({ botId, index: i })} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}
