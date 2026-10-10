import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { musicBotRoutes } from './music-bots.routes.js';
import { createVideoQueueRoutes, VIDEO_PLAYLIST_CAP } from './video-queue.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { MediaSessionConflictError } from '../voice/media-session.js';
import { VIDEO_QUEUE_MAX, VideoQueueController, type VideoQueueItem } from '../voice/streaming/video-queue.js';

const watch = (n: number) => `https://www.youtube.com/watch?v=${String(n).padStart(11, '0')}`;
const PLAYLIST = 'https://www.youtube.com/playlist?list=PL0000000000000000';
const OTHER_VIDEO = {
  id: '11111111-1111-4111-8111-111111111111', kind: 'video' as const, state: 'active' as const,
  botId: 9, botName: 'Other', label: 'x', startedAt: 0,
};

type Expand = NonNullable<NonNullable<Parameters<typeof createVideoQueueRoutes>[0]>['expandYouTube']>;

function buildApp(opts: { initial?: VideoQueueItem[]; expand?: Expand; conflict?: boolean } = {}) {
  const calls = {
    starts: [] as Array<{ source: string; options: Record<string, unknown> }>,
    switches: [] as string[],
    stops: [] as string[],
    asserted: [] as string[][],
    audits: [] as Array<Record<string, any>>,
    volumeSaves: [] as unknown[],
    expands: [] as Array<{ url: string; cap: number | undefined }>,
  };
  const bot = {
    id: 3,
    status: 'connected',
    currentConfig: { id: 3, serverConfigId: null, volume: 50, name: 'Bot' },
    videoStreaming: false,
    source: null as string | null,
    get videoStreamStatus() {
      return { source: bot.source };
    },
    async setVideoSource(source: string) {
      calls.switches.push(source);
      bot.source = source;
    },
    async stopVideoStream(reason = 'manual') {
      calls.stops.push(reason);
      bot.videoStreaming = false;
      bot.source = null;
      // The manager forwards the bot's videoStreamStopped event to the queue.
      void controller.onStreamStopped({ reason: reason as 'manual', at: 0, detail: null });
    },
    sendChannelMessage() {},
  };
  const controller: VideoQueueController = new VideoQueueController(
    {
      bot,
      async start(source, options) {
        calls.starts.push({ source, options: options as Record<string, unknown> });
        bot.videoStreaming = true;
        bot.source = source;
      },
      store: { async save() {} },
    },
    opts.initial ? { items: opts.initial, options: null } : undefined,
  );
  const manager = {
    getBot: (id: number) => (id === 3 ? bot : undefined),
    getVideoQueue: (id: number) => (id === 3 ? controller : undefined),
    assertVideoCanStart: (_bot: unknown, replaceSessionIds: string[] = []) => {
      calls.asserted.push(replaceSessionIds);
      if (opts.conflict && !replaceSessionIds.includes(OTHER_VIDEO.id)) {
        throw new MediaSessionConflictError('video', [OTHER_VIDEO as any]);
      }
      return [];
    },
    on: () => {},
    off: () => {},
  };
  const expand: Expand = opts.expand ?? (async () => ({ type: 'video', urls: [] }));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: 'admin', username: 'tester' };
    Object.assign(req.app.locals, {
      voiceBotManager: manager,
      prisma: {
        adminAuditEvent: { create: async ({ data }: any) => { calls.audits.push(data); return {}; } },
        musicBot: { update: async (args: unknown) => { calls.volumeSaves.push(args); } },
      },
    });
    next();
  });
  // An injected expander needs its own router; otherwise use the real mount.
  if (opts.expand) {
    app.use('/api/music-bots/:id/stream/queue', createVideoQueueRoutes({
      expandYouTube: async (url, cap) => {
        calls.expands.push({ url, cap });
        return expand(url, cap);
      },
    }));
  }
  app.use('/api/music-bots', musicBotRoutes);
  app.use(errorHandler);

  async function request(method: string, path: string, body?: unknown) {
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/music-bots${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as any };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  return { request, bot, controller, calls };
}

const held = (count: number): VideoQueueItem[] =>
  Array.from({ length: count }, (_, i) => ({ id: `held-${i}`, source: watch(500 + i), title: `Held ${i}`, sourceMode: 'auto' }));

