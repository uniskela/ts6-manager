import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayQueue } from './queue.js';

test('shuffle append preserves current and removal uses displayed position with duplicate IDs', () => {
  const queue = new PlayQueue();
  for (const title of ['a', 'b', 'c']) queue.add({ id: 'duplicate', title, filePath: '', source: 'local' });
  queue.setShuffle(true);
  queue.playAt(1);
  const current = queue.current;
  queue.add({ id: 'duplicate', title: 'new', filePath: '', source: 'local' });
  assert.equal(queue.current, current);
  const removed = queue.getAll()[2];
  assert.ok(queue.removeAt(2));
  assert.ok(!queue.getAll().includes(removed));
  assert.equal(queue.current, current);
  queue.removeAt(0);
  assert.equal(queue.current, current);
  assert.equal(queue.playAt(NaN), null);
});


test('toggling shuffle preserves the logical current track in both directions', () => {
  const queue = new PlayQueue();
  for (const title of ['a', 'b', 'c', 'd']) queue.add({ id: title, title, filePath: '', source: 'local' });
  queue.playAt(2);
  const current = queue.current;
  queue.setShuffle(true);
  assert.equal(queue.current, current);
  queue.setShuffle(false);
  assert.equal(queue.current, current);
  assert.equal(queue.index, 2);
});
