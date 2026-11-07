import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  nextLogoutAuthRev,
  shouldApplyPeerAuthLogout,
  shouldBroadcastAuthLogout,
} from '../../src/stores/auth.store.ts';

describe('cross-tab logout relay policy', () => {
  it('propagates normal logout to an older peer tab', () => {
    // Sender wrote tombstone@6; persist no longer live; receiver memory still 4.
    assert.equal(shouldApplyPeerAuthLogout({
      originAuthRev: 6,
      localMemoryAuthRev: 4,
      persistedAuthRev: 6,
      persistedLive: false,
    }), true);
  });

  it('rejects stale logout that only beats a lagging receiver memory', () => {
    // Sender mem 5→6, receiver mem 4, shared live persist still at 7.
    assert.equal(shouldApplyPeerAuthLogout({
      originAuthRev: 6,
      localMemoryAuthRev: 4,
      persistedAuthRev: 7,
      persistedLive: true,
    }), false);
  });

  it('rejects stale logout when origin ties receiver memory but persist is newer', () => {
    assert.equal(shouldApplyPeerAuthLogout({
      originAuthRev: 6,
      localMemoryAuthRev: 6,
      persistedAuthRev: 7,
      persistedLive: true,
    }), false);
  });

  it('rejects when origin does not beat local memory after persist cleared', () => {
    assert.equal(shouldApplyPeerAuthLogout({
      originAuthRev: 5,
      localMemoryAuthRev: 5,
      persistedAuthRev: 5,
      persistedLive: false,
    }), false);
  });

  it('does not broadcast when the local tombstone failed to persist', () => {
    assert.equal(shouldBroadcastAuthLogout(true), false);
  });

  it('broadcasts when the tombstone cleared live persist', () => {
    assert.equal(shouldBroadcastAuthLogout(false), true);
  });

  it('legacy logout messages without authRev still apply', () => {
    assert.equal(shouldApplyPeerAuthLogout({
      originAuthRev: undefined,
      localMemoryAuthRev: 4,
      persistedAuthRev: 7,
      persistedLive: true,
    }), true);
  });

  it('same sessionKey with rotated refresh bumps past persist', () => {
    // Kody HIGH r4501516401: refresh inequality alone must NOT force memory-only.
    assert.equal(nextLogoutAuthRev({
      memoryRev: 5,
      memoryRefresh: 'R0',
      memorySessionKey: 'SK1',
      persistedRev: 6,
      persistedRefresh: 'R1',
      persistedSessionKey: 'SK1',
    }), 7);
  });

  it('documents that refresh-only discrimination failed the R0→R1 logout case', () => {
    const memoryRev = 5;
    const persistedRev = 6;
    const memoryRefresh = 'R0';
    const persistedRefresh = 'R1';
    // Pre-fix branch: different refresh → memory-only → tombstone 6 loses to live@6.
    const buggy = memoryRefresh === persistedRefresh
      ? Math.max(memoryRev, persistedRev) + 1
      : memoryRev + 1;
    assert.equal(buggy, 6);
    assert.equal(nextLogoutAuthRev({
      memoryRev,
      memoryRefresh,
      memorySessionKey: 'SK1',
      persistedRev,
      persistedRefresh,
      persistedSessionKey: 'SK1',
    }), 7);
  });

  it('legacy same-refresh without sessionKey still bumps past persist', () => {
    assert.equal(nextLogoutAuthRev({
      memoryRev: 5,
      memoryRefresh: 'R2',
      memorySessionKey: null,
      persistedRev: 6,
      persistedRefresh: 'R2',
      persistedSessionKey: null,
    }), 7);
  });

  it('new login (different sessionKey, same account) stays memory-only', () => {
    assert.equal(nextLogoutAuthRev({
      memoryRev: 5,
      memoryRefresh: 'R_old',
      memorySessionKey: 'SK_old',
      persistedRev: 7,
      persistedRefresh: 'R_new',
      persistedSessionKey: 'SK_new',
    }), 6);
  });

  it('different-account login (different sessionKey) stays memory-only', () => {
    assert.equal(nextLogoutAuthRev({
      memoryRev: 3,
      memoryRefresh: 'R_a',
      memorySessionKey: 'SK_a',
      persistedRev: 8,
      persistedRefresh: 'R_b',
      persistedSessionKey: 'SK_b',
    }), 4);
  });

  it('legacy different-refresh without sessionKey stays memory-only', () => {
    assert.equal(nextLogoutAuthRev({
      memoryRev: 5,
      memoryRefresh: 'R_old',
      memorySessionKey: null,
      persistedRev: 7,
      persistedRefresh: 'R_new',
      persistedSessionKey: null,
    }), 6);
  });
});
