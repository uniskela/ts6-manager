import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { MediaSessionConflictBody } from '@ts6/common';
import { isMediaSessionConflict } from '../src/lib/media-switch';

async function signIn(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

const noStop = { lastMusicStop: null, lastVideoStop: null };

function media(now: number) {
  return [
    {
      botId: 1, botName: 'Aurora Radio', serverConfigId: 1, serverName: 'Operations Voice', status: 'playing',
      channelId: 5, channelName: 'Lounge',
      session: { id: 'a', kind: 'music', state: 'active', botId: 1, botName: 'Aurora Radio', startedAt: now - 90_000, label: 'Neon Skyline' },
      music: { title: 'Neon Skyline', artist: 'Midnight Transit', live: false, position: 75, duration: 214 },
      video: null, ...noStop,
    },
  ];
}

const state = {
  status: 'playing', position: 75, duration: 214, volume: 60, currentIndex: 0, shuffle: false, repeat: 'off',
  nowPlaying: { id: 't1', title: 'Neon Skyline', artist: 'Artist', duration: 200, source: 'local' },
  queue: [{ id: 't1', title: 'Neon Skyline', artist: 'Artist', duration: 200, source: 'local' }],
};

/** Conflict body recognised by lib/media-switch.ts (opens "Replace what is playing?"). */
const mediaConflict: MediaSessionConflictBody = {
  error: 'Music is playing on Aurora Radio.',
  reason: 'media_session_conflict',
  requested: 'video',
  conflicts: [
    { id: 'a', kind: 'music', state: 'active', botId: 1, botName: 'Aurora Radio', startedAt: 0, label: 'Neon Skyline' },
  ],
};

async function mockConsole(page: Page) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await page.route('**/api/music-bots/1/state', (r) => r.fulfill({ json: state }));
  await page.route('**/api/settings/video-streaming/servers/1', (r) => r.fulfill({ json: {
    global: {}, overrides: {}, effective: { defaultEncoder: 'h264_vaapi', noViewerTimeoutSec: 900 },
  } }));
  await page.route('**/api/music-bots/1/play-url', async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill({ json: { success: true, queued: 1 } });
  });
  await page.route('**/api/music-bots/1/stream/start', async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill({ json: { success: true } });
  });
  return calls;
}

test.beforeAll(() => {
  expect(isMediaSessionConflict(mediaConflict)).toBe(true);
});

test('Play as music sends play-url with the URL', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const calls = await mockConsole(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');

  await page.getByRole('tab', { name: 'Link' }).click();
  await page.getByLabel('YouTube, Twitch, direct link, or a file already in the music folder')
    .fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByRole('radio', { name: 'Play as music' }).check();
  await page.getByRole('button', { name: 'Play as music' }).click();

  await expect.poll(() => calls.find((c) => c.url.includes('/play-url'))?.body).toEqual({
    url: 'https://youtu.be/dQw4w9WgXcQ',
    enqueue: false,
  });
});

test('Stream as video sends stream/start with the source and chosen options', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const calls = await mockConsole(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');

  await page.getByRole('tab', { name: 'Link' }).click();
  await page.getByLabel('YouTube, Twitch, direct link, or a file already in the music folder')
    .fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByRole('radio', { name: 'Stream as video' }).check();
  await expect(page.locator('summary', { hasText: 'Video options' })).toContainText(/default/i);
  await page.locator('summary', { hasText: 'Video options' }).click();
  await page.locator('#vo-quality').selectOption('1080p');
  await page.locator('#vo-encoder').selectOption('h264_vaapi');
  await page.locator('#vo-noviewer').selectOption('600');
  await page.locator('#vo-source').selectOption('live');
  await page.getByRole('button', { name: 'Stream as video' }).click();

  await expect.poll(() => calls.find((c) => c.url.includes('/stream/start'))?.body).toEqual({
    source: 'https://youtu.be/dQw4w9WgXcQ',
    preset: '1080p',
    encoder: 'h264_vaapi',
    noViewerTimeoutSec: 600,
    sourceMode: 'live',
  });
});

test('Stream as video inherits bot and server defaults when no overrides are chosen', async ({ page, request }) => {
  const calls = await mockConsole(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'Link' }).click();
  await page.getByLabel('YouTube, Twitch, direct link, or a file already in the music folder')
    .fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByRole('radio', { name: 'Stream as video' }).check();
  await page.getByRole('button', { name: 'Stream as video' }).click();

  await expect.poll(() => calls.find((c) => c.url.includes('/stream/start'))?.body).toEqual({
    source: 'https://youtu.be/dQw4w9WgXcQ', sourceMode: 'auto',
  });
});

