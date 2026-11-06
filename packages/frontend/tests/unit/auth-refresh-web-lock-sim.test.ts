/**
 * Simulated two-tab refresh under a Web Lock with shared localStorage.
 * Proves a stale in-memory token would look like replay, while re-reading
 * persist after lock acquisition keeps both tabs on one rotation chain.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readPersistedRefreshToken } from '../../src/api/client.ts';

type AuthBlob = {
  state: { accessToken: string; refreshToken: string };
};

function writeAuth(blob: AuthBlob) {
  localStorage.setItem('ts6-auth', JSON.stringify({ ...blob, version: 0 }));
}

describe('simulated cross-tab Web Lock refresh', () => {
  let store: Map<string, string>;
  let lockChain: Promise<void>;

  beforeEach(() => {
    store = new Map();
    lockChain = Promise.resolve();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, String(v));
      },
      removeItem: (k) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
  });

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lockChain;
    let release!: () => void;
    lockChain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  it('stale memory refresh under lock would present the pre-rotation token (bug class)', async () => {
    writeAuth({ state: { accessToken: 'a1', refreshToken: 'R1' } });
    const tabAMemory = { refreshToken: 'R1' };
    const tabBMemory = { refreshToken: 'R1' };
    const presented: string[] = [];

    await withLock(async () => {
      presented.push(tabAMemory.refreshToken);
      writeAuth({ state: { accessToken: 'a2', refreshToken: 'R2' } });
      tabAMemory.refreshToken = 'R2';
    });
    await withLock(async () => {
      // Bug: use memory only after peer rotation.
      presented.push(tabBMemory.refreshToken);
    });

    assert.deepEqual(presented, ['R1', 'R1']);
    assert.equal(readPersistedRefreshToken(), 'R2');
  });

  it('re-reading persist after lock acquisition uses the rotated token', async () => {
    writeAuth({ state: { accessToken: 'a1', refreshToken: 'R1' } });
    const tabAMemory = { refreshToken: 'R1' };
    const tabBMemory = { refreshToken: 'R1' };
    const presented: string[] = [];

    await withLock(async () => {
      presented.push(tabAMemory.refreshToken);
      writeAuth({ state: { accessToken: 'a2', refreshToken: 'R2' } });
      tabAMemory.refreshToken = 'R2';
    });
    await withLock(async () => {
      const latest = readPersistedRefreshToken() ?? tabBMemory.refreshToken;
      if (tabBMemory.refreshToken !== latest) tabBMemory.refreshToken = latest!;
      presented.push(tabBMemory.refreshToken);
    });

    assert.deepEqual(presented, ['R1', 'R2']);
    assert.notEqual(presented[1], 'R1', 'second tab must not replay R1 after peer rotate');
  });
});
