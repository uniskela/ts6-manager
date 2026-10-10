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

test('upcoming returns displayed tracks after the current index (shuffle-aware)', () => {
  const queue = new PlayQueue();
  for (const title of ['a', 'b', 'c', 'd', 'e', 'f']) {
    queue.add({ id: title, title, filePath: '', source: 'local' });
  }
  queue.playAt(2);
  assert.deepEqual(queue.upcoming(2).map((t) => t.title), ['d', 'e']);
  assert.deepEqual(queue.upcoming().map((t) => t.title), ['d', 'e', 'f']);

  queue.setShuffle(true);
  const displayed = queue.getAll().map((t) => t.title);
  const idx = queue.index;
  assert.deepEqual(
    queue.upcoming(3).map((t) => t.title),
    displayed.slice(idx + 1, idx + 4),
  );
  assert.equal(queue.upcomingCount, displayed.length - idx - 1);
});

test('moving with shuffle on moves only the dragged track in the displayed order', () => {
  const queue = new PlayQueue();
  for (const title of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    queue.add({ id: title, title, filePath: '', source: 'local' });
  }
  queue.playAt(1);
  queue.setShuffle(true);
  const current = queue.current;
  const before = queue.getAll().map((t) => t.title);

  assert.ok(queue.move(6, 3));
  const expected = [...before];
  const [dragged] = expected.splice(6, 1);
  expected.splice(3, 0, dragged);
  assert.deepEqual(queue.getAll().map((t) => t.title), expected);
  assert.equal(queue.current, current);
  assert.equal(queue.index, 1);

  // Turning shuffle off afterwards still keeps the current track.
  queue.setShuffle(false);
  assert.equal(queue.current, current);
});

test('moving without shuffle keeps the current track playing', () => {
  const queue = new PlayQueue();
  for (const title of ['a', 'b', 'c', 'd']) queue.add({ id: title, title, filePath: '', source: 'local' });
  queue.playAt(1);
  assert.ok(queue.move(3, 0));
  assert.deepEqual(queue.getAll().map((t) => t.title), ['d', 'a', 'b', 'c']);
  assert.equal(queue.current?.title, 'b');
  assert.equal(queue.move(0, 1.5), false);
});

test('rewind keeps items and makes the current one upcoming again', () => {
  const q = new PlayQueue<{ id: string }>();
  q.addMany([{ id: 'a' }, { id: 'b' }]);
  q.next();
  assert.equal(q.current?.id, 'a');
  q.rewind();
  assert.equal(q.current, null);
  assert.equal(q.index, -1);
  assert.deepEqual(q.upcoming().map((i) => i.id), ['a', 'b']);
});

test('accepts a non-music item type', () => {
  const q = new PlayQueue<{ id: string; source: string }>();
  q.add({ id: 'v1', source: 'https://example.test/a' });
  assert.equal(q.next()?.source, 'https://example.test/a');
});
