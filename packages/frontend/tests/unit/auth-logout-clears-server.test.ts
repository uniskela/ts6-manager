import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

class MemoryStorage implements Storage {
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

describe('auth logout clears server selection', () => {
  let storage: MemoryStorage;
  let useAuthStore: typeof import('../../src/stores/auth.store.ts').useAuthStore;
  let useServerStore: typeof import('../../src/stores/server.store.ts').useServerStore;

  before(async () => {
    // Zustand persist only writes when `window` looks like a browser.
    storage = new MemoryStorage();
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
    storage.rejectTs6ServerWrites = false;
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

  it('clears auth even when clearServer persist throws', () => {
    useServerStore.getState().setServer(7, 2);
    useAuthStore.getState().setAuth('access', 'refresh', {
      id: 1,
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
    });

    const originalClear = useServerStore.getState().clearServer;
    useServerStore.setState({
      clearServer: () => {
        throw new Error('quota exceeded');
      },
    });

    try {
      // logout must not throw so navigate('/login') / refresh callers still run
      assert.doesNotThrow(() => useAuthStore.getState().logout());
      assert.equal(useAuthStore.getState().accessToken, null);
      assert.equal(useAuthStore.getState().refreshToken, null);
      assert.equal(useAuthStore.getState().user, null);
      // Selection may remain if clearServer never ran successfully.
      assert.equal(useServerStore.getState().selectedConfigId, 7);
      assert.equal(useServerStore.getState().selectedSid, 2);
    } finally {
      useServerStore.setState({ clearServer: originalClear });
    }
  });

  it('removes stale ts6-server when persist write fails after clear', () => {
    useServerStore.getState().setServer(7, 2);
    useAuthStore.getState().setAuth('access', 'refresh', {
      id: 1,
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
    });
    assert.ok(localStorage.getItem('ts6-server'), 'seeded persist key');

    // Reject writes (clearServer persist) but still allow removeItem (clearStorage).
    storage.rejectTs6ServerWrites = true;

    assert.doesNotThrow(() => useAuthStore.getState().logout());
    assert.equal(useAuthStore.getState().accessToken, null);
    assert.equal(useServerStore.getState().selectedConfigId, null);
    assert.equal(useServerStore.getState().selectedSid, null);
    assert.equal(localStorage.getItem('ts6-server'), null);
  });
});
