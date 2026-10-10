import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MediaStopInfo, MediaStopReason, VideoQueueState, VideoSourceModeRequest } from '@ts6/common';
import type { VideoStreamStartOptions } from '../voice-bot.js';
import {
  VIDEO_QUEUE_MAX,
  VideoQueueController,
  VideoQueueFullError,
  type NewVideoQueueItem,
  type VideoQueueItem,
  type VideoQueueSessionOptions,
} from './video-queue.js';

function fakeBot() {
  const bot = {
    videoStreaming: false,
    source: null as string | null,
    get videoStreamStatus() {
      return { source: bot.source };
    },
    setCalls: [] as Array<{ source: string; volume?: number; sourceMode?: VideoSourceModeRequest }>,
    stopCalls: [] as Array<[MediaStopReason | undefined, string | null | undefined]>,
    messages: [] as string[],
    failures: 0,
    /** Runs inside each setVideoSource call, before it resolves or fails. */
    gate: null as null | (() => Promise<void>),
    failNext(n: number) {
      bot.failures = n;
    },
    async setVideoSource(source: string, volume?: number, sourceMode?: VideoSourceModeRequest) {
      bot.setCalls.push({ source, volume, sourceMode });
      if (bot.gate) await bot.gate();
      if (bot.failures > 0) {
        bot.failures--;
        throw new Error('Could not load video');
      }
      bot.source = source;
    },
    async stopVideoStream(reason?: MediaStopReason, detail?: string | null) {
      bot.stopCalls.push([reason, detail]);
      bot.videoStreaming = false;
      bot.source = null;
    },
    sendChannelMessage(msg: string) {
      bot.messages.push(msg);
    },
  };
  return bot;
}

const url = (n: number) => `https://video.example.test/watch?v=${n}`;
const video = (n: number): NewVideoQueueItem => ({ source: url(n), title: `Video ${n}`, sourceMode: 'auto' });
const videos = (count: number, from = 1) => Array.from({ length: count }, (_, i) => video(from + i));
const stopped = (reason: MediaStopReason): MediaStopInfo => ({ reason, at: 0, detail: null });
const sources = (items: Array<{ source: string }>) => items.map((i) => i.source);

function harness(initial?: { items: VideoQueueItem[]; options: VideoQueueSessionOptions | null }) {
  const bot = fakeBot();
  const starts: Array<{ source: string; options: VideoStreamStartOptions }> = [];
  const saves: Array<{ items: VideoQueueItem[]; options: VideoQueueSessionOptions | null }> = [];
  const changes: VideoQueueState[] = [];
  const h = {
    bot,
    starts,
    saves,
    changes,
    startError: null as Error | null,
    saveError: null as Error | null,
    controller: null as unknown as VideoQueueController,
    /** What the manager does when the bot reports a stop. */
    async streamStopped(reason: MediaStopReason) {
      bot.videoStreaming = false;
      bot.source = null;
      await h.controller.onStreamStopped(stopped(reason));
    },
  };
  let nextId = 0;
  h.controller = new VideoQueueController(
    {
      bot,
      async start(source, options) {
        starts.push({ source, options });
        if (h.startError) throw h.startError;
        bot.videoStreaming = true;
        bot.source = source;
      },
      store: {
        async save(items, options) {
          saves.push({ items: items.map((i) => ({ ...i })), options });
          if (h.saveError) throw h.saveError;
        },
      },
      onChange: (state) => changes.push(state),
      newId: () => `id-${++nextId}`,
    },
    initial,
  );
  return h;
}

