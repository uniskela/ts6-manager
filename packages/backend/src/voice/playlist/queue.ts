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

export class PlayQueue {
  private items: QueueItem[] = [];
  private currentIndex = -1;
  private _shuffle = false;
  private _repeat: RepeatMode = "off";
  private shuffleOrder: number[] = [];

  get current(): QueueItem | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.items.length) {
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

  getAll(): QueueItem[] {
    if (this._shuffle) {
      return this.shuffleOrder.map((i) => this.items[i]);
    }
    return [...this.items];
  }

  add(item: QueueItem): void {
    this.items.push(item);
    if (this._shuffle) {
      // Insert among upcoming items so appending never changes the current track.
      const start = this.currentIndex + 1;
      const pos = start + Math.floor(Math.random() * (this.shuffleOrder.length - start + 1));
      this.shuffleOrder.splice(pos, 0, this.items.length - 1);
    }
  }

  addMany(items: QueueItem[]): void {
    for (const item of items) {
      this.add(item);
    }
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

    return true;
  }

  clear(): void {
    this.items = [];
    this.currentIndex = -1;
    this.shuffleOrder = [];
  }

  next(): QueueItem | null {
    if (this.items.length === 0) return null;

    // Track repeat is handled by VoiceBot directly — here we just advance
    this.currentIndex++;

    if (this.currentIndex >= this.items.length) {
      if (this._repeat === "queue") {
        this.currentIndex = 0;
        if (this._shuffle) {
          this.regenerateShuffleOrder();
        }
      } else {
        this.currentIndex = -1;
        return null;
      }
    }

    return this.current;
  }

  playAt(index: number): QueueItem | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return null;
    this.currentIndex = index;
    return this.current;
  }

  previous(): QueueItem | null {
    if (this.items.length === 0) return null;

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

  move(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.items.length) return false;
    if (toIndex < 0 || toIndex >= this.items.length) return false;
    if (fromIndex === toIndex) return true;

    const [item] = this.items.splice(fromIndex, 1);
    this.items.splice(toIndex, 0, item);

    // Adjust currentIndex to follow the currently playing track
    if (this.currentIndex === fromIndex) {
      this.currentIndex = toIndex;
    } else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
      this.currentIndex--;
    } else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
      this.currentIndex++;
    }

    // Regenerate shuffle order since indices changed
    if (this._shuffle) {
      this.regenerateShuffleOrder();
    }

    return true;
  }

  setRepeat(mode: RepeatMode): void {
    this._repeat = mode;
  }

  setShuffle(enabled: boolean): void {
    this._shuffle = enabled;
    if (enabled) {
      this.regenerateShuffleOrder();
    }
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
