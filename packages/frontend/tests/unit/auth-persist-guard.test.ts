import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldPersistAuthBlob } from '../../src/stores/auth.store.ts';

function blob(accessExp: number, refresh: string | null) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ id: 1, exp: accessExp })).toString('base64url');
  return JSON.stringify({
    state: {
      accessToken: refresh ? `${header}.${payload}.t` : null,
      refreshToken: refresh,
      user: { id: 1, username: 'a', displayName: 'A', role: 'admin' },
    },
    version: 0,
  });
}

describe('shouldPersistAuthBlob', () => {
  it('allows the first write', () => {
    assert.equal(shouldPersistAuthBlob(null, blob(100, 'R1')), true);
  });

  it('allows same-refresh updates', () => {
    assert.equal(shouldPersistAuthBlob(blob(100, 'R1'), blob(90, 'R1')), true);
  });

  it('blocks a stale tab from rewinding a newer peer rotation', () => {
    const peer = blob(200, 'R2');
    const stale = blob(100, 'R1');
    assert.equal(shouldPersistAuthBlob(peer, stale), false);
  });

  it('allows a newer rotation to replace an older one', () => {
    assert.equal(shouldPersistAuthBlob(blob(100, 'R1'), blob(200, 'R2')), true);
  });

  it('allows logout to clear tokens', () => {
    const cleared = JSON.stringify({
      state: { accessToken: null, refreshToken: null, user: null },
      version: 0,
    });
    assert.equal(shouldPersistAuthBlob(blob(200, 'R2'), cleared), true);
  });
});
