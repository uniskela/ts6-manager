import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueueItemInfo } from '@ts6/common';
import { absoluteIndex, moveUpNext, rowKeys, upNext } from '../../src/pages/bot-hub/console-queue';

const item = (id: string): QueueItemInfo => ({ id, title: `Song ${id}`, source: 'local' });
const queue = ['a', 'b', 'c', 'd', 'e'].map(item);

describe('console queue', () => {
  it('up next is every item after the playing one', () => {
    assert.deepEqual(upNext({ queue, currentIndex: 1 }).map((q) => q.id), ['c', 'd', 'e']);
  });

  it('up next is the whole queue when nothing has played yet', () => {
    assert.deepEqual(upNext({ queue, currentIndex: -1 }).map((q) => q.id), ['a', 'b', 'c', 'd', 'e']);
  });

  it('up next is empty when the last item is playing', () => {
    assert.deepEqual(upNext({ queue, currentIndex: 4 }), []);
  });

  it('converts an up next position to the absolute queue index', () => {
    assert.equal(absoluteIndex(2, 0), 3);
    assert.equal(absoluteIndex(2, 1), 4);
    assert.equal(absoluteIndex(-1, 0), 0);
  });

  it('moves an item down and keeps the others in order', () => {
    assert.deepEqual(moveUpNext(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  });

  it('moves an item up and keeps the others in order', () => {
    assert.deepEqual(moveUpNext(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
  });

  it('returns a new array and leaves the input untouched', () => {
    const input = ['a', 'b'];
    const out = moveUpNext(input, 0, 1);
    assert.deepEqual(input, ['a', 'b']);
    assert.deepEqual(out, ['b', 'a']);
  });

  it('gives the same song queued twice distinct row keys', () => {
    const keys = rowKeys([item('7'), item('8'), item('7')]);
    assert.equal(new Set(keys).size, 3);
    assert.deepEqual(keys, ['7#0', '8#0', '7#1']);
  });
});