test('a 409 media_session_conflict opens Replace what is playing?', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockConsole(page);
  await page.route('**/api/music-bots/1/stream/start', (r) =>
    r.fulfill({ status: 409, json: mediaConflict }));
  await signIn(page, request);
  await page.goto('/bot-hub/1');

  await page.getByRole('tab', { name: 'Link' }).click();
  await page.getByLabel('YouTube, Twitch, direct link, or a file already in the music folder')
    .fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByRole('radio', { name: 'Stream as video' }).check();
  await page.getByRole('button', { name: 'Stream as video' }).click();

  await expect(page.getByRole('heading', { name: 'Replace what is playing?' })).toBeVisible();
  await expect(page.getByText('Music “Neon Skyline” on Aurora Radio')).toBeVisible();
});

test('duplicate-stream 409 shows structured copy, not Internal server error', async ({ page, request }) => {
  await mockConsole(page);
  await page.route('**/api/music-bots/1/stream/start', (r) => r.fulfill({
    status: 409,
    json: {
      error: 'A video is already streaming',
      details: 'amf-test.mp4 is already playing on this bot. Stop the current stream or use Switch source.',
      reason: 'stream_already_running',
    },
  }));
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'Link' }).click();
  await page.getByLabel('YouTube, Twitch, direct link, or a file already in the music folder').fill('amf-test.mp4');
  await page.getByRole('button', { name: 'Stream as video' }).click();
  await expect(page.getByRole('alert')).toContainText('A video is already streaming');
  await expect(page.getByRole('alert')).toContainText('amf-test.mp4');
  await expect(page.getByText('Internal server error')).toHaveCount(0);
});

test('unexpected 500 is generic and clears after a successful retry and mode change', async ({ page, request }) => {
  let fail = true;
  await mockConsole(page);
  await page.route('**/api/music-bots/1/stream/start', async (r) => {
    if (fail) {
      await r.fulfill({
        status: 500,
        json: {
          error: 'Something went wrong while starting the stream',
          details: 'Try again. If it keeps happening, check the server logs.',
          reason: 'unexpected_error',
          errorId: 'deadbeef',
        },
      });
      return;
    }
    await r.fulfill({ json: { success: true } });
  });
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'Link' }).click();
  await page.getByLabel('YouTube, Twitch, direct link, or a file already in the music folder')
    .fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByRole('radio', { name: 'Stream as video' }).check();
  await page.getByRole('button', { name: 'Stream as video' }).click();
  await expect(page.getByRole('alert')).toContainText('Something went wrong while starting the stream');
  await expect(page.getByText('password=secret')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Play as music' }).check();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Stream as video' }).check();
  fail = false;
  await page.getByRole('button', { name: 'Stream as video' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('with a video streaming, the Link tab queues the next video', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const calls = await mockConsole(page);
  const now = Date.now();
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: [{
    ...media(now)[0],
    status: 'connected',
    session: { id: 'v', kind: 'video', state: 'active', botId: 1, botName: 'Aurora Radio', startedAt: now - 30_000, label: 'www.youtube.com' },
    music: null,
    video: {
      streaming: true, streamId: 's', preset: '1080p', framerate: 30, bitrate: '4500k', startedAt: now - 30_000,
      viewerCount: 1,
      quality: { requested: 'auto', actual: '1080p', width: 1920, height: 1080, sourceWidth: 1920, sourceHeight: 1080, note: null },
      encoder: { requested: 'auto', selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null, note: null },
      noViewer: { timeoutSec: 300, stopAt: null }, lastStop: null,
    },
  }] }));
  await page.route('**/api/music-bots/1/stream/status', (r) => r.fulfill({ json: { streaming: true, viewerCount: 1, viewers: [] } }));
  const empty = { current: null, upNext: [], kept: false };
  await page.route('**/api/music-bots/1/stream/queue', async (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ json: empty });
    calls.push({ method: 'POST', url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill({ json: { success: true, queued: 1, started: false, state: empty } });
  });
  await signIn(page, request);
  await page.goto('/bot-hub/1');

  await page.getByRole('tab', { name: 'Link' }).click();
  await page.getByLabel('YouTube, Twitch, direct link, or a file already in the music folder')
    .fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByRole('radio', { name: 'Stream as video' }).check();
  await page.getByRole('button', { name: 'Queue as video' }).click();

  await expect.poll(() => calls.find((c) => c.url.endsWith('/stream/queue'))?.body).toEqual({
    source: 'https://youtu.be/dQw4w9WgXcQ',
    sourceMode: 'auto',
  });
  expect(calls.some((c) => c.url.includes('/stream/start'))).toBe(false);
  await expect(page.getByText('Added to Up next')).toBeVisible();
});
