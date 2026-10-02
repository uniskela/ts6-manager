import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppleMusicResolved, AppleMusicTrack } from './audio/apple-music.js';
import type { QueueItem } from './playlist/queue.js';
import { runMediaUrlPipeline, type MediaUrlPipelineDeps, type MediaUrlTarget } from './media-url-pipeline.js';

function item(url: string, index = 0): QueueItem {
  return {
    id: `item-${index}-${url}`,
    title: `Track ${index}`,
    artist: 'Artist',
    duration: 120,
    filePath: `/music/${index}.opus`,
    source: 'youtube',
    sourceUrl: url,
  };
}

function fakeDeps(overrides: Partial<MediaUrlPipelineDeps> = {}): MediaUrlPipelineDeps {
  return {
    resolveSpotify: async (url) => url,
    resolveAppleMusic: async (): Promise<AppleMusicResolved> => ({ tracks: [] }),
    appleTrackToYouTube: async (track) => `https://www.youtube.com/watch?v=${track.title}`,
    expandYouTube: async () => null,
    downloadTrack: async (url) => item(url),
    ...overrides,
  };
}

function fakeTarget(overrides: Partial<MediaUrlTarget> = {}) {
  const calls = {
    play: [] as Array<{ item: QueueItem; opts: { replaceSessionIds?: string[] } }>,
    enqueue: [] as QueueItem[],
  };
  const target: MediaUrlTarget = {
    play: async (track, opts) => { calls.play.push({ item: track, opts }); },
    enqueue: (track) => { calls.enqueue.push(track); },
    isIdle: () => false,
    ...overrides,
  };
  return { target, calls };
}

async function flushBackground(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('single YouTube URL plays immediately', async () => {
  const { target, calls } = fakeTarget();

  await runMediaUrlPipeline(
    fakeDeps({ downloadTrack: async (url) => item(url, 1) }),
    target,
    { url: 'https://www.youtube.com/watch?v=00000000001', enqueueOnly: false },
  );

  assert.equal(calls.play.length, 1);
  assert.equal(calls.play[0].item.sourceUrl, 'https://www.youtube.com/watch?v=00000000001');
  assert.equal(calls.enqueue.length, 0);
});

test('Spotify URL resolves to YouTube before playback', async () => {
  const { target, calls } = fakeTarget();
  const resolved = 'https://www.youtube.com/watch?v=00000000001';
  let resolvedInput = '';

  await runMediaUrlPipeline(
    fakeDeps({
      resolveSpotify: async (url) => { resolvedInput = url; return resolved; },
      downloadTrack: async (url) => item(url),
    }),
    target,
    { url: 'https://open.spotify.com/track/example', enqueueOnly: false },
  );

  assert.equal(resolvedInput, 'https://open.spotify.com/track/example');
  assert.equal(calls.play[0].item.sourceUrl, resolved);
});

test('enqueueOnly never starts playback', async () => {
  const { target, calls } = fakeTarget();
  const urls = ['https://www.youtube.com/watch?v=one', 'https://www.youtube.com/watch?v=two'];

  await runMediaUrlPipeline(
    fakeDeps({
      expandYouTube: async () => ({ urls }),
      downloadTrack: async (url) => item(url),
    }),
    target,
    { url: 'https://www.youtube.com/playlist?list=queue-only', enqueueOnly: true },
  );
  await flushBackground();

  assert.equal(calls.play.length, 0);
  assert.deepEqual(calls.enqueue.map((track) => track.sourceUrl), urls);
});

test('YouTube playlist plays first, queues the rest in order, capped at 25', async () => {
  const { target, calls } = fakeTarget();
  const urls = Array.from({ length: 30 }, (_, index) => `https://www.youtube.com/watch?v=${String(index).padStart(11, '0')}`);

  const result = await runMediaUrlPipeline(
    fakeDeps({
      expandYouTube: async (_url, cap) => ({ urls: urls.slice(0, cap + 5) }),
      downloadTrack: async (url) => item(url),
    }),
    target,
    { url: 'https://www.youtube.com/playlist?list=capped', enqueueOnly: false },
  );
  await flushBackground();

  assert.equal(calls.play.length, 1);
  assert.deepEqual(calls.enqueue.map((track) => track.sourceUrl), urls.slice(1, 25));
  assert.equal(result.queuedInBackground, 24);
});

test('Apple Music resolves each track via YouTube search; unmatched tracks are skipped', async () => {
  const { target, calls } = fakeTarget();
  const tracks: AppleMusicTrack[] = [
    { artist: 'A', title: 'one' },
    { artist: 'B', title: 'two' },
    { artist: 'C', title: 'three' },
    { artist: 'D', title: 'four' },
  ];
  const backgroundErrors: Array<{ error: Error; label: string }> = [];

  await runMediaUrlPipeline(
    fakeDeps({
      resolveAppleMusic: async () => ({ tracks, title: 'Album' }),
      appleTrackToYouTube: async (track) => track.title === 'three' ? null : `https://youtu.be/${track.title}`,
      downloadTrack: async (url) => item(url),
    }),
    target,
    {
      url: 'https://music.apple.com/us/album/album/123',
      enqueueOnly: false,
    },
    { onBackgroundError: (error, label) => backgroundErrors.push({ error, label }) },
  );
  await flushBackground();

  assert.equal(calls.play.length, 1);
  assert.deepEqual(calls.enqueue.map((track) => track.sourceUrl), [
    'https://youtu.be/two',
    'https://youtu.be/four',
  ]);
  assert.equal(backgroundErrors.length, 1);
});

test('first track ended before the next was ready resumes playback', async () => {
  const { target, calls } = fakeTarget({ isIdle: () => true });
  let releaseSecond!: () => void;
  const secondReady = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let downloads = 0;

  const run = runMediaUrlPipeline(
    fakeDeps({
      expandYouTube: async () => ({ urls: ['https://www.youtube.com/watch?v=00000000001', 'https://www.youtube.com/watch?v=00000000002'] }),
      downloadTrack: async (url) => {
        downloads++;
        if (downloads === 2) await secondReady;
        return item(url, downloads);
      },
    }),
    target,
    { url: 'https://www.youtube.com/playlist?list=resume', enqueueOnly: false },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseSecond();
  await run;
  await flushBackground();

  assert.equal(calls.play.length, 2);
  assert.equal(calls.play[1].item.sourceUrl, 'https://www.youtube.com/watch?v=00000000002');
  assert.equal(calls.enqueue.length, 0);
});

test('pipeline preserves exact resolution error messages', async () => {
  const { target } = fakeTarget();

  await assert.rejects(
    runMediaUrlPipeline(
      fakeDeps({ resolveAppleMusic: async () => ({ tracks: [] }) }),
      target,
      { url: 'https://music.apple.com/us/album/empty/123', enqueueOnly: false },
    ),
    { message: 'Could not resolve any tracks from that Apple Music URL' },
  );

  await assert.rejects(
    runMediaUrlPipeline(
      fakeDeps({ expandYouTube: async () => ({ urls: [] }) }),
      target,
      { url: 'https://www.youtube.com/playlist?list=empty', enqueueOnly: false },
    ),
    { message: 'Could not resolve any videos from that playlist URL' },
  );

  await assert.rejects(
    runMediaUrlPipeline(fakeDeps(), target, {
      url: 'https://www.youtube.com/channel/not-a-video',
      enqueueOnly: false,
    }),
    { message: 'Could not resolve that YouTube URL' },
  );
});
