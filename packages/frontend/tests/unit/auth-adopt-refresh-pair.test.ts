import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyAdoptedRefreshPair } from '../../src/api/client.ts';
import { shouldPersistAuthBlob } from '../../src/stores/auth.store.ts';

/**
 * Reproduction of Kody HIGH (discussion_r4501390323):
 * inverted `prev !== pair.refreshToken → setTokens` made every follower bump
 * authRev above the leader, so the leader's later same-refresh persists lost.
 */
function buggyFollowerApply(
  memoryRefresh: string,
  pair: { accessToken: string; refreshToken: string },
  memoryAuthRev: number,
  persistedAuthRev: number,
): number {
  // Old client.ts branch (inverted).
  if (memoryRefresh !== pair.refreshToken) {
    return Math.max(memoryAuthRev, persistedAuthRev) + 1;
  }
  return Math.max(memoryAuthRev, persistedAuthRev);
}

describe('applyAdoptedRefreshPair', () => {
  it('does not inflate authRev when adopting a peer rotation', () => {
    // Leader rotated memory/persist to 6; follower still at 5 with old refresh.
    const next = applyAdoptedRefreshPair(
      { accessToken: 'a1', refreshToken: 'R1' },
      { memoryAuthRev: 5, persistedAuthRev: 6 },
    );
    assert.equal(next.authRev, 6);
    assert.equal(next.refreshToken, 'R1');
  });

  it('keeps the higher of memory and persist without +1', () => {
    assert.equal(applyAdoptedRefreshPair(
      { accessToken: 'a', refreshToken: 'r' },
      { memoryAuthRev: 8, persistedAuthRev: 6 },
    ).authRev, 8);
    assert.equal(applyAdoptedRefreshPair(
      { accessToken: 'a', refreshToken: 'r' },
      { memoryAuthRev: 3, persistedAuthRev: 3 },
    ).authRev, 3);
  });

  it('repeated follower adopts stay at the leader revision', () => {
    let rev = 4;
    for (let i = 0; i < 5; i++) {
      rev = applyAdoptedRefreshPair(
        { accessToken: `a${i}`, refreshToken: 'R_leader' },
        { memoryAuthRev: rev, persistedAuthRev: 7 },
      ).authRev;
    }
    assert.equal(rev, 7);
  });

  it('documents that the inverted setTokens branch inflated each follower', () => {
    const leaderRev = 6;
    assert.equal(
      buggyFollowerApply('R0', { accessToken: 'a1', refreshToken: 'R1' }, 5, leaderRev),
      7,
      'old branch bumped past the leader',
    );
    assert.equal(
      applyAdoptedRefreshPair(
        { accessToken: 'a1', refreshToken: 'R1' },
        { memoryAuthRev: 5, persistedAuthRev: leaderRev },
      ).authRev,
      leaderRev,
    );
  });

  it('multi-follower buggy path keeps climbing; fixed path stays flat', () => {
    const leaderRev = 10;
    let buggy = 9;
    let fixed = 9;
    for (let i = 0; i < 3; i++) {
      buggy = buggyFollowerApply('R_old', { accessToken: 'a', refreshToken: 'R_new' }, buggy, leaderRev);
      fixed = applyAdoptedRefreshPair(
        { accessToken: 'a', refreshToken: 'R_new' },
        { memoryAuthRev: fixed, persistedAuthRev: leaderRev },
      ).authRev;
    }
    assert.equal(buggy, 13);
    assert.equal(fixed, 10);
  });
});

describe('follower adopt vs leader same-refresh persist', () => {
  function jwt(id: number, exp = 9_999_999_999) {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id, exp })).toString('base64url');
    return `${header}.${payload}.t`;
  }

  function liveBlob(refresh: string, authRev: number, access = jwt(1)) {
    return JSON.stringify({
      state: {
        accessToken: access,
        refreshToken: refresh,
        user: { id: 1, username: 'u', displayName: 'U', role: 'admin' },
        authRev,
      },
      version: 0,
    });
  }

  it('leader same-refresh setUser still persists after followers adopt without inflation', () => {
    const access1 = jwt(1);
    const access2 = jwt(1);
    const leaderPersist = liveBlob('R1', 6, access1);

    // Three followers adopt R1 at persist rev 6 (no +1 each).
    for (let i = 0; i < 3; i++) {
      const adopted = applyAdoptedRefreshPair(
        { accessToken: access1, refreshToken: 'R1' },
        { memoryAuthRev: 5, persistedAuthRev: 6 },
      );
      assert.equal(adopted.authRev, 6);
      assert.equal(shouldPersistAuthBlob(leaderPersist, liveBlob(adopted.refreshToken, adopted.authRev, adopted.accessToken)), true);
    }

    // Leader later flushes access-only / setUser at the same refresh + rev.
    const leaderLater = JSON.stringify({
      state: {
        accessToken: access2,
        refreshToken: 'R1',
        user: { id: 1, username: 'u', displayName: 'Updated', role: 'admin' },
        authRev: 6,
      },
      version: 0,
    });
    assert.equal(
      shouldPersistAuthBlob(leaderPersist, leaderLater),
      true,
      'leader same-refresh persist must remain valid when followers did not inflate',
    );

    // Contrast: if followers had inflated to 9, leader@6 would be rejected.
    assert.equal(shouldPersistAuthBlob(liveBlob('R1', 9, access1), leaderLater), false);
  });

  it('delayed stale follower with older refresh cannot overwrite the leader pair', () => {
    const live = liveBlob('R_live', 8);
    const staleAdopt = applyAdoptedRefreshPair(
      { accessToken: jwt(1), refreshToken: 'R_stale' },
      { memoryAuthRev: 4, persistedAuthRev: 8 },
    );
    assert.equal(staleAdopt.authRev, 8);
    assert.equal(
      shouldPersistAuthBlob(live, liveBlob(staleAdopt.refreshToken, staleAdopt.authRev, staleAdopt.accessToken)),
      false,
    );
  });
});
