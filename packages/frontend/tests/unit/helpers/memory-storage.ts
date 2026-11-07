/** In-memory `localStorage` for Node auth-store unit tests. */
export class MemoryStorage implements Storage {
  #map = new Map<string, string>();
  /** When true, setItem for ts6-server throws (simulates quota / write failure). */
  rejectTs6ServerWrites = false;

  get length() {
    return this.#map.size;
  }

  clear() {
    this.#map.clear();
  }

  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }

  key(index: number) {
    return [...this.#map.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#map.delete(key);
  }

  setItem(key: string, value: string) {
    if (this.rejectTs6ServerWrites && key === 'ts6-server') {
      throw new Error('quota exceeded');
    }
    this.#map.set(key, String(value));
  }
}