describe('video queue: enqueue', () => {
  it('enqueue with nothing streaming starts the first item', async () => {
    const h = harness();
    const result = await h.controller.enqueue(videos(2));
    assert.deepEqual(result, { queued: 2, started: true });
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].source, url(1));
    const state = h.controller.snapshot();
    assert.equal(state.current?.source, url(1));
    assert.equal(state.upNext.length, 1);
    assert.equal(state.kept, false);
  });

  it('enqueue while streaming appends without touching the stream', async () => {
    const h = harness();
    await h.controller.enqueue(videos(1));
    const result = await h.controller.enqueue(videos(2, 2));
    assert.deepEqual(result, { queued: 2, started: false });
    assert.equal(h.starts.length, 1);
    assert.equal(h.bot.setCalls.length, 0);
    assert.deepEqual(sources(h.controller.snapshot().upNext), [url(2), url(3)]);
  });

  it('enqueue adopts a running one-shot stream as current', async () => {
    const h = harness();
    h.bot.videoStreaming = true;
    h.bot.source = 'https://live.example.test/stream.m3u8';
    await h.controller.enqueue(videos(1));
    const state = h.controller.snapshot();
    assert.equal(state.current?.source, 'https://live.example.test/stream.m3u8');
    assert.equal(state.current?.title, 'live.example.test');
    assert.equal(state.upNext[0].source, url(1));
    assert.equal(h.starts.length, 0);
  });

  it('a failed start removes the items it added', async () => {
    const h = harness();
    h.startError = new Error('Sidecar is not reachable');
    await assert.rejects(h.controller.enqueue(videos(2)), /Sidecar is not reachable/);
    assert.deepEqual(h.controller.snapshot(), { current: null, upNext: [], kept: false });
  });

  it('the same url queued twice gives two entries', async () => {
    const h = harness();
    await h.controller.enqueue(videos(1));
    await h.controller.enqueue([video(2)]);
    await h.controller.enqueue([video(2)]);
    const [first, second] = h.controller.snapshot().upNext;
    assert.equal(first.source, second.source);
    assert.notEqual(first.id, second.id);
    assert.equal(await h.controller.remove(0), true);
    const left = h.controller.snapshot().upNext;
    assert.equal(left.length, 1);
    assert.equal(left[0].id, second.id);
    assert.equal(left[0].source, url(2));
  });

  it('enqueue truncates to the room left and throws when full', async () => {
    const h = harness();
    await h.controller.enqueue(videos(VIDEO_QUEUE_MAX - 1));
    assert.equal(h.controller.roomLeft(), 1);
    const result = await h.controller.enqueue(videos(3, 200));
    assert.equal(result.queued, 1);
    assert.equal(h.controller.snapshot().upNext.at(-1)?.source, url(200));
    assert.equal(h.controller.roomLeft(), 0);
    await assert.rejects(h.controller.enqueue([video(300)]), (err: unknown) => {
      assert.ok(err instanceof VideoQueueFullError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.reason, 'video_queue_full');
      return true;
    });
  });
});

describe('video queue: a source finishes', () => {
  it('clean end advances to the next item', async () => {
    const h = harness();
    await h.controller.enqueue(videos(3));
    assert.equal(await h.controller.onSourceFinished('source_ended', null), true);
    assert.equal(h.bot.setCalls.length, 1);
    assert.equal(h.bot.setCalls[0].source, url(2));
    const state = h.controller.snapshot();
    assert.equal(state.current?.source, url(2));
    assert.deepEqual(sources(state.upNext), [url(3)]);
  });

  it('clean end with nothing upcoming lets the stream stop', async () => {
    const h = harness();
    await h.controller.enqueue(videos(1));
    assert.equal(await h.controller.onSourceFinished('source_ended', null), false);
    assert.equal(h.bot.setCalls.length, 0);
    await h.streamStopped('source_ended');
    assert.deepEqual(h.controller.snapshot(), { current: null, upNext: [], kept: false });
  });

  it('a failing next item is skipped with a notice', async () => {
    const h = harness();
    await h.controller.enqueue(videos(3));
    h.bot.failNext(1);
    assert.equal(await h.controller.onSourceFinished('source_ended', null), true);
    assert.equal(h.bot.messages.length, 1);
    assert.equal(h.bot.messages[0], 'Skipped "Video 2": could not play it.');
    const state = h.controller.snapshot();
    assert.equal(state.current?.source, url(3));
    assert.equal(state.upNext.length, 0);
  });

  it('three failures in a row stop the stream and keep the rest', async () => {
    const h = harness();
    await h.controller.enqueue(videos(5));
    h.bot.failNext(3);
    await h.controller.onSourceFinished('source_ended', null);
    assert.equal(h.bot.stopCalls.length, 1);
    assert.equal(h.bot.stopCalls[0][0], 'source_unreachable');
    assert.equal(h.bot.stopCalls[0][1], 'Stopped after 3 videos in a row failed');
    assert.equal(h.bot.setCalls.length, 3);
    await h.streamStopped('source_unreachable');
    const state = h.controller.snapshot();
    assert.deepEqual(sources(state.upNext), [url(5)]);
    assert.equal(state.current, null);
    assert.equal(state.kept, true);
  });

  it('a success resets the failure count', async () => {
    const h = harness();
    await h.controller.enqueue(videos(7));
    h.bot.failNext(2);
    assert.equal(await h.controller.onSourceFinished('source_ended', null), true);
    assert.equal(h.controller.snapshot().current?.source, url(4));
    h.bot.failNext(2);
    assert.equal(await h.controller.onSourceFinished('source_ended', null), true);
    assert.equal(h.controller.snapshot().current?.source, url(7));
    assert.equal(h.bot.stopCalls.length, 0);
  });

  it('source_unreachable on the current item skips it', async () => {
    const h = harness();
    await h.controller.enqueue(videos(2));
    assert.equal(await h.controller.onSourceFinished('source_unreachable', 'HTTP 404'), true);
    assert.equal(h.controller.snapshot().current?.source, url(2));
    assert.deepEqual(h.bot.messages, ['Skipped "Video 1": could not play it.']);
  });

  it('other reasons are not handled', async () => {
    const h = harness();
    await h.controller.enqueue(videos(2));
    assert.equal(await h.controller.onSourceFinished('no_viewers', null), false);
    assert.equal(h.bot.setCalls.length, 0);
    assert.equal(h.controller.snapshot().current?.source, url(1));
  });

  it('stop during an advance is not a failure', async () => {
    const h = harness();
    await h.controller.enqueue(videos(3));
    h.bot.gate = async () => {
      h.bot.videoStreaming = false;
      throw new Error('No active video stream');
    };
    assert.equal(await h.controller.onSourceFinished('source_ended', null), false);
    assert.equal(h.bot.messages.length, 0);
    assert.equal(h.bot.setCalls.length, 1);
    assert.equal(h.bot.stopCalls.length, 0);
    const state = h.controller.snapshot();
    assert.equal(state.current, null);
    assert.deepEqual(sources(state.upNext), [url(2), url(3)]);
  });
});

