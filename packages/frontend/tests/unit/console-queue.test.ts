import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueueItemInfo } from '@ts6/common';
import { absoluteIndex, activeLane, droppedMove, moveUpNext, rowKeys, upNext, videoRowDetail } from '../../src/pages/bot-hub/console-queue';

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

describe('console queue: which lane Up next shows', () => {
  const idle = { sessionKind: null, musicLive: false, musicUpNext: 0, videoUpNext: 0 } as const;

  it('a video session shows the video lane', () => {
    assert.equal(activeLane({ ...idle, sessionKind: 'video' }), 'video');
    assert.equal(activeLane({ ...idle, sessionKind: 'video', musicUpNext: 4 }), 'video');
  });

  it('an idle bot with only queued videos shows the video lane', () => {
    assert.equal(activeLane({ ...idle, videoUpNext: 2 }), 'video');
  });

  it('an idle bot with both lanes holding items shows music', () => {
    assert.equal(activeLane({ ...idle, videoUpNext: 2, musicUpNext: 1 }), 'music');
  });

  it('an idle bot with nothing queued shows music', () => {
    assert.equal(activeLane(idle), 'music');
  });

  it('a music session with videos kept shows music', () => {
    assert.equal(activeLane({ ...idle, sessionKind: 'music', videoUpNext: 3 }), 'music');
  });

  it('radio with videos kept shows music', () => {
    assert.equal(activeLane({ ...idle, sessionKind: 'music', musicLive: true, videoUpNext: 3 }), 'music');
  });
});

describe('console queue: video row detail', () => {
  const row = (over: Partial<Parameters<typeof videoRowDetail>[0]>) =>
    videoRowDetail({ title: 'Launch stream', source: 'https://www.youtube.com/watch?v=abc', sourceMode: 'auto', ...over });

  it('shows the host of a remote video', () => {
    assert.equal(row({}), 'www.youtube.com');
  });

  it('says Live for a live source', () => {
    assert.equal(row({ sourceMode: 'live' }), 'Live');
  });

  it('shows nothing when the title already is the host, or for a file', () => {
    assert.equal(row({ title: 'www.youtube.com' }), undefined);
    assert.equal(row({ title: 'clip.mp4', source: 'clip.mp4' }), undefined);
  });
});

describe('console queue: dropped rows', () => {
  const keys = ['a#0', 'b#0', 'c#0'];

  it('reports the positions a drop moved between', () => {
    assert.deepEqual(droppedMove(keys, 'a#0', 'c#0'), { from: 0, to: 2 });
    assert.deepEqual(droppedMove(keys, 'c#0', 'b#0'), { from: 2, to: 1 });
  });

  it('is null when nothing moved or a row is unknown', () => {
    assert.equal(droppedMove(keys, 'a#0', 'a#0'), null);
    assert.equal(droppedMove(keys, 'a#0', undefined), null);
    assert.equal(droppedMove(keys, 'a#0', 'z#0'), null);
    assert.equal(droppedMove(keys, 'z#0', 'a#0'), null);
  });
});
