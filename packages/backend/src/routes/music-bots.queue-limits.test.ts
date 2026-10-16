import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/error-handler.js';
import { createPlayUrlHandler, musicBotRoutes } from './music-bots.routes.js';
import type { MediaUrlPipelineDeps } from '../voice/media-url-pipeline.js';
import { MAX_QUEUE_ITEMS, PlayQueue, type QueueItem } from '../voice/playlist/queue.js';
import { beginChatMediaRequest, handlePlaylist, handleQueue } from '../voice/commands/queue.js';

const track = (id: string): QueueItem => ({ id, title: id, filePath: `/music/${id}.opus`, source: 'local' });

function fakeBot(status = 'playing') {
  const played: QueueItem[] = [];
  const bot: any = {
    id: 3, status, nowPlaying: null,
    currentConfig: { id: 3, serverConfigId: null },
    queue: new PlayQueue(),
    assertMusicCanStart: () => {},
    play: async (item: QueueItem) => { bot.nowPlaying = item; played.push(item); },
    playStream: async (item: QueueItem) => { bot.nowPlaying = item; played.push(item); },
  };
  return { bot, played };
}

function fill(queue: PlayQueue, count: number) {
  queue.addMany(Array.from({ length: count }, (_, i) => track(`q${i}`)));
}

function buildApp(bot: unknown, playlistSongs = 0, deps?: MediaUrlPipelineDeps, hooks: { findSong?: () => Promise<void> } = {}): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: 'admin', username: 'tester' };
    const prisma: any = {
      song: { findUnique: async ({ where }: any) => { await hooks.findSong?.(); return { id: where.id, title: `Song ${where.id}`, filePath: '/music/song.opus', source: 'local' }; } },
      playlist: {
        findUnique: async () => ({
          id: 5,
          songs: Array.from({ length: playlistSongs }, (_, i) => ({ song: { id: 100 + i, title: `P${i}`, filePath: '/music/p.opus', source: 'local' } })),
        }),
      },
      adminAuditEvent: { create: async () => ({ id: 'audit' }), updateMany: async () => ({ count: 1 }) },
    };
    Object.assign(req.app.locals, { voiceBotManager: { getBot: () => bot, on: () => {}, off: () => {} }, prisma });
    next();
  });
  if (deps) app.post('/api/music-bots/:id/play-url', createPlayUrlHandler(deps));
  app.use('/api/music-bots', musicBotRoutes);
  app.use(errorHandler);
  return app;
}

