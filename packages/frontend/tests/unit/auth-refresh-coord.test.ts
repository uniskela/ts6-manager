import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  coordinateRefreshOwnership,
  pickRefreshOwner,
  resetAuthRefreshCoordForTests,
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
});
