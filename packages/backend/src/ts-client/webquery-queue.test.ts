import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isFloodError } from './webquery-client.js';
import { TSApiError } from '../middleware/error-handler.js';

/**
 * Unit tests for WebQuery queue helpers (priority pick + flood detection).
 * Full client pump tests need a live TS server; these cover the pure logic.
 */

describe('isFloodError', () => {
  it('detects flooding message and known codes', () => {
    assert.equal(isFloodError(new TSApiError(3331, 'client is flooding')), true);
    assert.equal(isFloodError(new TSApiError(3329, 'flood ban')), true);
    assert.equal(isFloodError(new TSApiError(0, 'ok')), false);
    assert.equal(isFloodError(new Error('socket hang up')), false);
    assert.equal(isFloodError({ message: 'client is flooding' }), true);
  });
});

describe('WebQuery priority pick pattern', () => {
  it('serves high before low even if enqueued later', () => {
    const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;
    type P = keyof typeof PRIORITY_RANK;
    const queue: { priority: P; enqueuedAt: number; id: string }[] = [
      { priority: 'low', enqueuedAt: 1, id: 'anim' },
      { priority: 'normal', enqueuedAt: 2, id: 'bot' },
      { priority: 'high', enqueuedAt: 3, id: 'dash' },
    ];

    const pickNextIndex = () => {
      let best = 0;
      for (let i = 1; i < queue.length; i++) {
        const cand = queue[i];
        const cur = queue[best];
        const candRank = PRIORITY_RANK[cand.priority];
        const curRank = PRIORITY_RANK[cur.priority];
        if (candRank < curRank || (candRank === curRank && cand.enqueuedAt < cur.enqueuedAt)) {
          best = i;
        }
      }
      return best;
    };

    assert.equal(queue[pickNextIndex()].id, 'dash');
    queue.splice(pickNextIndex(), 1);
    assert.equal(queue[pickNextIndex()].id, 'bot');
    queue.splice(pickNextIndex(), 1);
    assert.equal(queue[pickNextIndex()].id, 'anim');
  });
});
