import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  AUTH_REFRESH_CHANNEL,
  broadcastAuthLogout,
  clearAuthRefreshCoordination,
  coordinateRefreshOwnership,
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

  it('pickRefreshOwner is deterministic', () => {
    assert.equal(pickRefreshOwner(['t-b', 't-a', 't-c']), 't-a');
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
    peer.postMessage({
      v: 1,
      type: 'result',
      tabId: 't-prior-account',
      ok: true,
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
    clearAuthRefreshCoordination();
    const peer = new FakeBroadcastChannel(AUTH_REFRESH_CHANNEL);
    peer.postMessage({
      v: 1,
      type: 'result',
      tabId: 't-stale',
      ok: true,
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
});