const playlistOf = (count: number): Expand => async (_url, cap) => ({
  type: 'playlist',
  title: 'Road trip',
  urls: Array.from({ length: count }, (_, i) => watch(i + 1)).slice(0, cap),
});

const sources = (items: Array<{ source: string }>) => items.map((i) => i.source);

describe('stream/queue: adding', () => {
  it('queues a video while one is streaming', async () => {
    const app = buildApp();
    await app.request('POST', '/3/stream/queue', { source: watch(1) });
    const res = await app.request('POST', '/3/stream/queue', { source: watch(2) });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.queued, 1);
    assert.equal(res.body.started, false);
    assert.equal(res.body.state.upNext.length, 1);
    assert.equal(res.body.state.upNext[0].source, watch(2));
    assert.equal(res.body.state.upNext[0].addedBy, 'tester');
    assert.equal(app.calls.starts.length, 1);
    assert.equal(app.calls.audits.at(-1)?.action, 'media.video.queue_add');
  });

  it('starts the stream when nothing is playing', async () => {
    const app = buildApp();
    const res = await app.request('POST', '/3/stream/queue', { source: watch(1), preset: '720p' });
    assert.equal(res.status, 200);
    assert.equal(res.body.started, true);
    assert.equal(res.body.queued, 1);
    assert.equal(res.body.state.current.source, watch(1));
    assert.equal(res.body.state.current.title, 'www.youtube.com');
    assert.equal(res.body.state.current.sourceMode, 'auto');
    assert.deepEqual(app.calls.starts.map((s) => s.source), [watch(1)]);
    assert.equal(app.calls.starts[0].options.preset, '720p');
    assert.equal(app.calls.asserted.length, 1);
    assert.equal(app.calls.audits.at(-1)?.action, 'media.video.start');
  });

  it('saves the level a queued start was given, as stream/start does', async () => {
    const app = buildApp();
    app.bot.currentConfig.volume = 35;
    await app.request('POST', '/3/stream/queue', { source: watch(1), volume: 35 });
    assert.deepEqual(app.calls.volumeSaves, [{ where: { id: 3 }, data: { volume: 35 } }]);
    await app.request('POST', '/3/stream/queue', { source: watch(2), volume: 80 });
    assert.equal(app.calls.volumeSaves.length, 1, 'queueing behind a running stream changes no level');
  });

  it('expands a playlist in order', async () => {
    const app = buildApp({ expand: playlistOf(3) });
    const res = await app.request('POST', '/3/stream/queue', { source: PLAYLIST });
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, 3);
    assert.equal(res.body.started, true);
    assert.equal(res.body.playlistTitle, 'Road trip');
    assert.equal(res.body.truncated, undefined);
    assert.equal(res.body.state.current.source, watch(1));
    assert.deepEqual(sources(res.body.state.upNext), [watch(2), watch(3)]);
    assert.deepEqual(app.calls.expands, [{ url: PLAYLIST, cap: VIDEO_PLAYLIST_CAP + 1 }]);
  });

  it('uses the playlist entry titles and durations when the probe has them', async () => {
    const app = buildApp({
      expand: async () => ({
        type: 'playlist',
        urls: [watch(1), watch(2)],
        items: [
          { url: watch(1), title: 'First clip', durationSec: 61 },
          { url: watch(2) },
        ],
      }),
    });
    const res = await app.request('POST', '/3/stream/queue', { source: PLAYLIST });
    assert.equal(res.body.state.current.title, 'First clip');
    assert.equal(res.body.state.current.durationSec, 61);
    assert.equal(res.body.state.upNext[0].title, 'www.youtube.com');
  });

  it('caps a playlist at 25 and says so', async () => {
    const app = buildApp({ expand: playlistOf(26) });
    const res = await app.request('POST', '/3/stream/queue', { source: PLAYLIST });
    assert.equal(res.body.queued, 25);
    assert.equal(res.body.truncated, true);
    assert.equal(res.body.state.upNext.length, 24);
    assert.equal(res.body.state.upNext.at(-1).source, watch(25));
  });

  it('a playlist is cut to the room left', async () => {
    const app = buildApp({ initial: held(VIDEO_QUEUE_MAX - 2), expand: playlistOf(10) });
    app.bot.videoStreaming = true;
    app.bot.source = watch(900);
    // Adopting the running stream takes one of the two free places.
    const res = await app.request('POST', '/3/stream/queue', { source: PLAYLIST });
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, 1);
    assert.equal(res.body.truncated, true);
    assert.equal(res.body.state.upNext.at(-1).source, watch(1));
    assert.equal(app.controller.roomLeft(), 0);
  });

  it('a playlist that fits the room exactly keeps its order', async () => {
    const app = buildApp({ expand: playlistOf(10) });
    await app.request('POST', '/3/stream/queue', { source: watch(900) });
    for (const item of held(VIDEO_QUEUE_MAX - 3)) {
      await app.controller.enqueue([{ source: item.source, title: item.title, sourceMode: 'auto' }]);
    }
    assert.equal(app.controller.roomLeft(), 2);
    const res = await app.request('POST', '/3/stream/queue', { source: PLAYLIST });
    assert.equal(res.body.queued, 2);
    assert.equal(res.body.truncated, true);
    assert.deepEqual(sources(res.body.state.upNext.slice(-2)), [watch(1), watch(2)]);
    assert.deepEqual(app.calls.expands, [{ url: PLAYLIST, cap: 3 }]);
  });

  it('a full lane answers 409 video_queue_full', async () => {
    const app = buildApp({ expand: playlistOf(3) });
    await app.request('POST', '/3/stream/queue', { source: watch(900) });
    for (const item of held(VIDEO_QUEUE_MAX - 1)) {
      await app.controller.enqueue([{ source: item.source, title: item.title, sourceMode: 'auto' }]);
    }
    const single = await app.request('POST', '/3/stream/queue', { source: watch(1) });
    assert.equal(single.status, 409);
    assert.equal(single.body.reason, 'video_queue_full');
    const playlist = await app.request('POST', '/3/stream/queue', { source: PLAYLIST });
    assert.equal(playlist.status, 409);
    assert.equal(playlist.body.reason, 'video_queue_full');
    assert.equal(app.calls.expands.length, 0);
    assert.equal(app.controller.snapshot().upNext.length, VIDEO_QUEUE_MAX - 1);
  });

  it('an empty playlist answers 422', async () => {
    const app = buildApp({ expand: async () => ({ type: 'playlist', urls: [] }) });
    const res = await app.request('POST', '/3/stream/queue', { source: PLAYLIST });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'Could not resolve any videos from that playlist URL');
    assert.equal(app.calls.starts.length, 0);
  });

  it('a video url that carries a list stays one video', async () => {
    const app = buildApp({ expand: playlistOf(3) });
    const source = `${watch(7)}&list=PL0000000000000000`;
    const res = await app.request('POST', '/3/stream/queue', { source });
    assert.equal(res.body.queued, 1);
    assert.equal(res.body.state.current.source, source);
    assert.equal(app.calls.expands.length, 0);
  });

  it('rejects a path-like source', async () => {
    const app = buildApp();
    const res = await app.request('POST', '/3/stream/queue', { source: '../x.mp4' });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, 'source_invalid');
  });

  it('rejects an invalid preset', async () => {
    const app = buildApp();
    const res = await app.request('POST', '/3/stream/queue', { source: watch(1), preset: '999p' });
    assert.equal(res.status, 400);
    assert.equal(app.calls.starts.length, 0);
  });

  it('passes a media session conflict through', async () => {
    const app = buildApp({ conflict: true });
    const res = await app.request('POST', '/3/stream/queue', { source: watch(1) });
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'media_session_conflict');
    assert.equal(app.calls.starts.length, 0);
    assert.equal(app.calls.audits.length, 0);
    const state = await app.request('GET', '/3/stream/queue');
    assert.deepEqual(state.body, { current: null, upNext: [], kept: false });

    const confirmed = await app.request('POST', '/3/stream/queue', { source: watch(1), replaceSessionIds: [OTHER_VIDEO.id] });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(app.calls.starts[0].options.replaceSessionIds, [OTHER_VIDEO.id]);
    assert.equal(app.calls.audits[0].action, 'media.session.switch');
  });

  it('answers 404 for an unknown bot', async () => {
    const app = buildApp();
    const res = await app.request('GET', '/4/stream/queue');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Music bot not found');
  });
});

