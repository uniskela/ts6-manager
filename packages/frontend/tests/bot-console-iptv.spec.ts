import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/** Sign the Playwright browser into the deterministic test account. */
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

const media = [{
  botId: 1, botName: 'Aurora Radio', serverConfigId: 1, serverName: 'Operations Voice', status: 'playing',
  channelId: 5, channelName: 'Lounge', session: { id: 'a', kind: 'music', state: 'active', botId: 1, botName: 'Aurora Radio', startedAt: 0, label: 'Song' },
  music: { title: 'Song', artist: 'Artist', live: false, position: 0, duration: 200 }, video: null,
  lastMusicStop: null, lastVideoStop: null,
}];
const channel = { id: 7, name: 'Morning News', logo: null, group: 'News', playlistId: 10, playlistName: 'News', channelKey: 'morning:west' };

/** Mock the bot console and IPTV API responses used by these scenarios. */
async function mockIptv(page: Page) {
  const streams: unknown[] = [];
  await page.route('**/api/music-bots/media', (route) => route.fulfill({ json: media }));
  await page.route('**/api/music-bots/1/state', (route) => route.fulfill({ json: { status: 'playing', currentIndex: 0, queue: [], position: 0, duration: 200, volume: 50, shuffle: false, repeat: 'off' } }));
  await page.route('**/api/iptv/playlists**', (route) => route.fulfill({ json: [{ id: 10, name: 'News', serverConfigId: 1 }] }));
  await page.route('**/api/iptv/groups**', (route) => route.fulfill({ json: [{ group: 'News', count: 1 }] }));
  await page.route('**/api/iptv/channels**', (route) => route.fulfill({ json: { total: 1, page: 1, pageSize: 50, channels: [channel] } }));
  await page.route('**/api/iptv/stream', async (route) => { streams.push(route.request().postDataJSON()); await route.fulfill({ json: { success: true } }); });
  return streams;
}

test('browse groups, search channels, and stream with live IPTV defaults', async ({ page, request }) => {
  const streams = await mockIptv(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV' }).click();
  await expect(page.getByRole('button', { name: /News/ })).toBeVisible();
  await page.getByRole('button', { name: /News/ }).click();
  await expect(page.getByText('Morning News')).toBeVisible();
  await page.getByRole('button', { name: 'Stream Morning News' }).click();
  await expect.poll(() => streams[0]).toEqual({ botId: 1, channelId: 7, sourceMode: 'live' });
  await page.getByRole('button', { name: 'All groups' }).click();
  await page.getByLabel('Search channels').fill('Morning');
  await expect(page.getByText('Morning News')).toBeVisible();
});

test('IPTV deep links select a channel without starting a stream', async ({ page, request }) => {
  const streams = await mockIptv(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1?iptv=10:morning:west');
  await expect(page.getByText('Morning News')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stream Morning News' })).toBeVisible();
  expect(streams).toHaveLength(0);
});

test('a stale IPTV deep link stays open and explains the missing channel', async ({ page, request }) => {
  await mockIptv(page);
  await page.route('**/api/iptv/channels**', (route) => route.fulfill({ json: { total: 0, page: 1, pageSize: 50, channels: [] } }));
  await signIn(page, request);
  await page.goto('/bot-hub/1?iptv=10:gone');
  await expect(page.getByText('That channel is no longer in the playlist', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'IPTV' })).toHaveAttribute('aria-selected', 'true');
});
