import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlayQueue, type QueueItem } from '../playlist/queue.js';
import { PlaylistVoteRuntime, type VoteBot } from './runtime.js';

function track(id: string, title = id): QueueItem {
  return { id, title, filePath: `/tmp/${id}.ogg`, source: 'local' };
}

function botWith(queue: PlayQueue, status: string = 'connected'): VoteBot {
  return {
    status,
    queue,
    videoSessionInfo: () => null,
  };
}

describe('PlaylistVoteRuntime.addAllOrNothing idle ordering', () => {
  it('idle with already-queued tracks starts at the existing head (queueDirect)', () => {
    const queue = new PlayQueue();
    queue.add(track('old', 'Already queued'));
    const runtime = new PlaylistVoteRuntime(() => botWith(queue));

    const result = runtime.queueDirect(1, [track('n1', 'New A'), track('n2', 'New B')]);

    assert.equal(result.result, 'queued');
    assert.equal(result.startItem?.title, 'Already queued');
    assert.equal(queue.index, 0);
    assert.deepEqual(queue.getAll().map((t) => t.title), ['Already queued', 'New A', 'New B']);
  });

  it('idle empty queue starts at the first appended track', () => {
    const queue = new PlayQueue();
    const runtime = new PlaylistVoteRuntime(() => botWith(queue));

    const result = runtime.queueDirect(1, [track('a'), track('b')]);

    assert.equal(result.result, 'queued');
    assert.equal(result.startItem?.id, 'a');
    assert.equal(queue.index, 0);
  });

  it('exhausted queue starts at the first newly appended track', () => {
    const queue = new PlayQueue();
    queue.addMany([track('a'), track('b'), track('c')]);
    queue.playAt(0);
    while (queue.next()) {
      /* drain */
    }
    assert.equal(queue.current, null);
    assert.ok(queue.index >= 0);
    const runtime = new PlaylistVoteRuntime(() => botWith(queue));

    const result = runtime.queueDirect(1, [track('n1'), track('n2')]);

    assert.equal(result.result, 'queued');
    assert.equal(result.startItem?.id, 'n1');
    assert.equal(queue.current?.id, 'n1');
  });

  it('playing bot appends without moving the cursor', () => {
    const queue = new PlayQueue();
    queue.addMany([track('a'), track('b')]);
    queue.playAt(0);
    const runtime = new PlaylistVoteRuntime(() => botWith(queue, 'playing'));

    const result = runtime.queueDirect(1, [track('n1')]);

    assert.equal(result.result, 'queued');
    assert.equal(result.startItem, null);
    assert.equal(queue.index, 0);
    assert.equal(queue.current?.id, 'a');
    assert.equal(queue.length, 3);
  });

  it('paused bot appends without moving the cursor', () => {
    const queue = new PlayQueue();
    queue.add(track('a'));
    queue.playAt(0);
    const runtime = new PlaylistVoteRuntime(() => botWith(queue, 'paused'));

    const result = runtime.queueDirect(1, [track('n1')]);

    assert.equal(result.startItem, null);
    assert.equal(queue.index, 0);
    assert.equal(queue.current?.id, 'a');
  });

  it('active video session appends without selecting a music start', () => {
    const queue = new PlayQueue();
    queue.add(track('old'));
    const bot: VoteBot = {
      status: 'connected',
      queue,
      videoSessionInfo: () => ({ kind: 'video' }),
    };
    const runtime = new PlaylistVoteRuntime(() => bot);

    const result = runtime.queueDirect(1, [track('n1')]);

    assert.equal(result.startItem, null);
    assert.equal(queue.index, -1);
    assert.equal(queue.length, 2);
  });

  it('idle with shuffle still selects display index 0 (existing head in shuffle order)', () => {
    const queue = new PlayQueue();
    queue.add(track('old', 'Already queued'));
    queue.setShuffle(true);
    const runtime = new PlaylistVoteRuntime(() => botWith(queue));

    const result = runtime.queueDirect(1, [track('n1', 'New A')]);

    assert.equal(result.result, 'queued');
    assert.equal(queue.index, 0);
    assert.equal(result.startItem, queue.current);
    assert.equal(queue.length, 2);
  });

  it('vote approval path uses the same head-preserving start', () => {
    const queue = new PlayQueue();
    queue.add(track('old', 'Already queued'));
    const runtime = new PlaylistVoteRuntime(() => botWith(queue));
    const botKey = '1';
    const channelId = '8';
    runtime.stash(botKey, channelId, {
      botId: 1,
      playlistId: 7,
      maxTracks: 25,
      items: [track('n1', 'New A'), track('n2', 'New B')],
      refreshedAtMs: 1_000,
    });

    const opened = runtime.machine.openVote({
      botKey,
      channelId,
      requesterUid: 'req',
      playlist: { id: 7, name: 'P', trackCount: 2 },
      settings: { thresholdPercent: 80, windowMs: 60_000, maxTracks: 25 },
      listenerUids: ['req'],
      nowMs: 1_000,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const queued = opened.events.find((e) => e.type === 'queue');
    assert.ok(queued && queued.type === 'queue');
    assert.equal(queue.index, 0);
    assert.equal(queue.current?.title, 'Already queued');
    const taken = runtime.takeStart(queued.voteId);
    assert.equal(taken?.item.title, 'Already queued');
  });
});
