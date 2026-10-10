/**
 * Up next helpers for the bot console. The bot's queue holds every track and
 * `currentIndex` points at the one playing; the API's move, remove and
 * play-now routes take absolute queue indexes.
 */

import type { PlaybackState, QueueItemInfo, VideoQueueItemInfo } from '@ts6/common';

/** Tracks after the playing one (the whole queue before anything has played). */
export function upNext(state: Pick<PlaybackState, 'queue' | 'currentIndex'>): QueueItemInfo[] {
  return state.queue.slice(Math.max(state.currentIndex + 1, 0));
}

/** Absolute queue index of the item at `upNextIndex` in the Up next list. */
export function absoluteIndex(currentIndex: number, upNextIndex: number): number {
  return Math.max(currentIndex + 1, 0) + upNextIndex;
}

/** A copy of `items` with the item at `from` moved to `to`. */
export function moveUpNext<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Unique row keys for drag and drop. A library song's queue id is its song id,
 * so the same song queued twice shares an id; the occurrence count tells them apart.
 */
export function rowKeys(items: Pick<QueueItemInfo, 'id'>[]): string[] {
  const seen = new Map<string, number>();
  return items.map(({ id }) => {
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return `${id}#${n}`;
  });
}

export type UpNextLane = 'music' | 'video';

/**
 * Which queue Up next shows. A bot plays music or video, never both: the video
 * lane leads while a video streams, and on an idle bot when only videos wait.
 */
export function activeLane(input: {
  sessionKind: 'music' | 'video' | null;
  musicLive: boolean;
  musicUpNext: number;
  videoUpNext: number;
}): UpNextLane {
  if (input.sessionKind === 'video') return 'video';
  if (input.sessionKind === null && input.videoUpNext > 0 && input.musicUpNext === 0) return 'video';
  return 'music';
}

/** Second line of a queued video: `Live`, or its host when the title is not already that. */
export function videoRowDetail(item: Pick<VideoQueueItemInfo, 'title' | 'source' | 'sourceMode'>): string | undefined {
  if (item.sourceMode === 'live') return 'Live';
  if (!/^https?:\/\//i.test(item.source)) return undefined;
  try {
    const host = new URL(item.source).hostname;
    return host && host !== item.title ? host : undefined;
  } catch {
    return undefined;
  }
}
