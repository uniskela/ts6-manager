import { useEffect, useMemo, useState } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Play, Repeat, Repeat1, Shuffle, Trash2, X } from 'lucide-react';
import type { PlaybackState, QueueItemInfo, RepeatMode } from '@ts6/common';
import { Button } from '@/components/ui/button';
import {
  useClearQueue, useMoveQueueItem, usePlayFromQueue, useRemoveFromQueue, useSetRepeat, useSetShuffle,
} from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/utils';
import { absoluteIndex, moveUpNext, rowKeys, upNext } from './console-queue';

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'track', track: 'queue', queue: 'off' };
const REPEAT_LABEL: Record<RepeatMode, string> = { off: 'Repeat: off', track: 'Repeat: track', queue: 'Repeat: queue' };

/** One draggable Up next row, shared by the music and video lanes. */
export function Row({ rowKey, item, onPlay, onRemove, disabled, dragDisabled }: {
  rowKey: string; item: Pick<QueueItemInfo, 'title' | 'artist'>; onPlay(): void; onRemove(): void; disabled: boolean; dragDisabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: rowKey, disabled: dragDisabled,
  });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-center gap-2 rounded-md border bg-card p-1.5', isDragging && 'opacity-60')}>
      <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} disabled={dragDisabled}
        aria-label={`Drag to reorder ${item.title}`}
        className="flex h-10 w-8 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50">
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.title}</p>
        {item.artist && <p className="truncate text-xs text-muted-foreground">{item.artist}</p>}
      </div>
      <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" disabled={disabled}
        aria-label={`Play ${item.title} now`} onClick={onPlay}>
        <Play className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0 text-destructive" disabled={disabled}
        aria-label={`Remove ${item.title} from the queue`} onClick={onRemove}>
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

/**
 * The bot's queue after the playing track. Positions in this list are
 * converted to absolute queue indexes for every API call.
 */
export function UpNextQueue({ botId, state, keptFor, loadError, stripOnly = false }: {
  botId: number;
  state: PlaybackState | undefined;
  /** The last state request failed; shown instead of an empty queue when there is no state yet. */
  loadError: unknown;
  /** Set while radio or a video plays: the queue waits and can be resumed. */
  keptFor: 'radio' | 'video' | null;
  /** The video lane owns Up next: show this queue as its one-line kept strip only. */
  stripOnly?: boolean;
}) {
  const move = useMoveQueueItem();
  const remove = useRemoveFromQueue();
  const playFrom = usePlayFromQueue();
  const clear = useClearQueue();
  const setShuffle = useSetShuffle();
  const setRepeat = useSetRepeat();

  const serverItems = useMemo(() => (state ? upNext(state) : []), [state]);
  // Optimistic order while a move is in flight, so the 2 s refresh can't jump it
  // back. A drop always reads the current list, so from/to match the server's
  // queue even if it changed during the drag.
  const [localItems, setLocalItems] = useState<QueueItemInfo[] | null>(null);
  useEffect(() => {
    if (!move.isPending) setLocalItems(null);
  }, [serverItems, move.isPending]);
  const items = localItems ?? serverItems;
  const keys = rowKeys(items);
  const currentIndex = state?.currentIndex ?? -1;
  const busy = move.isPending || remove.isPending || playFrom.isPending;

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
    move.mutate({ botId, from: absoluteIndex(currentIndex, from), to: absoluteIndex(currentIndex, to) });
  };

  const repeat = state?.repeat ?? 'off';

  // Radio and video streams never use the music queue: an empty Up next is
  // just noise there. A non-empty one stays so it can be resumed; a load
  // error always shows.
  if (keptFor && !loadError && (!state || items.length === 0)) return null;

  if (stripOnly) {
    if (items.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
        <span>{items.length === 1 ? '1 queued song is kept.' : `${items.length} queued songs are kept.`}</span>
        <Button variant="outline" size="sm" className="h-9" disabled={busy} aria-label="Play music queue"
          onClick={() => playFrom.mutate({ botId, index: absoluteIndex(currentIndex, 0) })}>
          Play queue
        </Button>
      </div>
    );
  }

  if (!state) {
    return (
      <section aria-labelledby="up-next" className="space-y-3 border-t pt-4">
        <h2 id="up-next" className="text-sm font-semibold">Up next</h2>
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load the queue. {apiErrorMessage(loadError, 'Try again in a moment.')}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading the queue…</p>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="up-next" className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 id="up-next" className="text-sm font-semibold">Up next ({items.length})</h2>
          {items.length > 1 && <span className="text-xs text-muted-foreground">Drag to reorder</span>}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button variant={state?.shuffle ? 'default' : 'outline'} size="sm" className="h-9"
            aria-pressed={!!state?.shuffle} onClick={() => setShuffle.mutate({ botId, enabled: !state?.shuffle })}>
            <Shuffle className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Shuffle
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={() => setRepeat.mutate({ botId, mode: NEXT_REPEAT[repeat] })}>
            {repeat === 'track' ? <Repeat1 className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> : <Repeat className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
            {REPEAT_LABEL[repeat]}
          </Button>
          <Button variant="ghost" size="sm" className="h-9" disabled={items.length === 0} onClick={() => clear.mutate(botId)}>
            <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Clear
          </Button>
        </div>
      </div>

      {loadError != null && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh the queue. {apiErrorMessage(loadError, 'Try again in a moment.')}
        </p>
      )}

      {keptFor && items.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
          <span>Up next ({items.length}) is kept while the {keptFor} plays.</span>
          <Button variant="outline" size="sm" className="h-9" disabled={busy}
            onClick={() => playFrom.mutate({ botId, index: absoluteIndex(currentIndex, 0) })}>
            Play queue
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Queue is empty. Add songs or a playlist from Play something.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={keys} strategy={verticalListSortingStrategy}>
            <ol aria-label="Up next" className="max-h-[28rem] space-y-1.5 overflow-y-auto">
              {items.map((item, i) => (
                <Row key={keys[i]} rowKey={keys[i]} item={item} disabled={busy} dragDisabled={move.isPending}
                  onPlay={() => playFrom.mutate({ botId, index: absoluteIndex(currentIndex, i) })}
                  onRemove={() => remove.mutate({ botId, index: absoluteIndex(currentIndex, i) })} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}