describe('stream/queue: managing', () => {
  async function streaming(count: number) {
    const app = buildApp();
    await app.request('POST', '/3/stream/queue', { source: watch(1) });
    for (let n = 2; n <= count; n++) await app.request('POST', '/3/stream/queue', { source: watch(n) });
    return app;
  }

  it('remove, move, play-now and clear change upNext', async () => {
    const app = await streaming(5);
    const removed = await app.request('DELETE', '/3/stream/queue/0');
    assert.equal(removed.status, 200);
    assert.deepEqual(sources(removed.body.state.upNext), [watch(3), watch(4), watch(5)]);
    assert.equal(app.calls.audits.at(-1)?.action, 'media.video.queue_change');

    const moved = await app.request('PUT', '/3/stream/queue/move', { from: 0, to: 2 });
    assert.deepEqual(sources(moved.body.state.upNext), [watch(4), watch(5), watch(3)]);

    const played = await app.request('POST', '/3/stream/queue/1/play');
    assert.equal(played.status, 200);
    assert.equal(played.body.state.current.source, watch(5));
    assert.deepEqual(app.calls.switches, [watch(5)]);

    const cleared = await app.request('DELETE', '/3/stream/queue');
    assert.equal(cleared.body.state.upNext.length, 0);
    const state = await app.request('GET', '/3/stream/queue');
    assert.equal(state.body.current.source, watch(5));
    assert.deepEqual(state.body.upNext, []);
  });

  it('bad and out-of-range indexes', async () => {
    const app = await streaming(2);
    for (const [method, path, body] of [
      ['DELETE', '/3/stream/queue/abc'],
      ['DELETE', '/3/stream/queue/-1'],
      ['POST', '/3/stream/queue/1.5/play'],
      ['PUT', '/3/stream/queue/move', { from: 'a', to: 0 }],
      ['PUT', '/3/stream/queue/move', { from: 0, to: -1 }],
      ['PUT', '/3/stream/queue/move', {}],
    ] as const) {
      const res = await app.request(method, path, body);
      assert.equal(res.status, 400, `${method} ${path}`);
      assert.equal(res.body.error, 'Invalid queue index');
    }
    for (const [method, path, body] of [
      ['DELETE', '/3/stream/queue/99'],
      ['POST', '/3/stream/queue/99/play'],
      ['PUT', '/3/stream/queue/move', { from: 0, to: 99 }],
    ] as const) {
      const res = await app.request(method, path, body);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.body.error, 'No queued video at that position');
    }
    assert.equal(app.controller.snapshot().upNext.length, 1);
  });

  it('skip advances', async () => {
    const app = await streaming(2);
    const res = await app.request('POST', '/3/stream/queue/skip');
    assert.equal(res.status, 200);
    assert.deepEqual(app.calls.switches, [watch(2)]);
    assert.equal(res.body.state.current.source, watch(2));
    assert.equal(app.calls.audits.at(-1)?.action, 'media.video.skip');
  });

  it('play starts a kept queue and honours the conflict flow', async () => {
    const app = buildApp({ initial: held(2), conflict: true });
    const refused = await app.request('POST', '/3/stream/queue/play', {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.reason, 'media_session_conflict');
    const res = await app.request('POST', '/3/stream/queue/play', { replaceSessionIds: [OTHER_VIDEO.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.state.current.source, watch(500));
    assert.equal(res.body.state.kept, false);
    assert.deepEqual(app.calls.starts[0].options.replaceSessionIds, [OTHER_VIDEO.id]);
  });

  it('stream/stop clears the lane', async () => {
    const app = await streaming(3);
    const stop = await app.request('POST', '/3/stream/stop');
    assert.equal(stop.status, 200);
    assert.deepEqual(app.calls.stops, ['manual']);
    const state = await app.request('GET', '/3/stream/queue');
    assert.deepEqual(state.body, { current: null, upNext: [], kept: false });
  });

  it('audit rows never carry the source', async () => {
    const app = await streaming(2);
    assert.ok(app.calls.audits.length >= 2);
    assert.doesNotMatch(JSON.stringify(app.calls.audits), /watch\?v=|https?:/);
  });
});
