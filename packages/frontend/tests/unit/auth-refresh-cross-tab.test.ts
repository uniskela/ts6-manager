/**
 * Cross-tab refresh: Web Lock must use the persisted refresh token, not a
 * stale in-memory copy left after another tab rotated.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readPersistedRefreshToken } from '../../src/api/client.ts';

describe('cross-tab refresh token persistence', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: (k) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
  });

  it('reads the refresh token written by a peer tab into ts6-auth', () => {
    localStorage.setItem(
      'ts6-auth',
      JSON.stringify({
        state: {
          accessToken: 'access-a',
          refreshToken: 'refresh-from-peer-tab',
          user: { id: 1, username: 'a', displayName: 'A', role: 'admin' },
        },
        version: 0,
      }),
    );
    assert.equal(readPersistedRefreshToken(), 'refresh-from-peer-tab');
  });

  it('returns null when persist blob is missing or malformed', () => {
    assert.equal(readPersistedRefreshToken(), null);
    localStorage.setItem('ts6-auth', '{not-json');
    assert.equal(readPersistedRefreshToken(), null);
    localStorage.setItem('ts6-auth', JSON.stringify({ state: { refreshToken: '' } }));
    assert.equal(readPersistedRefreshToken(), null);
  });
});