async function call(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  // Rejects if the server fails to start, instead of hanging.
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function flushBackground(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('every console add path stops at the queue limit', () => {
  it('enqueue and play-now answer 409 on a full queue and change nothing', async () => {
    const { bot, played } = fakeBot();
    fill(bot.queue, MAX_QUEUE_ITEMS);
    bot.queue.playAt(0);
    const app = buildApp(bot);
    for (const path of ['/api/music-bots/3/queue', '/api/music-bots/3/play']) {
      const res = await call(app, 'POST', path, { songId: 9 });
      assert.equal(res.status, 409, path);
      assert.equal(res.body.reason, 'queue_full');
      assert.equal(res.body.error, 'The queue is full (limit 5,000 tracks).');
    }
    assert.equal(bot.queue.length, MAX_QUEUE_ITEMS);
    assert.equal(bot.queue.index, 0);
    assert.deepEqual(played, []);
  });

  it('a playlist load that does not fit is refused whole', async () => {
    for (const autoplay of [false, true]) {
      const { bot, played } = fakeBot('connected');
      fill(bot.queue, MAX_QUEUE_ITEMS - 2);
      const res = await call(buildApp(bot, 3), 'POST', '/api/music-bots/3/queue/playlist', { playlistId: 5, autoplay });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /only 2 of these 3 tracks fit/);
      assert.equal(bot.queue.length, MAX_QUEUE_ITEMS - 2);
      assert.deepEqual(played, []);
    }
  });

  it('clear-first loads replace a full queue, and an oversized one never clears it', async () => {
    const fits = fakeBot('connected');
    fill(fits.bot.queue, MAX_QUEUE_ITEMS);
    const loaded = await call(buildApp(fits.bot, 3), 'POST', '/api/music-bots/3/queue/playlist', { playlistId: 5, clearFirst: true });
    assert.equal(loaded.status, 200);
    assert.deepEqual(fits.bot.queue.getAll().map((item: QueueItem) => item.title), ['P0', 'P1', 'P2']);
    assert.equal(fits.played[0].title, 'P0');

    const tooBig = fakeBot('connected');
    fill(tooBig.bot.queue, 10);
    const refused = await call(buildApp(tooBig.bot, MAX_QUEUE_ITEMS + 1), 'POST', '/api/music-bots/3/queue/playlist', { playlistId: 5, clearFirst: true });
    assert.equal(refused.status, 409);
    assert.equal(tooBig.bot.queue.length, 10);
    assert.deepEqual(tooBig.played, []);
  });

  it('a playlist link is reserved whole: refused before downloading, or held against other adds', async () => {
    const urls = Array.from({ length: 4 }, (_, i) => `https://www.youtube.com/watch?v=0000000000${i}`);
    const downloads: string[] = [];
    // The first track downloads at once; the rest wait until the test opens the gate.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const deps: MediaUrlPipelineDeps = {
      resolveSpotify: async (url) => url,
      resolveAppleMusic: async () => ({ tracks: [] }),
      resolveSpotifyCollection: async () => null,
      appleTrackToYouTube: async () => null,
      expandYouTube: async (_url, cap) => ({ urls: urls.slice(0, Math.min(cap, 4)) }),
      downloadTrack: async (url) => {
        downloads.push(url);
        if (url !== urls[0]) await gate;
        return { ...track(url), sourceUrl: url };
      },
    };

    const refused = fakeBot();
    fill(refused.bot.queue, MAX_QUEUE_ITEMS - 3);
    const res = await call(buildApp(refused.bot, 0, deps), 'POST', '/api/music-bots/3/play-url',
      { url: 'https://www.youtube.com/playlist?list=PL1', enqueue: true });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /only 3 of these 4 tracks fit/);
    assert.deepEqual(downloads, []);
    assert.equal(refused.bot.queue.length, MAX_QUEUE_ITEMS - 3);

    const held = fakeBot();
    fill(held.bot.queue, MAX_QUEUE_ITEMS - 4);
    const accepted = await call(buildApp(held.bot, 0, deps), 'POST', '/api/music-bots/3/play-url',
      { url: 'https://www.youtube.com/playlist?list=PL1', enqueue: true });
    assert.equal(accepted.status, 200);
    assert.equal(held.bot.queue.length, MAX_QUEUE_ITEMS - 3);
    // While the rest of the link downloads, its room is not given to anyone else.
    assert.equal(held.bot.queue.room, 0);
    const other = await call(buildApp(held.bot), 'POST', '/api/music-bots/3/queue', { songId: 9 });
    assert.equal(other.status, 409);
    open();
    await flushBackground();
    assert.equal(held.bot.queue.length, MAX_QUEUE_ITEMS);
    assert.deepEqual(held.bot.queue.getAll().slice(-4).map((item: QueueItem) => item.sourceUrl), urls);
  });
});

