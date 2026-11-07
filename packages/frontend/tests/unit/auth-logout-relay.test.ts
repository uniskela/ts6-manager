import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldApplyPeerAuthLogout,
  shouldBroadcastAuthLogout,
} from '../../src/stores/auth.store.ts';

describe('shouldApplyPeerAuthLogout / shouldBroadcastAuthLogout', () => {
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

  it('rejects stale logout when origin ties the receiver memory but persist is newer', () => {
    assert.equal(shouldApplyPeerAuthLogout({
      originAuthRev: 6,
      localMemoryAuthRev: 6,
      persistedAuthRev: 7,
      persistedLive: true,
    }), false);
  });

  it('rejects when origin does not beat local memory and persist is already cleared', () => {
    assert.equal(shouldApplyPeerAuthLogout({
      originAuthRev: 5,
      localMemoryAuthRev: 5,
      persistedAuthRev: 5,
      persistedLive: false,
    }), false);
  });

  it('legacy logout messages without authRev still apply', () => {
    assert.equal(shouldApplyPeerAuthLogout({
      originAuthRev: undefined,
      localMemoryAuthRev: 99,
      persistedAuthRev: 99,
      persistedLive: true,
    }), true);
  });

  it('does not broadcast when the local tombstone failed to persist', () => {
    assert.equal(shouldBroadcastAuthLogout(true), false);
  });

  it('broadcasts when the tombstone cleared live persist', () => {
    assert.equal(shouldBroadcastAuthLogout(false), true);
  });
});
