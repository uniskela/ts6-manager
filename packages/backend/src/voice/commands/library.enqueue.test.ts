import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MediaSessionConflictError } from '../media-session.js';
import { PlayQueue, type QueueItem } from '../playlist/queue.js';
import { enqueueSavedPlaylist } from './library.js';

function track(id: string, title = id): QueueItem {
  return {
    id,
    title,
    artist: 'A',
    filePath: `/tmp/${id}`,
    source: 'url',
    sourceUrl: `https://8.8.8.8/${id}`,
  };
}

function playlistDb(songs: Array<{ id: number; title: string }>) {
  const rows = songs.map((song, position) => ({
    position,
    song: {
      id: song.id,
      title: song.title,
      artist: 'Artist',
      duration: 10,
      filePath: `/tmp/${song.id}`,
      source: 'url',
      sourceUrl: `https://8.8.8.8/${song.id}`,
    },
  }));
  return {
    playlist: {
      findMany: async () => [{ id: 1, name: 'Rock' }],
      findFirst: async () => ({ id: 1, name: 'Rock', songs: rows }),
    },
  } as any;
}

function fakeBot(overrides: Record<string, unknown> = {}) {
  const bot: any = {
    status: 'connected',
    nowPlaying: null as QueueItem | null,
    stopGeneration: 0,
    queue: new PlayQueue(),
    currentConfig: { serverConfigId: 1, id: 1 },
    playCalls: [] as QueueItem[],
    stopAudioCalls: 0,
    assertMusicCanStart() {},
    stopAudio() {
      bot.stopAudioCalls += 1;
      bot.nowPlaying = null;
      if (bot.status === 'playing' || bot.status === 'paused') bot.status = 'connected';
    },
    async play(item: QueueItem) {
      bot.playCalls.push(item);
      bot.nowPlaying = item;
      bot.status = 'playing';
    },
    ...overrides,
  };
  return bot;
}

