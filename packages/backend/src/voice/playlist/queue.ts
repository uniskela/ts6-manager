import { AppError } from "../../middleware/error-handler.js";

export type RepeatMode = "off" | "track" | "queue";

/** Most tracks one queue holds, played and waiting together. Every add path is checked against it. */
export const MAX_QUEUE_ITEMS = 5000;
/**
 * Played tracks kept behind the current one so `!prev` can step back. Older
 * ones are pruned on each advance, except under repeat-all, where they come round again.
 */
export const PLAYED_HISTORY_LIMIT = 50;

/** A request that does not fit under {@link MAX_QUEUE_ITEMS}; none of it was queued. */
export class QueueFullError extends AppError {
  constructor(readonly requested: number, readonly room: number) {
    super(
      409,
      requested > 1
        ? `The queue is full: only ${room} of these ${requested} tracks fit (limit ${MAX_QUEUE_ITEMS.toLocaleString("en-US")}), so none were queued.`
        : `The queue is full (limit ${MAX_QUEUE_ITEMS.toLocaleString("en-US")} tracks).`,
      "Remove some tracks or clear the queue, then try again.",
      { reason: "queue_full" },
    );
    this.name = "QueueFullError";
  }
}

/** Room held for a request whose tracks are added one at a time, such as a playlist link. */
export interface QueueReservation {
  readonly remaining: number;
  /** Give back what was not used. Safe to call more than once. */
  release(): void;
}

class Reservation implements QueueReservation {
  constructor(public remaining: number, private readonly onRelease: (reservation: Reservation) => void) {}

  release(): void {
    this.onRelease(this);
  }
}

export interface QueueItem {
  id: string;
  title: string;
  artist?: string;
  duration?: number; // seconds
  filePath: string;
  source: "local" | "youtube" | "url" | "radio";
  sourceUrl?: string;
  streamUrl?: string; // If set, play as live stream (radio) instead of file
}

function moveEntry<T>(list: T[], from: number, to: number): void {
  const [entry] = list.splice(from, 1);
  list.splice(to, 0, entry);
}

function shuffleInPlace(list: number[]): void {
  // Fisher-Yates shuffle
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}

export class PlayQueue<T extends { id: string } = QueueItem> {
  private items: T[] = [];
  private currentIndex = -1;
  private exhausted = false;
  private _shuffle = false;
  private _repeat: RepeatMode = "off";
  private shuffleOrder: number[] = [];
  private _pruned = 0;
  /** Slots held by open reservations; they count against {@link MAX_QUEUE_ITEMS}. */
  private reserved = 0;
  private readonly reservations = new Set<Reservation>();
  /** What each in-flight start displaced, so a later start can fall back past a start that was already rejected. */
  private readonly displaced = new WeakMap<object, { previous: T | undefined; exhausted: boolean }>();

  constructor(private readonly onChange?: (added: boolean) => void) {}

  get current(): T | null {
    if (this.exhausted || this.currentIndex < 0 || this.currentIndex >= this.items.length) {
      return null;
    }
    const idx = this._shuffle ? this.shuffleOrder[this.currentIndex] : this.currentIndex;
    return this.items[idx] ?? null;
  }

  get length(): number {
    return this.items.length;
  }

  get index(): number {
    return this.currentIndex;
  }

  get repeat(): RepeatMode {
    return this._repeat;
  }

  get shuffle(): boolean {
    return this._shuffle;
  }

  /** Played tracks pruned from the front since the last clear. Chat numbers add it so they stay stable. */
  get pruned(): number {
    return this._pruned;
  }

  /** Tracks that can still be added, after the room held by open reservations. */
  get room(): number {
    return Math.max(MAX_QUEUE_ITEMS - this.items.length - this.reserved, 0);
  }

  /** Throw a {@link QueueFullError} unless `count` more tracks fit. */
  assertRoom(count: number): void {
    if (count > this.room) throw new QueueFullError(count, this.room);
  }

  /**
   * Hold room for `count` tracks that arrive one at a time, so the request is
   * refused whole up front instead of stopping part way. Adds that pass the
   * reservation use its slots; clear() releases every reservation.
   */
  reserve(count: number): QueueReservation {
    this.assertRoom(count);
    const reservation = new Reservation(count, (r) => this.release(r));
    this.reservations.add(reservation);
    this.reserved += count;
    return reservation;
  }

