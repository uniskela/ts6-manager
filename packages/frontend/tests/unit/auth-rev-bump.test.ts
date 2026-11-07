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

function seedPersist(refresh: string, authRev: number, userId = 1, sessionKey: string | null = 'SK1') {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ id: userId, exp: 9_999_999_999 })).toString('base64url');
  localStorage.setItem('ts6-auth', JSON.stringify({
    state: {
      accessToken: `${header}.${payload}.t`,
      refreshToken: refresh,
      user: { id: userId, username: `u${userId}`, displayName: 'U', role: 'admin' },
      authRev,
      sessionKey,
    },
    version: 0,
  }));
}

function persistState() {
  return JSON.parse(localStorage.getItem('ts6-auth')!).state as {
    accessToken: string | null;
    refreshToken: string | null;
    authRev: number;
    sessionKey: string | null;
  };
}

/** Lagging memory vs peer persist — shared setup for logout lineage tests. */
function seedLaggingLogout(opts: {
  useAuthStore: typeof import('../../src/stores/auth.store.ts').useAuthStore;
  persistRefresh: string;
  persistRev: number;
  persistKey: string | null;
  memoryRefresh: string;
  memoryRev: number;
  memoryKey: string | null;
  persistUserId?: number;
  memoryUserId?: number;
}) {
  const persistUserId = opts.persistUserId ?? 1;
  const memoryUserId = opts.memoryUserId ?? persistUserId;
  seedPersist(opts.persistRefresh, opts.persistRev, persistUserId, opts.persistKey);
  opts.useAuthStore.setState({
    accessToken: 'stale.access',
    refreshToken: opts.memoryRefresh,
    authRev: opts.memoryRev,
    sessionKey: opts.memoryKey,
    user: {
      id: memoryUserId,
      username: memoryUserId === 1 ? 'u' : 'old',
      displayName: memoryUserId === 1 ? 'U' : 'Old',
      role: 'admin',
    },
  });
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
      sessionKey: null,
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

  it('stale logout does not wipe a newer persisted peer login (different account)', () => {
    seedLaggingLogout({
      useAuthStore,
      persistRefresh: 'R_new',
      persistRev: 7,
      persistKey: 'SK_peer',
      persistUserId: 2,
      memoryRefresh: 'R_old',
      memoryRev: 3,
      memoryKey: 'SK_old',
      memoryUserId: 1,
    });
    useAuthStore.getState().logout();
    assert.equal(useAuthStore.getState().refreshToken, null);
    assert.equal(useAuthStore.getState().authRev, 4);
    assert.equal(persistState().refreshToken, 'R_new');
    assert.equal(persistState().authRev, 7);
  });

  it('logout after peer rotation with same sessionKey tombstones the successor', () => {
    // Tab B rotated R0→R1 @ rev 6; Tab A still holds R0 @ rev 5, same lineage.
    seedLaggingLogout({
      useAuthStore,
      persistRefresh: 'R_peer',
      persistRev: 6,
      persistKey: 'SK1',
      memoryRefresh: 'R_old',
      memoryRev: 5,
      memoryKey: 'SK1',
    });
    useAuthStore.getState().logout();
    assert.equal(useAuthStore.getState().authRev, 7);
    const p = persistState();
    assert.equal(p.refreshToken, null);
    assert.equal(p.accessToken, null);
    assert.equal(p.authRev, 7);
    assert.equal(p.sessionKey, null);
  });

  it('stale logout after same-account new login does not wipe the new session', () => {
    // Account IDs match; sessionKey must decide lineage, not user id.
    seedLaggingLogout({
      useAuthStore,
      persistRefresh: 'R_new',
      persistRev: 7,
      persistKey: 'SK_new',
      memoryRefresh: 'R_old',
      memoryRev: 5,
      memoryKey: 'SK_old',
    });
    useAuthStore.getState().logout();
    assert.equal(useAuthStore.getState().authRev, 6);
    assert.equal(persistState().refreshToken, 'R_new');
    assert.equal(persistState().authRev, 7);
    assert.equal(persistState().sessionKey, 'SK_new');
  });

  it('same-tab logout still tombstones its own session', () => {
    seedLaggingLogout({
      useAuthStore,
      persistRefresh: 'R1',
      persistRev: 4,
      persistKey: 'SK1',
      memoryRefresh: 'R1',
      memoryRev: 4,
      memoryKey: 'SK1',
    });
    useAuthStore.setState({ accessToken: 'a.b.c' });
    useAuthStore.getState().logout();
    const p = persistState();
    assert.equal(p.refreshToken, null);
    assert.equal(p.accessToken, null);
    assert.equal(p.authRev, 5);
  });

  it('login after a peer logout tombstone advances past the tombstone rev', () => {
    localStorage.setItem('ts6-auth', JSON.stringify({
      state: { accessToken: null, refreshToken: null, user: null, authRev: 5 },
      version: 0,
    }));
    useAuthStore.setState({ authRev: 5 });

    useAuthStore.getState().setAuth('a.b.c', 'R_after', {
      id: 3,
      username: 'again',
      displayName: 'Again',
      role: 'admin',
    });

    assert.equal(useAuthStore.getState().authRev, 6);
    assert.equal(JSON.parse(localStorage.getItem('ts6-auth')!).state.refreshToken, 'R_after');
    assert.equal(JSON.parse(localStorage.getItem('ts6-auth')!).state.authRev, 6);
  });

  it('account switch bumps past the prior account persist rev', () => {
    seedPersist('Ra', 4, 1);
    useAuthStore.setState({
      accessToken: 'a.old',
      refreshToken: 'Ra',
      authRev: 4,
      user: { id: 1, username: 'a', displayName: 'A', role: 'admin' },
    });

    useAuthStore.getState().setAuth('a.new', 'Rb', {
      id: 2,
      username: 'b',
      displayName: 'B',
      role: 'admin',
    });

    assert.equal(useAuthStore.getState().authRev, 5);
    assert.equal(useAuthStore.getState().user?.id, 2);
    assert.equal(JSON.parse(localStorage.getItem('ts6-auth')!).state.refreshToken, 'Rb');
  });

  it('same-session logout with lagging memory rev still clears persist', () => {
    // Same refresh R2 already at persist@6; this tab still holds R2 @ memory 5.
    seedLaggingLogout({
      useAuthStore,
      persistRefresh: 'R2',
      persistRev: 6,
      persistKey: 'SK1',
      memoryRefresh: 'R2',
      memoryRev: 5,
      memoryKey: 'SK1',
    });
    useAuthStore.setState({ accessToken: 'lag.access' });
    useAuthStore.getState().logout();
    assert.equal(useAuthStore.getState().authRev, 7);
    assert.equal(persistState().refreshToken, null);
    assert.equal(persistState().authRev, 7);
  });

  it('setAuth mints a new sessionKey; setTokens keeps it across rotation', () => {
    useAuthStore.getState().setAuth('a.b.c', 'R0', {
      id: 1,
      username: 'u',
      displayName: 'U',
      role: 'admin',
    });
    const key = useAuthStore.getState().sessionKey;
    assert.ok(key);
    useAuthStore.getState().setTokens('a2.b2.c2', 'R1');
    assert.equal(useAuthStore.getState().sessionKey, key);
    assert.equal(JSON.parse(localStorage.getItem('ts6-auth')!).state.sessionKey, key);
  });
});
