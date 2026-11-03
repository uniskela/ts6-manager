import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  beginChatMediaRequest,
  invalidateChatPlaylistExpansion,
  startOrAppendMediaItem,
} from './queue.js';
import { PlayQueue, type QueueItem } from '../playlist/queue.js';

function track(id: string, title = id): QueueItem {
  return { id, title, artist: 'A', filePath: `/tmp/${id}`, source: 'url', sourceUrl: `https://8.8.8.8/${id}` };
}

describe('chat media request lifecycle (findings #3–5)', () => {
  it('does not let a discarded provisional request cancel an accepted peer', () => {
    const first = beginChatMediaRequest(42);
    first.accept();
    assert.equal(first.isCancelled(), false);

    const invalid = beginChatMediaRequest(42);
    assert.equal(first.isCancelled(), false, 'provisional peer must not bump generation');
    invalid.discard();
    assert.equal(first.isCancelled(), false);
    assert.equal(invalid.isCancelled(), true);
  });

  it('lets accept() supersede an older accepted request and abort its signal', () => {
    const first = beginChatMediaRequest(43);
    first.accept();
    const second = beginChatMediaRequest(43);
    second.accept();
    assert.equal(first.isCancelled(), true);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.isCancelled(), false);
  });

  it('lets invalidate abort every provisional and accepted request', () => {
    const a = beginChatMediaRequest(44);
    const b = beginChatMediaRequest(44);
    b.accept();
    invalidateChatPlaylistExpansion(44);
    assert.equal(a.isCancelled(), true);
    assert.equal(b.isCancelled(), true);
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
  });

  it('stops orphaned audio when playback finishes after the request was cancelled', async () => {
    const item = track('orphan', 'Orphan');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bot: any = {
      status: 'connected',
      nowPlaying: null as QueueItem | null,
      queue: new PlayQueue(),
      assertMusicCanStart: () => {},
      stopAudioCalls: 0,
      stopAudio() {
        bot.stopAudioCalls += 1;
        bot.nowPlaying = null;
        if (bot.status === 'playing' || bot.status === 'paused') bot.status = 'connected';
      },
      play: async (next: QueueItem) => {
        bot.nowPlaying = next;
        bot.status = 'playing';
        await gate;
      },
    };
    const request = beginChatMediaRequest(45);
    request.accept();
    const pending = startOrAppendMediaItem(bot, item, () => !request.isCancelled(), { replaceSessionIds: [] });
    await Promise.race([
      new Promise<void>((resolve) => {
        const tick = () => (bot.nowPlaying === item ? resolve() : setImmediate(tick));
        tick();
      }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('A never started')), 1000)),
    ]);
    invalidateChatPlaylistExpansion(45);
    release();
    const queued = await pending;
    assert.equal(queued, null);
    assert.equal(bot.nowPlaying, null);
    assert.ok(bot.stopAudioCalls >= 1);
    assert.equal(bot.queue.getAll().includes(item), false);
  });

  it('does not let stale Play A cleanup stop a newer active Play B', async () => {
    const itemA = track('a', 'Track A');
    const itemB = track('b', 'Track B');
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const bot: any = {
      status: 'connected',
      nowPlaying: null as QueueItem | null,
      queue: new PlayQueue(),
      assertMusicCanStart: () => {},
      stopAudioCalls: [] as QueueItem[],
      stopAudio() {
        bot.stopAudioCalls.push(bot.nowPlaying);
        bot.nowPlaying = null;
        if (bot.status === 'playing' || bot.status === 'paused') bot.status = 'connected';
      },
      play: async (next: QueueItem) => {
        if (next === itemA) {
          bot.nowPlaying = next;
          bot.status = 'playing';
          await gateA;
          return;
        }
        bot.nowPlaying = next;
        bot.status = 'playing';
      },
    };

    const requestA = beginChatMediaRequest(46);
    requestA.accept();
    const pendingA = startOrAppendMediaItem(bot, itemA, () => !requestA.isCancelled(), { replaceSessionIds: [] });
    await Promise.race([
      new Promise<void>((resolve) => {
        const tick = () => (bot.nowPlaying === itemA ? resolve() : setImmediate(tick));
        tick();
      }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('A never started')), 1000)),
    ]);

    // Stop invalidates A and clears audio the same way stopPlayback does.
    invalidateChatPlaylistExpansion(46);
    bot.stopAudio();
    bot.queue.clear();

    const requestB = beginChatMediaRequest(46);
    requestB.accept();
    const queuedB = await startOrAppendMediaItem(bot, itemB, () => !requestB.isCancelled(), { replaceSessionIds: [] });
    assert.equal(queuedB, false);
    assert.equal(bot.nowPlaying, itemB);
    assert.equal(bot.queue.current, itemB);

    releaseA();
    const queuedA = await pendingA;
    assert.equal(queuedA, null);
    assert.equal(bot.nowPlaying, itemB, 'stale A must not clear B nowPlaying');
    assert.equal(bot.queue.current, itemB);
    assert.equal(bot.queue.getAll().includes(itemB), true);
    assert.equal(bot.queue.getAll().includes(itemA), false);
    assert.equal(
      bot.stopAudioCalls.some((item: QueueItem | null) => item === itemB),
      false,
      'stale A must not stopAudio while B owns playback',
    );
  });

  it('does not let a delayed invalid discard cancel a later accepted request', async () => {
    const stale = beginChatMediaRequest(47);
    const newer = beginChatMediaRequest(47);
    newer.accept();
    assert.equal(newer.isCancelled(), false);
    stale.discard();
    assert.equal(newer.isCancelled(), false);
    assert.equal(stale.isCancelled(), true);
  });
});
