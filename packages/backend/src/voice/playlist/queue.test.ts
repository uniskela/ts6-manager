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

for (const shuffle of [false, true]) {
  test(`failed startup restores pending tracks with duplicate IDs, shuffle=${shuffle}`, () => {
    const q = new PlayQueue<{ id: string; title: string }>();
    q.addMany(['Playing', 'Pending 1', 'Pending 2'].map(title => ({ id: 'same', title })));
    q.playAt(0);
    q.setShuffle(shuffle);
    const previous = q.current, pending = q.upcoming();
    const failed = { id: 'same', title: 'Failed' };
    const cleanup = q.addForPlayback(failed);
    assert.equal(q.current, failed);
    cleanup();
    assert.equal(q.current, previous);
    assert.deepEqual(q.upcoming(), pending);
    assert.equal(q.next(), pending[0]);
  });
}

test('late startup cleanup preserves a newer selection and a cleared queue', () => {
  for (const cleared of [false, true]) {
    const q = new PlayQueue<{ id: string }>();
    q.add({ id: 'old' });
    q.playAt(0);
    const cleanup = q.addForPlayback({ id: 'failed' });
    if (cleared) q.clear();
    const newer = { id: 'newer' };
    q.addForPlayback(newer);
    cleanup();
    assert.equal(q.current, newer);
    assert.deepEqual(q.getAll().map(item => item.id), cleared ? ['newer'] : ['old', 'newer']);
  }
});

test('failed startup keeps the remaining cursor when the previous track was removed', () => {
  const q = new PlayQueue<{ id: string }>();
  q.add({ id: 'played' });
  q.add({ id: 'playing' });
  q.add({ id: 'pending' });
  q.playAt(1);
  const cleanup = q.addForPlayback({ id: 'failed' });
  assert.ok(q.remove('playing'));
  cleanup();
  assert.equal(q.current?.id, 'pending');
  assert.equal(q.next(), null);
  assert.deepEqual(q.getAll().map((item) => item.id), ['played', 'pending']);
});

test('failed startup preserves an unstarted or exhausted queue position', () => {
  for (const exhausted of [false, true]) {
    const q = new PlayQueue<{ id: string }>();
    const old = { id: 'old' }, pending = { id: 'pending' };
    q.add(old);
    if (exhausted) { q.next(); q.next(); }
    const cleanup = q.addForPlayback({ id: 'failed' });
    q.add(pending);
    cleanup();
    assert.equal(q.current, null);
    assert.equal(q.next(), exhausted ? pending : old);
  }
});

// Deterministic coverage for rejected starts: Math.random is pinned so every
// shuffle insertion slot is exercised instead of whichever one a run happens to draw.
const RANDOM_DRAWS = [0, 0.34, 0.67, 0.999];
type Entry = { id: string };

function snapshot(q: PlayQueue<Entry>) {
  return {
    all: q.getAll(), current: q.current, index: q.index, upcoming: q.upcoming(), length: q.length,
  };
}

function withRandom(value: number, run: () => void) {
  const original = Math.random;
  Math.random = () => value;
  try { run(); } finally { Math.random = original; }
}

function seeded(shuffle: boolean) {
  const q = new PlayQueue<Entry>();
  for (const id of ['a', 'b', 'c', 'd']) q.add({ id });
  q.setShuffle(shuffle);
  q.playAt(1);
  return q;
}

test('rejected start removes only its own entry and leaves current, order and cursor unchanged', () => {
  for (const shuffle of [false, true]) for (const draw of RANDOM_DRAWS) {
    withRandom(draw, () => {
      const q = seeded(shuffle);
      const before = snapshot(q);
      // Same id as a queued entry: only the exact object may be removed.
      const failed = { id: before.all[3].id };
      const cleanup = q.addForPlayback(failed);
      assert.equal(q.current, failed);
      cleanup();
      assert.deepEqual(snapshot(q), before, `shuffle=${shuffle} draw=${draw}`);
      cleanup();
      assert.deepEqual(snapshot(q), before, 'cleanup is idempotent');
    });
  }
});

test('rejected start keeps repeat modes and the next track intact', () => {
  for (const repeat of ['off', 'track', 'queue'] as const) for (const draw of RANDOM_DRAWS) {
    withRandom(draw, () => {
      const q = seeded(true);
      q.setRepeat(repeat);
      const before = snapshot(q);
      q.addForPlayback({ id: 'failed' })();
      assert.deepEqual(snapshot(q), before);
      assert.equal(q.next(), before.upcoming[0]);
    });
  }
});

test('first of two overlapping starts is rejected: the second keeps the cursor', () => {
  for (const shuffle of [false, true]) for (const draw of RANDOM_DRAWS) {
    withRandom(draw, () => {
      const q = seeded(shuffle);
      const before = snapshot(q);
      const first = { id: 'first' }, second = { id: 'second' };
      const cleanFirst = q.addForPlayback(first);
      q.addForPlayback(second);
      cleanFirst();
      assert.equal(q.current, second);
      assert.ok(!q.getAll().includes(first));
      assert.deepEqual(q.getAll().filter(item => item !== second), before.all);
    });
  }
});

test('both overlapping starts are rejected: the original track and order come back', () => {
  for (const shuffle of [false, true]) for (const draw of RANDOM_DRAWS) {
    for (const order of ['first-then-second', 'second-then-first']) {
      withRandom(draw, () => {
        const q = seeded(shuffle);
        const before = snapshot(q);
        const cleanFirst = q.addForPlayback({ id: 'first' });
        const cleanSecond = q.addForPlayback({ id: 'second' });
        if (order === 'first-then-second') { cleanFirst(); cleanSecond(); } else { cleanSecond(); cleanFirst(); }
        assert.deepEqual(snapshot(q), before, `${order} shuffle=${shuffle} draw=${draw}`);
      });
    }
  }
});

test('rejected start on an empty queue leaves it empty and idle', () => {
  for (const shuffle of [false, true]) {
    const q = new PlayQueue<Entry>();
    q.setShuffle(shuffle);
    q.addForPlayback({ id: 'failed' })();
    assert.deepEqual(snapshot(q), { all: [], current: null, index: -1, upcoming: [], length: 0 });
    const next = { id: 'next' };
    q.add(next);
    assert.equal(q.next(), next);
  }
});
