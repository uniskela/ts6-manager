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
  await expect(page.locator('summary', { hasText: 'Video options' })).toContainText('Auto · Auto encoder');
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
