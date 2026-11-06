import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  AUTH_REFRESH_CHANNEL,
  broadcastAuthLogout,
  clearAuthRefreshCoordination,
  compareTabIds,
  coordinateRefreshOwnership,
  getAuthRefreshCoordinationEpoch,
  getAuthRefreshTabId,
  isPersistedRefreshAdoptionAllowed,
  pickRefreshOwner,
  resetAuthRefreshCoordForTests,
  setAuthRefreshPeerLogoutHandler,
} from '../../src/api/auth-refresh-coord.ts';

type Handler = (ev: { data: unknown }) => void;

class FakeBroadcastChannel {
  static rooms = new Map<string, Set<FakeBroadcastChannel>>();
  name: string;
  private handlers = new Set<Handler>();

  constructor(name: string) {
    this.name = name;
    if (!FakeBroadcastChannel.rooms.has(name)) FakeBroadcastChannel.rooms.set(name, new Set());
    FakeBroadcastChannel.rooms.get(name)!.add(this);
  }

  postMessage(data: unknown) {
    const peers = FakeBroadcastChannel.rooms.get(this.name) ?? new Set();
    for (const peer of peers) {
      if (peer === this) continue;
      for (const h of peer.handlers) h({ data });
    }
  }

  addEventListener(_type: string, handler: Handler) {
    this.handlers.add(handler);
  }

  removeEventListener(_type: string, handler: Handler) {
    this.handlers.delete(handler);
  }

  close() {
    FakeBroadcastChannel.rooms.get(this.name)?.delete(this);
    this.handlers.clear();
  }

  static reset() {
    FakeBroadcastChannel.rooms.clear();
  }
}

function postPeerResult(
  peer: FakeBroadcastChannel,
  opts: { tabId: string; accessToken: string; refreshToken: string },
) {
  peer.postMessage({
    v: 1,
    type: 'result',
    tabId: opts.tabId,
    ok: true,
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
  });
}

