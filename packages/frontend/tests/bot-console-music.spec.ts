import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

const track = (id: string, title: string) => ({ id, title, artist: 'Artist', duration: 200, source: 'local' });

const state = {
  status: 'playing', position: 75, duration: 214, volume: 60, currentIndex: 0, shuffle: false, repeat: 'off',
  nowPlaying: track('t1', 'Neon Skyline'),
  queue: [track('t1', 'Neon Skyline')],
};

async function mockConsole(page: Page) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await page.route('**/api/music-bots/1/state', (r) => r.fulfill({ json: state }));
  await page.route('**/api/servers/1/music-library/songs/search**', (r) =>
    r.fulfill({
      json: {
        total: 1,
        page: 1,
        pageSize: 50,
        songs: [{
          id: 42, title: 'Neon Skyline', artist: 'Midnight Transit', duration: 214,
          filePath: '/a.ogg', source: 'local', sourceUrl: null, fileSize: 1,
          serverConfigId: 1, createdAt: '2026-10-01T00:00:00.000Z',
        }],
      },
    }));
  await page.route('**/api/playlists**', (r) =>
    r.fulfill({
      json: [{
        id: 7, name: 'Evening Mix', mode: 'local', musicBotId: null, songCount: 3,
        createdAt: '2026-10-01T00:00:00.000Z', serverConfigId: 1,
      }],
    }));
  await page.route('**/api/servers/1/radio-stations', (r) =>
    r.fulfill({
      json: [
        { id: 1, name: 'Chill FM', url: 'https://example.com/chill', genre: 'Chill', imageUrl: null, serverConfigId: 1 },
        { id: 2, name: 'Focus Beats', url: 'https://example.com/focus', genre: 'Focus', imageUrl: null, serverConfigId: 1 },
        { id: 3, name: 'No Genre Station', url: 'https://example.com/other', genre: null, imageUrl: null, serverConfigId: 1 },
      ],
    }));
  await page.route('**/api/servers/1/music-requests', (r) => r.fulfill({ json: [] }));
  await page.route(/\/api\/music-bots\/1\/(play|queue|play-radio|play-url)(\/.*)?$/, async (r) => {
    const req = r.request();
    calls.push({ method: req.method(), url: req.url(), body: req.postDataJSON?.() ?? null });
    await r.fulfill({ json: { success: true } });
  });
  return calls;
}

test('playing a song from the Music tab sends play with the song id', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const calls = await mockConsole(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');

  await page.getByRole('tab', { name: 'Music' }).click();
  await expect(page.getByRole('tab', { name: 'Songs', selected: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play Neon Skyline' }).click();
  await expect.poll(() => calls.find((c) => c.url.includes('/play') && !c.url.includes('play-radio') && !c.url.includes('play-url')))
    .toMatchObject({ method: 'POST', body: { songId: 42 } });
});

test('queueing a playlist appends without clearing the queue', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const calls = await mockConsole(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');

  await page.getByRole('tab', { name: 'Music' }).click();
  await page.getByRole('tab', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'Queue Evening Mix' }).click();
  await expect.poll(() => calls.find((c) => c.url.includes('/queue/playlist')))
    .toMatchObject({ method: 'POST', body: { playlistId: 7, clearFirst: false } });
});

test('a radio mood chip filters the station list', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockConsole(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');

  await page.getByRole('tab', { name: 'Radio' }).click();
  await expect(page.getByText('Chill FM')).toBeVisible();
  await expect(page.getByText('Focus Beats')).toBeVisible();
  await expect(page.getByText('No Genre Station')).toBeVisible();

  await page.getByRole('button', { name: 'Chill (1)' }).click();
  await expect(page.getByText('Chill FM')).toBeVisible();
  await expect(page.getByText('Focus Beats')).toHaveCount(0);
  await expect(page.getByText('No Genre Station')).toHaveCount(0);
  await expect(page.getByText('Moods come from each station\'s genre. Set or change it under Media Library → Radio stations.')).toBeVisible();
});