describe('enqueueSavedPlaylist queue integrity (finding #12)', () => {
  it('refuses play while video is active without mutating an empty queue', async () => {
    const bot = fakeBot({
      assertMusicCanStart() {
        throw new MediaSessionConflictError('music', [{
          id: 'video-1',
          kind: 'video',
          state: 'active',
          botId: 1,
          botName: 'Bot',
          sourceLabel: 'stream',
        } as any]);
      },
    });
    const result = await enqueueSavedPlaylist(playlistDb([{ id: 10, title: 'One' }, { id: 11, title: 'Two' }]), bot, 'Rock', {
      musicSwitch: { replaceSessionIds: [] },
    });
    assert.equal(result.ok, false);
    assert.equal(bot.queue.length, 0);
    assert.equal(bot.queue.index, -1);
    assert.equal(bot.nowPlaying, null);
    assert.equal(bot.playCalls.length, 0);
  });

  it('refuses play while video is active and preserves an existing queue and cursor', async () => {
    const existing = track('keep', 'Keep');
    const bot = fakeBot({
      assertMusicCanStart() {
        throw new MediaSessionConflictError('music', [{
          id: 'video-1',
          kind: 'video',
          state: 'active',
          botId: 1,
          botName: 'Bot',
          sourceLabel: 'stream',
        } as any]);
      },
    });
    bot.queue.add(existing);
    bot.queue.playAt(0);
    const result = await enqueueSavedPlaylist(playlistDb([{ id: 10, title: 'One' }]), bot, 'Rock', {
      musicSwitch: { replaceSessionIds: [] },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(bot.queue.getAll().map((item: QueueItem) => item.id), ['keep']);
    assert.equal(bot.queue.current, existing);
    assert.equal(bot.queue.index, 0);
    assert.equal(bot.playCalls.length, 0);
  });

  it('queues without starting when music is already playing', async () => {
    const current = track('cur', 'Current');
    const bot = fakeBot({ status: 'playing', nowPlaying: current });
    bot.queue.add(current);
    bot.queue.playAt(0);
    const result = await enqueueSavedPlaylist(playlistDb([{ id: 10, title: 'One' }, { id: 11, title: 'Two' }]), bot, 'Rock');
    assert.equal(result.ok, true);
    assert.deepEqual(bot.queue.getAll().map((item: QueueItem) => item.title), ['Current', 'One', 'Two']);
    assert.equal(bot.queue.current, current);
    assert.equal(bot.playCalls.length, 0);
  });

  it('starts an accepted playlist on an idle bot', async () => {
    const bot = fakeBot();
    const result = await enqueueSavedPlaylist(playlistDb([{ id: 10, title: 'One' }, { id: 11, title: 'Two' }]), bot, 'Rock', {
      musicSwitch: { replaceSessionIds: [] },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(bot.queue.getAll().map((item: QueueItem) => item.title), ['One', 'Two']);
    assert.equal(bot.nowPlaying?.title, 'One');
    assert.equal(bot.queue.current?.title, 'One');
    assert.equal(bot.playCalls.length, 1);
  });

  it('rolls back owned items when play throws after admission', async () => {
    const existing = track('keep', 'Keep');
    const bot = fakeBot({
      async play() {
        throw new Error('decoder failed');
      },
    });
    bot.queue.add(existing);
    bot.queue.playAt(0);
    // Idle with leftover queue entries (cursor on Keep, no nowPlaying).
    bot.status = 'connected';
    bot.nowPlaying = null;

    const result = await enqueueSavedPlaylist(playlistDb([{ id: 10, title: 'One' }]), bot, 'Rock', {
      musicSwitch: { replaceSessionIds: [] },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /decoder failed/);
    assert.deepEqual(bot.queue.getAll().map((item: QueueItem) => item.id), ['keep']);
    assert.equal(bot.queue.current, existing);
    assert.equal(bot.nowPlaying, null);
  });

  it('does not roll back a newer request when an older start fails late', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const bot = fakeBot({
      async play(item: QueueItem) {
        bot.playCalls.push(item);
        if (item.title === 'One') {
          bot.nowPlaying = item;
          bot.status = 'playing';
          await gateA;
          throw new Error('late A failure');
        }
        bot.nowPlaying = item;
        bot.status = 'playing';
      },
    });

    const pendingA = enqueueSavedPlaylist(playlistDb([{ id: 10, title: 'One' }]), bot, 'Rock', {
      musicSwitch: { replaceSessionIds: [] },
      isCurrent: () => true,
    });
    await Promise.race([
      new Promise<void>((resolve) => {
        const tick = () => (bot.nowPlaying?.title === 'One' ? resolve() : setImmediate(tick));
        tick();
      }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('A never started')), 1000)),
    ]);

    // Newer accepted path: already playing, so B only appends.
    bot.status = 'playing';
    const newer = await enqueueSavedPlaylist({
      playlist: {
        findMany: async () => [{ id: 2, name: 'Jazz' }],
        findFirst: async () => ({
          id: 2,
          name: 'Jazz',
          songs: [{
            position: 0,
            song: {
              id: 20,
              title: 'B1',
              artist: 'B',
              duration: 1,
              filePath: '/tmp/b1',
              source: 'url',
              sourceUrl: 'https://8.8.8.8/b1',
            },
          }],
        }),
      },
    } as any, bot, 'Jazz');
    assert.equal(newer.ok, true);
    assert.ok(bot.queue.getAll().some((item: QueueItem) => item.title === 'B1'));

    // Stop invalidates A; A must not strip B on failure cleanup.
    bot.stopGeneration += 1;
    releaseA();
    const a = await pendingA;
    assert.equal(a.ok, false);
    assert.ok(bot.queue.getAll().some((item: QueueItem) => item.title === 'B1'));
    assert.ok(bot.queue.getAll().some((item: QueueItem) => item.title === 'One'), 'A may leave its tracks when ownership was lost');
  });

  it('Stop after queue mutation clears A and leaves a later Play B alone', async () => {
    let releaseA!: () => void;
    let enteredPlayA = false;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const generationAtPlayStart = { value: 0 };
    const bot = fakeBot({
      async play(item: QueueItem) {
        bot.playCalls.push(item);
        const gen = bot.stopGeneration;
        if (item.title === 'One') {
          enteredPlayA = true;
          generationAtPlayStart.value = gen;
          bot.nowPlaying = item;
          bot.status = 'playing';
          await gateA;
          // Mimic VoiceBot ownership: do not keep audio if Stop advanced generation.
          if (bot.stopGeneration !== generationAtPlayStart.value) return;
          bot.nowPlaying = item;
          return;
        }
        bot.nowPlaying = item;
        bot.status = 'playing';
      },
    });

    const pendingA = enqueueSavedPlaylist(playlistDb([{ id: 10, title: 'One' }, { id: 11, title: 'Two' }]), bot, 'Rock', {
      musicSwitch: { replaceSessionIds: [] },
      isCurrent: () => true,
    });
    await Promise.race([
      new Promise<void>((resolve) => {
        const tick = () => (enteredPlayA ? resolve() : setImmediate(tick));
        tick();
      }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('A never entered play')), 1000)),
    ]);
    assert.ok(bot.queue.length >= 2);

    // Real !stop / /stop: bump generation, clear queue, stop audio.
    bot.stopGeneration += 1;
    bot.queue.clear();
    bot.stopAudio();
    assert.equal(bot.nowPlaying, null);
    assert.equal(bot.queue.length, 0);

    const b = await enqueueSavedPlaylist({
      playlist: {
        findMany: async () => [{ id: 2, name: 'Jazz' }],
        findFirst: async () => ({
          id: 2,
          name: 'Jazz',
          songs: [{
            position: 0,
            song: {
              id: 20,
              title: 'B1',
              artist: 'B',
              duration: 1,
              filePath: '/tmp/b1',
              source: 'url',
              sourceUrl: 'https://8.8.8.8/b1',
            },
          }],
        }),
      },
    } as any, bot, 'Jazz', { musicSwitch: { replaceSessionIds: [] } });
    assert.equal(b.ok, true);
    assert.equal(bot.nowPlaying?.title, 'B1');
    const stopsBeforeLateA = bot.stopAudioCalls;

    // Late A completion must not clear B or reintroduce A's tracks.
    releaseA();
    const a = await pendingA;
    assert.equal(a.ok, false);
    assert.equal(bot.nowPlaying?.title, 'B1');
    assert.deepEqual(bot.queue.getAll().map((item: QueueItem) => item.title), ['B1']);
    assert.equal(bot.stopAudioCalls, stopsBeforeLateA, 'stale A must not stopAudio while B owns nowPlaying');
  });

  it('clears orphaned nowPlaying when late play finishes after Stop with no Play B', async () => {
    let releaseA!: () => void;
    let enteredPlayA = false;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const bot = fakeBot({
      async play(item: QueueItem) {
        bot.playCalls.push(item);
        enteredPlayA = true;
        await gateA;
        // Deliberately re-claims audio after Stop to prove enqueueSavedPlaylist clears it.
        bot.nowPlaying = item;
        bot.status = 'playing';
      },
    });

    const pendingA = enqueueSavedPlaylist(playlistDb([{ id: 10, title: 'One' }]), bot, 'Rock', {
      musicSwitch: { replaceSessionIds: [] },
    });
    await Promise.race([
      new Promise<void>((resolve) => {
        const tick = () => (enteredPlayA ? resolve() : setImmediate(tick));
        tick();
      }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('A never entered play')), 1000)),
    ]);

    bot.stopGeneration += 1;
    bot.queue.clear();
    bot.stopAudio();

    releaseA();
    const a = await pendingA;
    assert.equal(a.ok, false);
    assert.equal(bot.nowPlaying, null);
    assert.equal(bot.queue.length, 0);
  });

  it('does not start late after Stop during playlist preparation', async () => {
    let releaseLookup!: () => void;
    let enteredLookup = false;
    const gate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const bot = fakeBot();
    const db = {
      playlist: {
        findMany: async () => {
          enteredLookup = true;
          await gate;
          return [{ id: 1, name: 'Rock' }];
        },
        findFirst: async () => ({
          id: 1,
          name: 'Rock',
          songs: [{
            position: 0,
            song: {
              id: 10,
              title: 'One',
              artist: 'A',
              duration: 1,
              filePath: '/tmp/10',
              source: 'url',
              sourceUrl: 'https://8.8.8.8/10',
            },
          }],
        }),
      },
    } as any;

    const pending = enqueueSavedPlaylist(db, bot, 'Rock', {
      musicSwitch: { replaceSessionIds: [] },
      isCurrent: () => bot.stopGeneration === 0,
    });
    await Promise.race([
      new Promise<void>((resolve) => {
        const tick = () => (enteredLookup ? resolve() : setImmediate(tick));
        tick();
      }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('lookup never started')), 1000)),
    ]);
    bot.stopGeneration += 1;
    releaseLookup();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(bot.queue.length, 0);
    assert.equal(bot.playCalls.length, 0);
    assert.equal(bot.nowPlaying, null);
  });
});