describe('index-based console edits after pruning', () => {
  function pruned() {
    const { bot, played } = fakeBot();
    bot.queue.addMany(Array.from({ length: 80 }, (_, i) => track(`t${i}`)));
    for (let i = 0; i < 70; i++) bot.queue.next(); // t69 playing, t19..t68 kept
    return { bot, played };
  }

  it('a stale index is refused instead of changing the track that moved into it', async () => {
    const { bot, played } = pruned();
    const app = buildApp(bot);
    const seen = bot.queue.index + 2; // the console shows t71 here
    assert.equal(bot.queue.getAll()[seen].id, 't71');
    bot.queue.next(); // a track ends and t19 is pruned: every index shifts by one
    const before = bot.queue.getAll();

    const removed = await call(app, 'DELETE', `/api/music-bots/3/queue/${seen}?id=t71`);
    assert.equal(removed.status, 409);
    assert.equal(removed.body.reason, 'queue_changed');
    const playedAt = await call(app, 'POST', `/api/music-bots/3/queue/${seen}/play`, { id: 't71' });
    assert.equal(playedAt.status, 409);
    const moved = await call(app, 'PUT', '/api/music-bots/3/queue/move', { from: seen, to: seen + 3, id: 't71' });
    assert.equal(moved.status, 409);
    assert.deepEqual(bot.queue.getAll(), before);
    assert.deepEqual(played, []);

    // With the refreshed index the same edits go through.
    assert.equal((await call(app, 'PUT', '/api/music-bots/3/queue/move', { from: seen - 1, to: seen + 2, id: 't71' })).status, 200);
    assert.equal(bot.queue.getAll()[seen + 2].id, 't71');
    assert.equal((await call(app, 'POST', `/api/music-bots/3/queue/${seen + 2}/play`, { id: 't71' })).status, 200);
    assert.equal(played.at(-1)?.id, 't71');
    assert.equal((await call(app, 'DELETE', `/api/music-bots/3/queue/${seen - 1}?id=t72`)).status, 200);
    assert.ok(!bot.queue.getAll().some((item: QueueItem) => item.id === 't72'));
  });

  it('remove by index takes that position even when the song is queued twice', async () => {
    const { bot } = fakeBot();
    bot.queue.addMany([track('a'), track('same'), track('b'), track('same')]);
    bot.queue.playAt(0);
    const res = await call(buildApp(bot), 'DELETE', '/api/music-bots/3/queue/3?id=same');
    assert.equal(res.status, 200);
    assert.deepEqual(bot.queue.getAll().map((item: QueueItem) => item.id), ['a', 'same', 'b']);
    // Old clients that send no ID keep working.
    assert.equal((await call(buildApp(bot), 'DELETE', '/api/music-bots/3/queue/2')).status, 200);
    assert.deepEqual(bot.queue.getAll().map((item: QueueItem) => item.id), ['a', 'same']);
  });

  it('the state the console reads shows the right current and upcoming tracks after pruning', async () => {
    const { bot } = pruned();
    bot.nowPlaying = bot.queue.current;
    bot.playbackProgress = null;
    const state = await call(buildApp(bot), 'GET', '/api/music-bots/3/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.queue[state.body.currentIndex].id, 't69');
    assert.equal(state.body.queue[state.body.currentIndex + 1].id, 't70');
    assert.equal(state.body.queue.length, 61);
  });
});

describe('a queue clear cancels requests still resolving on the other surface', () => {
  it('the console clear cancels a pending chat request', async () => {
    const { bot } = fakeBot('connected');
    bot.clearPlayback = () => {};
    // What a chat !play / !queue <url> holds while it resolves.
    const request = beginChatMediaRequest(3);
    assert.equal((await call(buildApp(bot), 'DELETE', '/api/music-bots/3/queue')).status, 200);
    assert.ok(request.isCancelled());
    assert.ok(request.signal.aborted);
  });

  it('chat !queue clear drops a console play-url that finishes resolving afterwards', async () => {
    const { bot, played } = fakeBot('connected');
    bot.clearPlayback = () => {};
    let started!: () => void, release!: () => void;
    const downloading = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps: MediaUrlPipelineDeps = {
      resolveSpotify: async (url) => url,
      resolveAppleMusic: async () => ({ tracks: [] }),
      resolveSpotifyCollection: async () => null,
      appleTrackToYouTube: async () => null,
      expandYouTube: async () => null,
      downloadTrack: async (url) => { started(); await gate; return { ...track('late'), sourceUrl: url }; },
    };
    const pending = call(buildApp(bot, 0, deps), 'POST', '/api/music-bots/3/play-url', { url: 'https://www.youtube.com/watch?v=00000000000' });
    await downloading;
    await handleQueue({ reply: () => {} } as any, 3, bot, 2, 'clear');
    release();
    assert.equal((await pending).status, 200);
    await flushBackground();
    assert.deepEqual(played, []);
    assert.equal(bot.queue.length, 0);
  });
});

describe('a Stop or queue clear during a short lookup drops the add', () => {
  it('console enqueue answers 409 and adds nothing', async () => {
    const { bot } = fakeBot('connected');
    bot.stopGeneration = 0;
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = call(buildApp(bot, 0, undefined, { findSong: async () => { entered(); await gate; } }), 'POST', '/api/music-bots/3/queue', { songId: 9 });
    await reached;
    bot.stopGeneration++;
    release();
    assert.equal((await pending).status, 409);
    assert.equal(bot.queue.length, 0);
  });

  it('chat !playlist neither queues nor starts the playlist', async () => {
    const { bot, played } = fakeBot('connected');
    bot.stopGeneration = 0;
    bot.currentConfig.serverConfigId = 1;
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const replies: string[] = [];
    const context: any = {
      voiceBotManager: { getBot: () => bot },
      reply: (_bot: unknown, _clid: number, message: string) => { replies.push(message); },
      saveMusicRequest: () => {},
      chatMusicSwitch: () => ({}),
      prisma: { playlist: {
        findMany: async () => [{ id: 5, name: 'Party' }],
        findFirst: async () => { entered(); await gate; return { id: 5, name: 'Party', songs: [{ song: { id: 100, title: 'P0', filePath: '/music/p.opus', source: 'local' } }] }; },
      } },
    };
    const pending = handlePlaylist(context, 3, bot, 2, '5');
    await reached;
    bot.stopGeneration++;
    release();
    await pending;
    assert.equal(bot.queue.length, 0);
    assert.deepEqual(played, []);
    assert.deepEqual(replies, ['Playback was stopped before the playlist was loaded.']);
  });
});
