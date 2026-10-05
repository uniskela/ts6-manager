import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

const noStop = { lastMusicStop: null, lastVideoStop: null };
const idleBot = {
  botId: 3, botName: 'Backup Bot', serverConfigId: 1, serverName: 'Operations Voice', status: 'connected',
  channelId: 2, channelName: 'Lobby', session: null, music: null, video: null, ...noStop,
};
const musicBot = {
  botId: 1, botName: 'Aurora Radio', serverConfigId: 1, serverName: 'Operations Voice', status: 'playing',
  channelId: 5, channelName: 'Lounge',
  session: { id: 'a', kind: 'music', state: 'active', botId: 1, botName: 'Aurora Radio', startedAt: 0, label: 'Neon Skyline' },
  music: { title: 'Neon Skyline', artist: 'Midnight Transit', live: false, position: 75, duration: 214 },
  video: null, ...noStop,
};
const pausedBot = {
  ...musicBot, botId: 4, botName: 'Study Beats', status: 'paused',
  session: { ...musicBot.session, id: 'c', botId: 4, botName: 'Study Beats', label: 'Lo-fi' },
  music: { ...musicBot.music, title: 'Lo-fi', artist: null },
};

test('Media Library header shows playing bots and pauses one from the menu', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  let paused: number | null = null;
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: [idleBot, pausedBot, musicBot] }));
  await page.route('**/api/music-bots/1/pause', (r) => {
    paused = 1;
    return r.fulfill({ json: { success: true } });
  });

  await signIn(page, request);
  await page.goto('/media-bots');
  const header = page.getByTestId('page-header');
  const pill = header.getByRole('button', { name: /Now playing: 2 active bots/ });
  await expect(pill).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('header-pill.png') });

  await pill.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /^Open console for Aurora Radio/ })).toHaveAttribute('href', '/bot-hub/1');
  await expect(menu.getByRole('menuitem', { name: 'Resume Study Beats' })).toBeVisible();
  await expect(menu.getByText('Backup Bot')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('header-menu.png') });

  await menu.getByRole('menuitem', { name: 'Pause Aurora Radio' }).click();
  await expect.poll(() => paused).toBe(1);
  await expect(menu).toBeVisible();

  await menu.getByRole('menuitem', { name: /^Open console for Aurora Radio/ }).click();
  await expect(page).toHaveURL('/bot-hub/1');
});

test('Media Library header falls back to a Bot Hub link when nothing plays, icon-only on phones', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: [idleBot] }));

  await signIn(page, request);
  await page.goto('/media-bots');
  const link = page.getByTestId('page-header').getByRole('link', { name: 'No bots playing. Open Bot Hub' });
  await expect(link).toBeVisible();
  await expect(link.getByText('No bots playing')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await link.click();
  await expect(page).toHaveURL('/bot-hub');
});

test('Playlists Add songs picks a playlist first, then opens its Add dialog', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const playlists = [
    { id: 10, name: 'Music', mode: 'stream', songCount: 3, serverConfigId: 1, musicBotId: null },
    { id: 11, name: 'Chill', mode: 'local', songCount: 0, serverConfigId: 1, musicBotId: null },
  ];
  await page.route(/\/api\/playlists(\?.*)?$/, (r) => r.fulfill({ json: playlists }));
  await page.route(/\/api\/playlists\/10$/, (r) => r.fulfill({ json: { ...playlists[0], songs: [] } }));

  await signIn(page, request);
  await page.goto('/media-bots?tab=playlists');
  await page.getByRole('button', { name: 'Add songs', exact: true }).click();

  const picker = page.getByRole('dialog', { name: 'Add songs to…' });
  await expect(picker.getByRole('button', { name: /Chill/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('add-songs-picker.png') });
  await picker.getByRole('button', { name: /Music/ }).click();

  const add = page.getByRole('dialog', { name: 'Add to Music' });
  await expect(add).toBeVisible();
  // Stream playlists open on the URL tab.
  await expect(add.getByLabel('Track or playlist URL')).toBeVisible();
});

test('Playlists Add songs can create a playlist and open its Add dialog', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const existing = { id: 10, name: 'Music', mode: 'stream', songCount: 3, serverConfigId: 1, musicBotId: null };
  const created = { id: 12, name: 'Road Trip', mode: 'local', songCount: 0, serverConfigId: 1, musicBotId: null };
  let list = [existing];
  await page.route(/\/api\/playlists(\?.*)?$/, (r) => {
    if (r.request().method() === 'POST') {
      list = [existing, created];
      return r.fulfill({ status: 201, json: created });
    }
    return r.fulfill({ json: list });
  });
  await page.route(/\/api\/playlists\/12$/, (r) => r.fulfill({ json: { ...created, songs: [] } }));

  await signIn(page, request);
  await page.goto('/media-bots?tab=playlists');
  await page.getByRole('button', { name: 'Add songs', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add songs to…' }).getByRole('button', { name: 'New playlist…' }).click();

  const create = page.getByRole('dialog', { name: 'New Playlist' });
  await create.getByPlaceholder('My Playlist').fill('Road Trip');
  await create.getByRole('button', { name: 'Create and add songs' }).click();

  const add = page.getByRole('dialog', { name: 'Add to Road Trip' });
  await expect(add).toBeVisible();
  // Local playlists open on the Songs tab.
  await expect(add.getByPlaceholder('Filter songs...')).toBeVisible();
});
