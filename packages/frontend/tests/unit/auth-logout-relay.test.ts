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

  it('same-session rev lag bumps past persist so logout can tombstone', () => {
    assert.equal(nextLogoutAuthRev({
      memoryRev: 5,
      memoryRefresh: 'R2',
      persistedRev: 6,
      persistedRefresh: 'R2',
    }), 7);
  });

  it('peer-replaced refresh stays memory-only so logout cannot wipe the peer', () => {
    assert.equal(nextLogoutAuthRev({
      memoryRev: 5,
      memoryRefresh: 'R_old',
      persistedRev: 7,
      persistedRefresh: 'R_new',
    }), 6);
  });
});
