/**
 * Up next helpers for the bot console. The bot's queue holds every track and
 * `currentIndex` points at the one playing; the API's move, remove and
 * play-now routes take absolute queue indexes.
 */

import type { PlaybackState, QueueItemInfo } from '@ts6/common';

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