describe('BroadcastChannel refresh ownership helpers', () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
    resetAuthRefreshCoordForTests();
    (globalThis as { window?: unknown }).window = globalThis;
    (globalThis as { BroadcastChannel?: typeof FakeBroadcastChannel }).BroadcastChannel =
      FakeBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    resetAuthRefreshCoordForTests();
    FakeBroadcastChannel.reset();
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    delete (globalThis as { window?: unknown }).window;
  });

  it('pickRefreshOwner is deterministic under UTF-16 compare', () => {
    assert.equal(pickRefreshOwner(['t-b', 't-a', 't-c']), 't-a');
    assert.equal(compareTabIds('t-a', 't-b'), -1);
    assert.equal(pickRefreshOwner(['t-9', 't-10']), 't-10');
  });

  it('tab ids from getAuthRefreshTabId are unique across resets', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 64; i++) {
      resetAuthRefreshCoordForTests();
      (globalThis as { window?: unknown }).window = globalThis;
      ids.add(getAuthRefreshTabId());
    }
    assert.equal(ids.size, 64);
    for (const id of ids) {
      assert.match(id, /^t-[0-9a-f]{16}-[0-9a-z]+$/);
    }
  });

  it('single participant refreshes once', async () => {
    let networkCalls = 0;
    const pair = await coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'a1', refreshToken: 'r1' };
    });
    assert.equal(networkCalls, 1);
    assert.deepEqual(pair, { accessToken: 'a1', refreshToken: 'r1' });
  });

  it('logout clears cached result so a later cycle cannot reuse it', async () => {
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a1', refreshToken: 'r1' }));
    broadcastAuthLogout();
    let networkCalls = 0;
    const pair = await coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'a2', refreshToken: 'r2' };
    });
    assert.equal(networkCalls, 1);
    assert.deepEqual(pair, { accessToken: 'a2', refreshToken: 'r2' });
  });

  it('session replace clears cache without blocking a later same-tab refresh', async () => {
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a-old', refreshToken: 'r-old' }));
    clearAuthRefreshCoordination();
    let networkCalls = 0;
    const pair = await coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'a-new', refreshToken: 'r-new' };
    });
    assert.equal(networkCalls, 1);
    assert.deepEqual(pair, { accessToken: 'a-new', refreshToken: 'r-new' });
  });

  it('session replace during a pending wait does not restore prior-account tokens', async () => {
    setAuthRefreshPeerLogoutHandler(() => {});
    const peer = new FakeBroadcastChannel(AUTH_REFRESH_CHANNEL);
    peer.postMessage({ v: 1, type: 'leader', tabId: 't-prior-account' });
    let networkCalls = 0;
    const pending = coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'a-new', refreshToken: 'r-new' };
    });
    await new Promise((r) => setTimeout(r, 30));
    clearAuthRefreshCoordination();
    // Stale success from the prior account's leader after session replace.
    postPeerResult(peer, {
      tabId: 't-prior-account',
      accessToken: 'a-old',
      refreshToken: 'r-old',
    });
    const pair = await pending;
    assert.equal(pair, null);
    assert.equal(networkCalls, 0);
    peer.close();
  });

  it('same-account refresh cache still short-circuits within the TTL', async () => {
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a1', refreshToken: 'r1' }));
    let networkCalls = 0;
    const pair = await coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'a2', refreshToken: 'r2' };
    });
    assert.equal(networkCalls, 0);
    assert.deepEqual(pair, { accessToken: 'a1', refreshToken: 'r1' });
  });

  it('late peer success after session replace is ignored', async () => {
    setAuthRefreshPeerLogoutHandler(() => {});
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a-stale', refreshToken: 'r-stale' }));
    clearAuthRefreshCoordination('r-stale');
    const peer = new FakeBroadcastChannel(AUTH_REFRESH_CHANNEL);
    postPeerResult(peer, {
      tabId: 't-stale',
      accessToken: 'a-stale',
      refreshToken: 'r-stale',
    });
    let networkCalls = 0;
    const pair = await coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'a-fresh', refreshToken: 'r-fresh' };
    });
    assert.equal(networkCalls, 1);
    assert.deepEqual(pair, { accessToken: 'a-fresh', refreshToken: 'r-fresh' });
    peer.close();
  });

  it('first login without a prior refresh still accepts same-account peer results', async () => {
    setAuthRefreshPeerLogoutHandler(() => {});
    // Mimic setAuth on a cold login (previousRefreshToken null, empty cache).
    clearAuthRefreshCoordination(null);
    const peer = new FakeBroadcastChannel(AUTH_REFRESH_CHANNEL);
    postPeerResult(peer, {
      tabId: 't-peer',
      accessToken: 'a-peer',
      refreshToken: 'r-peer',
    });
    let networkCalls = 0;
    const pair = await coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'local', refreshToken: 'r-local' };
    });
    assert.equal(networkCalls, 0);
    assert.deepEqual(pair, { accessToken: 'a-peer', refreshToken: 'r-peer' });
    peer.close();
  });

  it('delayed prior-account R1 (rotated successor of R0) is not cached or adopted', async () => {
    setAuthRefreshPeerLogoutHandler(() => {});
    // Account A held R0; session replace blocks R0 and flips ignorePeerResults.
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a0', refreshToken: 'r0' }));
    clearAuthRefreshCoordination('r0');
    const peer = new FakeBroadcastChannel(AUTH_REFRESH_CHANNEL);
    // Account A's in-flight refresh completes with rotated R1 — not the blocked R0 string.
    postPeerResult(peer, {
      tabId: 't-account-a',
      accessToken: 'a1',
      refreshToken: 'r1',
    });
    let networkCalls = 0;
    const pair = await coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'b1', refreshToken: 'rb1' };
    });
    assert.equal(networkCalls, 1, 'must not short-circuit on prior-account R1');
    assert.deepEqual(pair, { accessToken: 'b1', refreshToken: 'rb1' });
    // R1 must stay rejected even after Account B has refreshed (blocked set).
    postPeerResult(peer, {
      tabId: 't-account-a',
      accessToken: 'a1-again',
      refreshToken: 'r1',
    });
    let secondCalls = 0;
    const second = await coordinateRefreshOwnership(async () => {
      secondCalls += 1;
      return { accessToken: 'b2', refreshToken: 'rb2' };
    });
    // Within TTL of B's own result — still B, never R1.
    assert.equal(secondCalls, 0);
    assert.deepEqual(second, { accessToken: 'b1', refreshToken: 'rb1' });
    peer.close();
  });

  it('same-account peer results still adopt after a local refresh', async () => {
    setAuthRefreshPeerLogoutHandler(() => {});
    clearAuthRefreshCoordination('r-prior');
    // Local refresh clears ignorePeerResults so same-account peers can share again.
    await coordinateRefreshOwnership(async () => ({ accessToken: 'local', refreshToken: 'r-local' }));
    const peer = new FakeBroadcastChannel(AUTH_REFRESH_CHANNEL);
    postPeerResult(peer, {
      tabId: 't-peer',
      accessToken: 'peer-a',
      refreshToken: 'peer-r',
    });
    let networkCalls = 0;
    const pair = await coordinateRefreshOwnership(async () => {
      networkCalls += 1;
      return { accessToken: 'should-not', refreshToken: 'nope' };
    });
    assert.equal(networkCalls, 0);
    assert.deepEqual(pair, { accessToken: 'peer-a', refreshToken: 'peer-r' });
    peer.close();
  });

  it('persist adoption is denied after session replace until local refresh', async () => {
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a0', refreshToken: 'r0' }));
    assert.equal(isPersistedRefreshAdoptionAllowed('r-other'), true);
    const epochBefore = getAuthRefreshCoordinationEpoch();
    clearAuthRefreshCoordination('r0');
    assert.ok(getAuthRefreshCoordinationEpoch() > epochBefore);
    assert.equal(isPersistedRefreshAdoptionAllowed('r-other'), false, 'ignore peer after replace');
    assert.equal(isPersistedRefreshAdoptionAllowed('r0'), false, 'blocked prior refresh');
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a1', refreshToken: 'r1' }));
    assert.equal(isPersistedRefreshAdoptionAllowed('r-peer'), true);
  });
});
