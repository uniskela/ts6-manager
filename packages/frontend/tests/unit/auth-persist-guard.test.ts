import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldPersistAuthBlob } from '../../src/stores/auth.store.ts';

function blob(opts: {
  refresh: string | null;
  accessExp?: number;
  authRev?: number;
  userId?: number;
  accessToken?: string | null;
}) {
  const userId = opts.userId ?? 1;
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    id: userId,
    exp: opts.accessExp ?? 100,
  })).toString('base64url');
  const accessToken = opts.accessToken !== undefined
    ? opts.accessToken
    : (opts.refresh ? `${header}.${payload}.t` : null);
  return JSON.stringify({
    state: {
      accessToken,
      refreshToken: opts.refresh,
      user: opts.refresh
        ? { id: userId, username: `u${userId}`, displayName: 'U', role: 'admin' }
        : null,
      authRev: opts.authRev ?? 0,
    },
    version: 0,
  });
}

const cleared = (authRev: number) => JSON.stringify({
  state: { accessToken: null, refreshToken: null, user: null, authRev },
  version: 0,
});

describe('shouldPersistAuthBlob', () => {
  it('allows the first write', () => {
    assert.equal(shouldPersistAuthBlob(null, blob({ refresh: 'R1', authRev: 1 })), true);
  });

  it('allows same-refresh updates without requiring a newer authRev', () => {
    assert.equal(
      shouldPersistAuthBlob(
        blob({ refresh: 'R1', accessExp: 100, authRev: 2 }),
        blob({ refresh: 'R1', accessExp: 90, authRev: 2 }),
      ),
      true,
    );
  });

  it('blocks a stale tab from rewinding a newer peer rotation', () => {
    const peer = blob({ refresh: 'R2', accessExp: 200, authRev: 3 });
    const stale = blob({ refresh: 'R1', accessExp: 100, authRev: 2 });
    assert.equal(shouldPersistAuthBlob(peer, stale), false);
  });

  it('blocks equal-expiry stale writes when authRev is older', () => {
    const peer = blob({ refresh: 'R2', accessExp: 100, authRev: 5 });
    const stale = blob({ refresh: 'R1', accessExp: 100, authRev: 4 });
    assert.equal(shouldPersistAuthBlob(peer, stale), false);
  });

  it('allows a newer rotation to replace an older one even with equal JWT exp', () => {
    assert.equal(
      shouldPersistAuthBlob(
        blob({ refresh: 'R1', accessExp: 100, authRev: 1 }),
        blob({ refresh: 'R2', accessExp: 100, authRev: 2 }),
      ),
      true,
    );
  });

  it('allows account switch when the incoming login has a newer authRev', () => {
    assert.equal(
      shouldPersistAuthBlob(
        blob({ refresh: 'Ra', accessExp: 500, authRev: 2, userId: 1 }),
        blob({ refresh: 'Rb', accessExp: 50, authRev: 3, userId: 2 }),
      ),
      true,
    );
  });

  it('blocks a delayed prior-account write after session replacement', () => {
    assert.equal(
      shouldPersistAuthBlob(
        blob({ refresh: 'Rb', accessExp: 50, authRev: 3, userId: 2 }),
        blob({ refresh: 'Ra', accessExp: 500, authRev: 2, userId: 1 }),
      ),
      false,
    );
  });

  it('allows logout to clear tokens', () => {
    assert.equal(shouldPersistAuthBlob(blob({ refresh: 'R2', authRev: 4 }), cleared(5)), true);
  });

  it('blocks restore over a logout tombstone with an older authRev', () => {
    assert.equal(
      shouldPersistAuthBlob(cleared(5), blob({ refresh: 'R1', accessExp: 100, authRev: 4 })),
      false,
    );
  });

  it('allows login after logout when authRev advances', () => {
    assert.equal(
      shouldPersistAuthBlob(cleared(5), blob({ refresh: 'R1', accessExp: 100, authRev: 6 })),
      true,
    );
  });

  it('fails open on malformed persist data so first-time sign-in is not blocked', () => {
    assert.equal(shouldPersistAuthBlob('not-json', blob({ refresh: 'R1', authRev: 1 })), true);
    assert.equal(shouldPersistAuthBlob(blob({ refresh: 'R2', authRev: 2 }), 'not-json'), true);
  });
});