  private release(reservation: Reservation): void {
    if (!this.reservations.delete(reservation)) return;
    this.reserved -= reservation.remaining;
    reservation.remaining = 0;
  }

  /** Use a reserved slot, or check the free room when there is none left. */
  private claim(reservation: QueueReservation | undefined): void {
    if (reservation instanceof Reservation && this.reservations.has(reservation) && reservation.remaining > 0) {
      reservation.remaining--;
      this.reserved--;
      if (reservation.remaining === 0) this.reservations.delete(reservation);
      return;
    }
    this.assertRoom(1);
  }

  getAll(): T[] {
    if (this._shuffle) {
      return this.shuffleOrder.map((i) => this.items[i]);
    }
    return [...this.items];
  }

  /** Tracks after the current index in display order (shuffle-aware). */
  upcoming(limit?: number): T[] {
    const all = this.getAll();
    const start = Math.max(this.currentIndex + 1, 0);
    return limit == null ? all.slice(start) : all.slice(start, start + limit);
  }

  get upcomingCount(): number {
    return Math.max(this.length - Math.max(this.currentIndex + 1, 0), 0);
  }

  /** Append one track; throws {@link QueueFullError} (changing nothing) when the queue is full. */
  add(item: T, reservation?: QueueReservation): void {
    this.claim(reservation);
    this.items.push(item);
    if (this._shuffle) {
      // Insert among upcoming items so appending never changes the current track.
      const start = this.currentIndex + 1;
      const pos = start + Math.floor(Math.random() * (this.shuffleOrder.length - start + 1));
      this.shuffleOrder.splice(pos, 0, this.items.length - 1);
    }
    this.onChange?.(true);
  }

  /** Append every track or, when they do not all fit, none of them. */
  addMany(items: T[]): void {
    this.assertRoom(items.length);
    for (const item of items) {
      this.add(item);
    }
  }

  /** Select a new request; cleanup restores the cursor only while that request owns it. */
  addForPlayback(item: T, reservation?: QueueReservation): () => void {
    const previous = this.getAll()[this.currentIndex];
    this.add(item, reservation);
    this.displaced.set(item, { previous, exhausted: this.exhausted });
    this.playAt(this.getAll().indexOf(item));
    return () => {
      const index = this.getAll().indexOf(item);
      if (index < 0) return;
      const restore = this.current === item;
      if (!this.removeAt(index) || !restore) return;
      // A start that overlapped an earlier, already rejected start displaced that
      // entry; walk back to the last track still queued.
      let base = this.displaced.get(item);
      let target = base?.previous;
      const seen = new Set<T>();
      while (base && target && !this.getAll().includes(target) && !seen.has(target)) {
        seen.add(target);
        base = this.displaced.get(target);
        target = base?.previous;
      }
      if (!base) return;
      if (!target) {
        this.currentIndex = -1;
        this.exhausted = base.exhausted;
        return;
      }
      const targetIndex = this.getAll().indexOf(target);
      if (targetIndex < 0) return;
      this.currentIndex = targetIndex;
      this.exhausted = base.exhausted;
    };
  }

  remove(id: string): boolean {
    const index = this.getAll().findIndex(item => item.id === id);
    return this.removeAt(index);
  }

  /** Remove a displayed queue position, including duplicate song IDs and shuffle. */
  removeAt(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return false;
    const idx = this._shuffle ? this.shuffleOrder[index] : index;

    this.items.splice(idx, 1);

    // Update shuffle order
    if (this._shuffle) {
      this.shuffleOrder = this.shuffleOrder
        .filter((i) => i !== idx)
        .map((i) => (i > idx ? i - 1 : i));
    }

    // Adjust current index
    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      this.currentIndex = Math.min(this.currentIndex, this.items.length - 1);
    }

