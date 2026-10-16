import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_QUEUE_ITEMS, PLAYED_HISTORY_LIMIT, PlayQueue, QueueFullError } from './queue.js';

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

test('starting the same item twice never loops when its cleanup runs', () => {
  const q = seeded(false);
  const item = { id: 'again' };
  const first = q.addForPlayback(item);
  const second = q.addForPlayback(item);
  first();
  second();
  assert.ok(!q.getAll().includes(item));
});

// Pruning, the queue cap and reservations (#445).
function filled(count: number, prefix = 't'): PlayQueue<Entry> {
  const q = new PlayQueue<Entry>();
  q.addMany(Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` })));
  return q;
}

function advance(q: PlayQueue<Entry>, times: number) {
  for (let i = 0; i < times; i++) q.next();
}

const ids = (list: Entry[]) => list.map((item) => item.id);

test('advancing keeps the last 50 played tracks and prunes older ones', () => {
  const q = filled(120);
  advance(q, 51); // t50 playing, 50 played behind it: nothing pruned yet
  assert.equal(q.length, 120);
  assert.equal(q.pruned, 0);
  advance(q, 10); // t60 playing
  assert.equal(q.current?.id, 't60');
  assert.equal(q.index, PLAYED_HISTORY_LIMIT);
  assert.equal(q.pruned, 10);
  assert.equal(q.length, 110);
  assert.equal(q.getAll()[0].id, 't10');
  assert.deepEqual(ids(q.upcoming(2)), ['t61', 't62']);
  assert.equal(q.upcomingCount, 59);
});

test('the end of the queue prunes too and a later add plays next', () => {
  const q = filled(60);
  advance(q, 60);
  assert.equal(q.next(), null);
  assert.equal(q.current, null);
  assert.equal(q.length, PLAYED_HISTORY_LIMIT + 1);
  assert.equal(q.getAll().at(-1)?.id, 't59');
  q.add({ id: 'late' });
  assert.equal(q.next()?.id, 'late');
});

test('previous steps back through the kept history and replays the oldest kept track at the edge', () => {
  const q = filled(100);
  advance(q, 80); // t79 playing; t29..t78 kept
  assert.equal(q.getAll()[0].id, 't29');
  assert.equal(q.previous()?.id, 't78');
  for (let i = 0; i < 48; i++) q.previous();
  assert.equal(q.current?.id, 't30');
  assert.equal(q.previous()?.id, 't29');
  // Edge of the kept history: older tracks are gone, so !prev replays the oldest kept one.
  assert.equal(q.previous()?.id, 't29');
  assert.equal(q.index, 0);
  // Moving forward again neither prunes nor skips anything.
  assert.equal(q.next()?.id, 't30');
  assert.equal(q.getAll()[0].id, 't29');
});

test('repeat-all never prunes, and turning it off prunes at the next advance', () => {
  const q = filled(70);
  q.setRepeat('queue');
  advance(q, 70); // t69 playing, 69 played
  assert.equal(q.length, 70);
  assert.equal(q.next()?.id, 't0'); // wraps: played tracks come round again
  advance(q, 65);
  assert.equal(q.pruned, 0);
  assert.equal(q.current?.id, 't65');
  q.setRepeat('off');
  assert.equal(q.length, 70, 'changing the mode prunes nothing by itself');
  assert.equal(q.next()?.id, 't66');
  assert.equal(q.pruned, 16);
  assert.equal(q.getAll()[0].id, 't16');
  assert.equal(q.index, PLAYED_HISTORY_LIMIT);
});

test('repeat-track prunes like repeat off when the queue advances', () => {
  const q = filled(70);
  q.setRepeat('track');
  advance(q, 61);
  assert.equal(q.current?.id, 't60');
  assert.equal(q.pruned, 10);
  assert.equal(q.previous()?.id, 't59');
});

test('pruning with shuffle on keeps the shuffled order, the current track and what is still to play', () => {
  for (const draw of RANDOM_DRAWS) withRandom(draw, () => {
    const q = filled(150);
    q.setShuffle(true);
    advance(q, 60);
    const before = q.getAll();
    const prunedBefore = q.pruned;
    const current = q.current;
    const upcoming = q.upcoming();
    advance(q, 15);
    const after = q.getAll();
    assert.equal(q.pruned, 74 - PLAYED_HISTORY_LIMIT);
    assert.deepEqual(after, before.slice(q.pruned - prunedBefore), `draw=${draw}`);
    assert.equal(new Set(after).size, after.length, 'every kept track is shown once');
    assert.equal(q.current, upcoming[14]);
    assert.deepEqual(q.upcoming(), upcoming.slice(15));
    assert.notEqual(q.current, current);
    // Removing, moving and adding still address the displayed positions.
    const last = q.getAll().at(-1)!;
    assert.ok(q.move(q.length - 1, q.index + 1));
    assert.equal(q.upcoming()[0], last);
    assert.ok(q.removeAt(q.index + 1));
    assert.ok(!q.getAll().includes(last));
    q.add({ id: 'added' });
    assert.ok(q.upcoming().some((item) => item.id === 'added'));
  });
});

test('shuffle on and off reorder only what is still to play', () => {
  for (const draw of RANDOM_DRAWS) withRandom(draw, () => {
    const q = filled(80);
    advance(q, 60); // t59 playing, t9..t58 kept
    const played = q.getAll().slice(0, q.index + 1);
    q.setShuffle(true);
    assert.deepEqual(q.getAll().slice(0, q.index + 1), played);
    assert.deepEqual(new Set(ids(q.upcoming())), new Set(Array.from({ length: 20 }, (_, i) => `t${60 + i}`)));
    advance(q, 5);
    const playedNow = q.getAll().slice(0, q.index + 1);
    const current = q.current;
    q.setShuffle(false);
    assert.equal(q.current, current);
    assert.deepEqual(q.getAll().slice(0, q.index + 1), playedNow, 'nothing played comes back');
    const rest = ids(q.upcoming());
    assert.deepEqual(rest, [...rest].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), 'original order');
    assert.equal(rest.length, 15, 'nothing unplayed is skipped');
    advance(q, 15);
    assert.ok(q.current);
    assert.equal(q.next(), null);
  });
});

test('a full queue refuses one more track and leaves everything unchanged', () => {
  const q = filled(MAX_QUEUE_ITEMS);
  q.playAt(3);
  const before = snapshot(q);
  assert.equal(q.room, 0);
  assert.throws(() => q.add({ id: 'over' }), (err: unknown) => {
    assert.ok(err instanceof QueueFullError);
    assert.equal(err.statusCode, 409);
    assert.equal(err.reason, 'queue_full');
    assert.match(err.message, /limit 5,000 tracks/);
    return true;
  });
  assert.throws(() => q.addForPlayback({ id: 'over' }), QueueFullError);
  assert.deepEqual(snapshot(q), before);
  // Pruning played tracks frees room again.
  q.playAt(MAX_QUEUE_ITEMS - 2);
  q.next();
  assert.ok(q.room > 0);
  q.add({ id: 'fits' });
});

test('addMany adds every track or none of them', () => {
  for (const shuffle of [false, true]) {
    const q = filled(MAX_QUEUE_ITEMS - 3);
    q.setShuffle(shuffle);
    q.playAt(1);
    const before = snapshot(q);
    assert.throws(
      () => q.addMany([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
      (err: unknown) => err instanceof QueueFullError && /only 3 of these 4 tracks fit/.test(err.message),
    );
    assert.deepEqual(snapshot(q), before);
    q.addMany([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.equal(q.length, MAX_QUEUE_ITEMS);
  }
});

test('a reservation holds room for tracks that arrive later and is released once', () => {
  const q = filled(MAX_QUEUE_ITEMS - 5);
  const reservation = q.reserve(3);
  assert.equal(q.room, 2);
  assert.throws(() => q.reserve(3), QueueFullError);
  q.add({ id: 'other 1' });
  q.add({ id: 'other 2' });
  assert.throws(() => q.add({ id: 'other 3' }), QueueFullError, 'held room is not given away');
  q.add({ id: 'mine 1' }, reservation);
  q.addForPlayback({ id: 'mine 2' }, reservation);
  assert.equal(reservation.remaining, 1);
  reservation.release();
  reservation.release();
  assert.equal(reservation.remaining, 0);
  assert.equal(q.room, 1);
  q.add({ id: 'other 3' });
  assert.throws(() => q.add({ id: 'mine 3' }, reservation), QueueFullError, 'a released reservation holds nothing');
});

test('clear releases every reservation and resets the pruned count', () => {
  const q = filled(80);
  advance(q, 70);
  assert.ok(q.pruned > 0);
  const reservation = q.reserve(100);
  q.clear();
  assert.equal(q.pruned, 0);
  assert.equal(reservation.remaining, 0);
  assert.equal(q.room, MAX_QUEUE_ITEMS);
});

test('a rejected start after pruning restores the cursor', () => {
  for (const shuffle of [false, true]) {
    const q = filled(100);
    q.setShuffle(shuffle);
    advance(q, 70);
    const before = snapshot(q);
    q.addForPlayback({ id: 'failed' })();
    assert.deepEqual(snapshot(q), before, `shuffle=${shuffle}`);
  }
});
