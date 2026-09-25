import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

class MemoryStorage implements Storage {
  #map = new Map<string, string>();

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
    this.#map.set(key, String(value));
  }
}

describe('auth logout clears server selection', () => {
  let useAuthStore: typeof import('../../src/stores/auth.store.ts').useAuthStore;
  let useServerStore: typeof import('../../src/stores/server.store.ts').useServerStore;

  before(async () => {
    // Zustand persist only writes when `window` looks like a browser.
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: storage },
    });
    ({ useAuthStore } = await import('../../src/stores/auth.store.ts'));
    ({ useServerStore } = await import('../../src/stores/server.store.ts'));
  });

  beforeEach(() => {
    useServerStore.setState({ selectedConfigId: null, selectedSid: null });
    useAuthStore.setState({ accessToken: null, refreshToken: null, user: null });
    localStorage.clear();
  });

  it('clears selectedConfigId and selectedSid when logout runs', () => {
    useServerStore.getState().setServer(7, 2);
    useAuthStore.getState().setAuth('access', 'refresh', {
      id: 1,
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
    });

    assert.equal(useServerStore.getState().selectedConfigId, 7);
    assert.equal(useServerStore.getState().selectedSid, 2);

    useAuthStore.getState().logout();

    assert.equal(useAuthStore.getState().accessToken, null);
    assert.equal(useAuthStore.getState().refreshToken, null);
    assert.equal(useAuthStore.getState().user, null);
    assert.equal(useServerStore.getState().selectedConfigId, null);
    assert.equal(useServerStore.getState().selectedSid, null);

    const raw = localStorage.getItem('ts6-server');
    assert.ok(raw, 'expected ts6-server persist key');
    const parsed = JSON.parse(raw) as {
      state?: { selectedConfigId: number | null; selectedSid: number | null };
    };
    assert.equal(parsed.state?.selectedConfigId, null);
    assert.equal(parsed.state?.selectedSid, null);
  });
});