    this.onChange?.(false);
    return true;
  }

  clear(): void {
    this.items = [];
    this.currentIndex = -1;
    this.exhausted = false;
    this.shuffleOrder = [];
    this._pruned = 0;
    for (const reservation of this.reservations) reservation.remaining = 0;
    this.reservations.clear();
    this.reserved = 0;
    this.onChange?.(false);
  }

  /** Keep every item and make the current one upcoming again. */
  rewind(): void {
    this.currentIndex = -1;
    this.exhausted = false;
  }

  next(): T | null {
    if (this.items.length === 0) return null;
    this.exhausted = false;

    // Track repeat is handled by VoiceBot directly — here we just advance
    this.currentIndex++;

    if (this.currentIndex >= this.items.length) {
      if (this._repeat === "queue") {
        this.currentIndex = 0;
        if (this._shuffle) {
          this.regenerateShuffleOrder();
        }
      } else {
        // Retain the exhausted position so a later request never replays history.
        this.currentIndex = this.items.length - 1;
        this.exhausted = true;
        this.prunePlayed();
        return null;
      }
    }

    this.prunePlayed();
    return this.current;
  }

  playAt(index: number): T | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return null;
    this.currentIndex = index;
    this.exhausted = false;
    return this.current;
  }

  previous(): T | null {
    if (this.items.length === 0) return null;
    this.exhausted = false;

    this.currentIndex--;
    if (this.currentIndex < 0) {
      if (this._repeat === "queue") {
        this.currentIndex = this.items.length - 1;
      } else {
        // The oldest kept track: stepping back further replays it.
        this.currentIndex = 0;
      }
    }

    return this.current;
  }

  /** Move a displayed queue position; with shuffle on, only the shuffled order changes. */
  move(fromIndex: number, toIndex: number): boolean {
    if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= this.items.length) return false;
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= this.items.length) return false;
    if (fromIndex === toIndex) return true;

    if (this._shuffle) moveEntry(this.shuffleOrder, fromIndex, toIndex);
    else moveEntry(this.items, fromIndex, toIndex);

    // Adjust currentIndex to follow the currently playing track
    if (this.currentIndex === fromIndex) {
      this.currentIndex = toIndex;
    } else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
      this.currentIndex--;
    } else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
      this.currentIndex++;
    }

    return true;
  }

  setRepeat(mode: RepeatMode): void {
    this._repeat = mode;
  }

  /**
   * Shuffle or unshuffle only what is still to play. Played tracks and the
   * current one keep their displayed positions, so nothing unplayed lands
   * behind the cursor (where it would be skipped and later pruned) and
   * nothing played comes back as upcoming.
   */
  setShuffle(enabled: boolean): void {
    if (enabled === this._shuffle) return;

    const display = this._shuffle ? this.shuffleOrder : this.items.map((_, i) => i);
    const kept = display.slice(0, Math.max(this.currentIndex + 1, 0));
    const rest = display.slice(kept.length);

    if (enabled) {
      shuffleInPlace(rest);
      this.shuffleOrder = [...kept, ...rest];
      this._shuffle = true;
      return;
    }

    rest.sort((a, b) => a - b);
    this.items = [...kept, ...rest].map((i) => this.items[i]);
    this._shuffle = false;
    this.shuffleOrder = [];
  }

  /**
   * Drop played tracks beyond {@link PLAYED_HISTORY_LIMIT}, oldest first in the
   * displayed order. Never under repeat-all, where every track comes round again.
   */
  private prunePlayed(): void {
    if (this._repeat === "queue") return;
    const excess = this.currentIndex - PLAYED_HISTORY_LIMIT;
    if (excess <= 0) return;

    if (this._shuffle) {
      const dropped = new Set(this.shuffleOrder.slice(0, excess));
      const renumbered: number[] = [];
      let next = 0;
      for (let i = 0; i < this.items.length; i++) renumbered[i] = dropped.has(i) ? -1 : next++;
      this.items = this.items.filter((_, i) => !dropped.has(i));
      this.shuffleOrder = this.shuffleOrder.slice(excess).map((i) => renumbered[i]);
    } else {
      this.items.splice(0, excess);
    }
    this.currentIndex -= excess;
    this._pruned += excess;
  }

  private regenerateShuffleOrder(): void {
    this.shuffleOrder = Array.from({ length: this.items.length }, (_, i) => i);
    shuffleInPlace(this.shuffleOrder);
  }
}