describe('video queue: the stream stops', () => {
  it('auto-stop keeps the lane and rewinds', async () => {
    const h = harness();
    await h.controller.enqueue(videos(2));
    await h.streamStopped('no_viewers');
    const state = h.controller.snapshot();
    assert.equal(state.current, null);
    assert.equal(state.upNext[0].source, url(1));
    assert.equal(state.upNext.length, 2);
    assert.equal(state.kept, true);
  });

  it('manual stop clears the lane', async () => {
    const h = harness();
    await h.controller.enqueue(videos(2), { preset: '720p' });
    await h.streamStopped('manual');
    assert.deepEqual(h.controller.snapshot(), { current: null, upNext: [], kept: false });
    assert.deepEqual(h.saves.at(-1), { items: [], options: null });
  });

  it('replaced_by_music, sidecar_failure, server_disconnect and bot_stopped keep the lane', async () => {
    for (const reason of ['replaced_by_music', 'sidecar_failure', 'server_disconnect', 'bot_stopped'] as const) {
      const h = harness();
      await h.controller.enqueue(videos(2));
      await h.streamStopped(reason);
      const state = h.controller.snapshot();
      assert.equal(state.kept, true, reason);
      assert.deepEqual(sources(state.upNext), [url(1), url(2)], reason);
    }
  });

  it('a stop with no recorded reason keeps the lane', async () => {
    const h = harness();
    await h.controller.enqueue(videos(2));
    h.bot.videoStreaming = false;
    await h.controller.onStreamStopped(null);
    assert.equal(h.controller.snapshot().kept, true);
  });
});

