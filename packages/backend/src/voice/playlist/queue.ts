export type RepeatMode = "off" | "track" | "queue";

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

export class PlayQueue<T extends { id: string } = QueueItem> {
  private items: T[] = [];
  private currentIndex = -1;
  private exhausted = false;
  private _shuffle = false;
  private _repeat: RepeatMode = "off";
  private shuffleOrder: number[] = [];
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

  add(item: T): void {
    this.items.push(item);
    if (this._shuffle) {
      // Insert among upcoming items so appending never changes the current track.
      const start = this.currentIndex + 1;
      const pos = start + Math.floor(Math.random() * (this.shuffleOrder.length - start + 1));
      this.shuffleOrder.splice(pos, 0, this.items.length - 1);
    }
    this.onChange?.(true);
  }

  addMany(items: T[]): void {
    for (const item of items) {
      this.add(item);
    }
  }

  /** Select a new request; cleanup restores the cursor only while that request owns it. */
  addForPlayback(item: T): () => void {
    const previous = this.getAll()[this.currentIndex];
    this.displaced.set(item, { previous, exhausted: this.exhausted });
    this.add(item);
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
        return null;
      }
    }

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

  setShuffle(enabled: boolean): void {
    if (enabled === this._shuffle) return;

    const currentUnderlying = this.currentIndex >= 0
      ? (this._shuffle ? this.shuffleOrder[this.currentIndex] : this.currentIndex)
      : -1;
    const currentPosition = this.currentIndex;

    if (enabled) {
      const order = Array.from({ length: this.items.length }, (_, i) => i)
        .filter(i => i !== currentUnderlying);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      if (currentUnderlying >= 0) {
        order.splice(Math.min(Math.max(currentPosition, 0), order.length), 0, currentUnderlying);
      }
      this.shuffleOrder = order;
      this._shuffle = true;
      return;
    }

    this._shuffle = false;
    this.shuffleOrder = [];
    this.currentIndex = currentUnderlying;
  }

  private regenerateShuffleOrder(): void {
    this.shuffleOrder = Array.from({ length: this.items.length }, (_, i) => i);
    // Fisher-Yates shuffle
    for (let i = this.shuffleOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.shuffleOrder[i], this.shuffleOrder[j]] = [this.shuffleOrder[j], this.shuffleOrder[i]];
    }
  }
}
