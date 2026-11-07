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

function seedPersist(refresh: string, authRev: number, userId = 1) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ id: userId, exp: 9_999_999_999 })).toString('base64url');
  localStorage.setItem('ts6-auth', JSON.stringify({
    state: {
      accessToken: `${header}.${payload}.t`,
      refreshToken: refresh,
      user: { id: userId, username: `u${userId}`, displayName: 'U', role: 'admin' },
      authRev,
    },
    version: 0,
  }));
}

describe('authRev bump observes persist', () => {
  let storage: MemoryStorage;
  let useAuthStore: typeof import('../../src/stores/auth.store.ts').useAuthStore;
  let readPersistedAuthRev: typeof import('../../src/stores/auth.store.ts').readPersistedAuthRev;

  before(async () => {
    storage = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: storage },
    });
    ({ useAuthStore, readPersistedAuthRev } = await import('../../src/stores/auth.store.ts'));
  });

  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      authRev: 0,
    });
  });

  it('login bumps past persisted rev when memory lags a peer advance', () => {
    seedPersist('R_peer', 10, 2);
    assert.equal(readPersistedAuthRev(), 10);
    useAuthStore.setState({ authRev: 3 });

    useAuthStore.getState().setAuth('a.b.c', 'R_login', {
      id: 9,
      username: 'fresh',
      displayName: 'Fresh',
      role: 'admin',
    });

    assert.equal(useAuthStore.getState().authRev, 11);
    assert.equal(useAuthStore.getState().refreshToken, 'R_login');
    assert.equal(JSON.parse(localStorage.getItem('ts6-auth')!).state.refreshToken, 'R_login');
    assert.equal(JSON.parse(localStorage.getItem('ts6-auth')!).state.authRev, 11);
  });

  it('rotation bumps past persisted rev so equal-base tabs do not silently drop', () => {
    seedPersist('R0', 5);
    useAuthStore.setState({
      accessToken: 'old.access',
      refreshToken: 'R0',
      authRev: 5,
      user: { id: 1, username: 'u', displayName: 'U', role: 'admin' },
    });
    // Peer already rotated in storage while this tab still holds R0 @ 5 in memory.
    seedPersist('R_peer', 6);

    useAuthStore.getState().setTokens('new.access', 'R_local');

    assert.equal(useAuthStore.getState().authRev, 7);
    assert.equal(JSON.parse(localStorage.getItem('ts6-auth')!).state.authRev, 7);
    assert.equal(JSON.parse(localStorage.getItem('ts6-auth')!).state.refreshToken, 'R_local');
  });

  it('stale logout does not wipe a newer persisted peer login', () => {
    seedPersist('R_new', 7, 2);
    useAuthStore.setState({
      accessToken: 'stale.access',
      refreshToken: 'R_old',
      authRev: 3,
      user: { id: 1, username: 'old', displayName: 'Old', role: 'admin' },
    });

    useAuthStore.getState().logout();

    assert.equal(useAuthStore.getState().refreshToken, null);
    assert.equal(useAuthStore.getState().authRev, 4);
    const persisted = JSON.parse(localStorage.getItem('ts6-auth')!);
    assert.equal(persisted.state.refreshToken, 'R_new');
    assert.equal(persisted.state.authRev, 7);
  });

  it('stale logout one rev behind a peer rotation does not wipe the peer', () => {
    seedPersist('R_peer', 6);
    useAuthStore.setState({
      accessToken: 'stale.access',
      refreshToken: 'R_old',
      authRev: 5,
      user: { id: 1, username: 'old', displayName: 'Old', role: 'admin' },
    });

    useAuthStore.getState().logout();

    assert.equal(useAuthStore.getState().authRev, 6);
    const persisted = JSON.parse(localStorage.getItem('ts6-auth')!);
    assert.equal(persisted.state.refreshToken, 'R_peer');
    assert.equal(persisted.state.authRev, 6);
  });

  it('same-tab logout still tombstones its own session', () => {
    seedPersist('R1', 4);
    useAuthStore.setState({
      accessToken: 'a.b.c',
      refreshToken: 'R1',
      authRev: 4,
      user: { id: 1, username: 'u', displayName: 'U', role: 'admin' },
    });

    useAuthStore.getState().logout();

    const persisted = JSON.parse(localStorage.getItem('ts6-auth')!);
    assert.equal(persisted.state.refreshToken, null);
    assert.equal(persisted.state.accessToken, null);
    assert.equal(persisted.state.authRev, 5);
  });
});