describe('video queue: controls', () => {
  it('playQueue starts the first upcoming item with stored options', async () => {
    const h = harness();
    const replaceSessionIds = ['11111111-1111-4111-8111-111111111111'];
    await h.controller.enqueue(videos(2), { preset: '720p', framerate: 30, volume: 40, replaceSessionIds });
    assert.deepEqual(h.starts[0].options.replaceSessionIds, replaceSessionIds);
    assert.equal(h.starts[0].options.volume, 40);
    await h.streamStopped('no_viewers');
    await h.controller.playQueue();
    assert.equal(h.starts.length, 2);
    assert.equal(h.starts[1].source, url(1));
    assert.equal(h.starts[1].options.preset, '720p');
    assert.equal(h.starts[1].options.framerate, 30);
    assert.equal(h.starts[1].options.volume, undefined);
    assert.equal(h.starts[1].options.replaceSessionIds, undefined);
    const state = h.controller.snapshot();
    assert.equal(state.current?.source, url(1));
    assert.equal(state.kept, false);
  });

  it('skip advances, and stops when nothing is upcoming', async () => {
    const h = harness();
    await h.controller.enqueue(videos(2));
    await h.controller.skip();
    assert.equal(h.bot.setCalls[0].source, url(2));
    assert.equal(h.controller.snapshot().current?.source, url(2));
    assert.equal(h.bot.stopCalls.length, 0);
    await h.controller.skip();
    assert.deepEqual(h.bot.stopCalls, [['manual', 'Skipped the last queued video']]);
    assert.equal(h.bot.setCalls.length, 1);
  });

  it('two quick skips act in order', async () => {
    const h = harness();
    await h.controller.enqueue(videos(4));
    const releases: Array<() => void> = [];
    h.bot.gate = () => new Promise<void>((resolve) => releases.push(resolve));
    const first = h.controller.skip();
    const second = h.controller.skip();
    await new Promise((resolve) => setImmediate(resolve));
    // The second skip waits for the first: only one swap is in flight.
    assert.equal(h.bot.setCalls.length, 1);
    releases[0]();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.bot.setCalls.length, 2);
    releases[1]();
    await second;
    assert.deepEqual(sources(h.bot.setCalls), [url(2), url(3)]);
    const state = h.controller.snapshot();
    assert.equal(state.current?.source, url(3));
    assert.deepEqual(sources(state.upNext), [url(4)]);
  });

  it('remove, move and playAt use upcoming indexes and never touch current', async () => {
    const h = harness();
    await h.controller.enqueue(videos(5));
    assert.equal(await h.controller.remove(0), true);
    assert.deepEqual(sources(h.controller.snapshot().upNext), [url(3), url(4), url(5)]);
    assert.equal(await h.controller.move(0, 2), true);
    assert.deepEqual(sources(h.controller.snapshot().upNext), [url(4), url(5), url(3)]);
    assert.equal(h.controller.snapshot().current?.source, url(1));

    assert.equal(await h.controller.remove(3), false);
    assert.equal(await h.controller.remove(-1), false);
    assert.equal(await h.controller.move(0, 3), false);
    assert.equal(await h.controller.move(3, 0), false);
    await assert.rejects(h.controller.playAt(3), /No queued video at that position/);
    assert.equal(h.controller.snapshot().current?.source, url(1));
    assert.equal(h.bot.setCalls.length, 0);

    await h.controller.playAt(1);
    assert.equal(h.bot.setCalls[0].source, url(5));
    const state = h.controller.snapshot();
    assert.equal(state.current?.source, url(5));
    assert.deepEqual(sources(state.upNext), [url(4), url(3)]);
  });

  it('clear drops upcoming and keeps current', async () => {
    const h = harness();
    await h.controller.enqueue(videos(3));
    await h.controller.clear();
    const state = h.controller.snapshot();
    assert.equal(state.current?.source, url(1));
    assert.equal(state.upNext.length, 0);
    assert.equal(h.bot.stopCalls.length, 0);
  });
});

describe('video queue: persistence', () => {
  it('initial items load rewound', () => {
    const items: VideoQueueItem[] = videos(2).map((v, i) => ({ ...v, id: `saved-${i}` }));
    const h = harness({ items, options: { preset: '480p' } });
    const state = h.controller.snapshot();
    assert.equal(state.kept, true);
    assert.equal(state.current, null);
    assert.deepEqual(sources(state.upNext), [url(1), url(2)]);
  });

  it('every change is saved and announced', async () => {
    const h = harness();
    await h.controller.enqueue(videos(4));
    assert.equal(h.saves.length, 1);
    assert.equal(h.changes.length, 1);
    await h.controller.remove(0);
    assert.equal(h.saves.length, 2);
    assert.equal(h.changes.length, 2);
    await h.controller.move(0, 1);
    assert.equal(h.saves.length, 3);
    assert.equal(h.changes.length, 3);
    assert.deepEqual(sources(h.saves[2].items), [url(1), url(4), url(3)]);
    assert.deepEqual(h.changes[2], h.controller.snapshot());
  });

  it('saved session options never carry volume, replaceSessionIds or localHosts', async () => {
    const h = harness();
    await h.controller.enqueue(videos(1), {
      preset: '720p',
      encoder: 'vp8',
      framerate: 30,
      bitrate: '2500k',
      noViewerTimeoutSec: 60,
      volume: 40,
      replaceSessionIds: ['11111111-1111-4111-8111-111111111111'],
      localHosts: ['10.0.0.5'],
      sourceMode: 'vod',
    });
    assert.deepEqual(h.saves[0].options, {
      preset: '720p',
      encoder: 'vp8',
      framerate: 30,
      bitrate: '2500k',
      noViewerTimeoutSec: 60,
    });
  });

  it('a failing save is logged and does not break the change', async (t) => {
    const h = harness();
    const logged = t.mock.method(console, 'error', () => {});
    h.saveError = new Error('database is locked');
    await h.controller.enqueue(videos(2));
    assert.equal(await h.controller.onSourceFinished('source_ended', null), true);
    assert.equal(h.controller.snapshot().current?.source, url(2));
    assert.ok(logged.mock.callCount() >= 1);
    assert.equal(h.changes.length, 2);
  });
});
