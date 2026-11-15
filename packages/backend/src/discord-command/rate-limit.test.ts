import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FairCommandRateLimit, MemoryCommandRateLimit } from './rate-limit.js';

describe('MemoryCommandRateLimit', () => {
  it('enforces a sliding window per key', () => {
    const lim = new MemoryCommandRateLimit(2, 1_000);
    assert.equal(lim.take('g:u', 100), true);
    assert.equal(lim.take('g:u', 200), true);
    assert.equal(lim.take('g:u', 300), false);
    assert.equal(lim.take('g:u', 1_200), true);
  });

  it('bounds the key map and still admits new keys', () => {
    const lim = new MemoryCommandRateLimit(1, 60_000, 2);
    assert.equal(lim.take('a:1', 1), true);
    assert.equal(lim.take('b:1', 2), true);
    assert.equal(lim.size(), 2);
    assert.equal(lim.take('c:1', 3), true);
    assert.ok(lim.size() <= 2);
  });
});

describe('FairCommandRateLimit', () => {
  it('rejects when the per-guild flood cap is hit even if the user is under limit', () => {
    const lim = new FairCommandRateLimit(
      new MemoryCommandRateLimit(10, 60_000),
      new MemoryCommandRateLimit(2, 60_000),
    );
    assert.equal(lim.take('guild:u1', 1), true);
    assert.equal(lim.take('guild:u2', 2), true);
    assert.equal(lim.take('guild:u3', 3), false);
  });
});
