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
  await page.route('**/api/iptv/favourites**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/iptv/recent**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/settings/video-streaming/servers/1', (route) => route.fulfill({ json: {
    global: {}, overrides: {}, effective: { defaultEncoder: 'h264_vaapi', noViewerTimeoutSec: 900 },
  } }));
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
  // Starts on Auto quality and this server's streaming defaults (env or Streaming defaults).
  await expect.poll(() => streams[0]).toEqual({
    botId: 1, channelId: 7, preset: 'auto', encoder: 'h264_vaapi', noViewerTimeoutSec: 900, sourceMode: 'live',
  });
  await page.getByRole('button', { name: 'All groups' }).click();
  await page.getByLabel('Search channels').fill('Morning');
  await expect(page.getByText('Morning News')).toBeVisible();
});

type PickFixture = {
  serverConfigId: number; playlistId: number; channelKey: string; name: string;
  favourite: boolean; lastStreamedAt: string | null; channel: typeof channel | null;
};
const favourite: PickFixture = {
  serverConfigId: 1, playlistId: 10, channelKey: 'morning:west', name: 'Morning News',
  favourite: true, lastStreamedAt: null, channel,
};

/** Keep API state outside the browser to test view selection and cache refreshes. */
async function mockPicks(page: Page, initial: PickFixture[] = []) {
  await mockIptv(page);
  let picks = structuredClone(initial);
  const writes: unknown[] = [];
  await page.route('**/api/iptv/favourites**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      expect(new URL(request.url()).searchParams.get('serverConfigId')).toBe('1');
      await route.fulfill({ json: picks.filter((pick) => pick.favourite) });
      return;
    }
    const body = request.postDataJSON();
    writes.push({ method: request.method(), ...body });
    const pick = picks.find((item) => item.playlistId === body.playlistId && item.channelKey === body.channelKey);
    if (request.method() === 'PUT') {
      if (pick) pick.favourite = true;
      else picks.push(structuredClone(favourite));
    } else if (pick) {
      pick.favourite = false;
      if (body.removeRecent) pick.lastStreamedAt = null;
    }
    await route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/iptv/recent**', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('serverConfigId')).toBe('1');
    await route.fulfill({ json: picks.filter((pick) => pick.lastStreamedAt) });
  });
  await page.route('**/api/settings/video-streaming/servers/1', (route) => route.fulfill({ json: {
    global: {}, overrides: {}, effective: { defaultEncoder: 'h264_vaapi', noViewerTimeoutSec: 900 },
  } }));
  await page.route('**/api/iptv/stream', async (route) => {
    const pick = picks.find((item) => item.channelKey === 'morning:west');
    if (pick) pick.lastStreamedAt = '2026-10-03T10:00:00.000Z';
    else picks.push({ ...structuredClone(favourite), favourite: false, lastStreamedAt: '2026-10-03T10:00:00.000Z' });
    await route.fulfill({ json: { success: true } });
  });
  return writes;
}

test('channel stars add and remove favourites by stable key', async ({ page, request }) => {
  const writes = await mockPicks(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Browse groups', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /News/ }).click();
  await page.getByRole('button', { name: 'Add Morning News to favourites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Morning News from favourites', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(page.getByText('Morning News', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Morning News from favourites', exact: true }).click();
  await expect(page.getByText('Morning News', { exact: true })).toHaveCount(0);
  expect(writes).toEqual([
    { method: 'PUT', serverConfigId: 1, playlistId: 10, channelKey: 'morning:west' },
    { method: 'DELETE', serverConfigId: 1, playlistId: 10, channelKey: 'morning:west' },
  ]);
});

test('opens Favourites when this server already has a favourite', async ({ page, request }) => {
  await mockPicks(page, [favourite]);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Favourites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Stream Morning News', exact: true })).toBeVisible();
});

test('loading favourites never overwrites a view chosen by the administrator', async ({ page, request }) => {
  const streamed = { ...favourite, lastStreamedAt: '2026-10-03T09:00:00.000Z' };
  await mockPicks(page, [streamed]);
  let release: () => void = () => {};
  const loaded = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/iptv/favourites**', async (route) => {
    await loaded;
    await route.fulfill({ json: [streamed] });
  });
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Morning News to favourites', exact: true })).toBeVisible();
  release();
  // The filled star proves the favourites response has rendered, so the default-view effect has had its chance to run.
  await expect(page.getByRole('button', { name: 'Remove Morning News from favourites', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recent', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Favourites', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('Recent updates after Stream and supports starring a recent channel', async ({ page, request }) => {
  await mockPicks(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  await expect(page.getByText('Morning News', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse groups', exact: true }).click();
  await page.getByRole('button', { name: /News/ }).click();
  await page.getByRole('button', { name: 'Stream Morning News', exact: true }).click();
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  await expect(page.getByText('Morning News', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add Morning News to favourites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Morning News from favourites', exact: true })).toBeVisible();
});

test('a disappeared pick explains the missing channel and Remove clears it from both views', async ({ page, request }) => {
  const writes = await mockPicks(page, [{ ...favourite, channel: null, lastStreamedAt: '2026-10-03T09:00:00.000Z' }]);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await expect(page.getByText('No longer in this playlist', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stream Morning News', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  await expect(page.getByText('No longer in this playlist', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Morning News', exact: true }).click();
  await expect(page.getByText('No longer in this playlist', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(page.getByText('Morning News', { exact: true })).toHaveCount(0);
  expect(writes).toEqual([{ method: 'DELETE', serverConfigId: 1, playlistId: 10, channelKey: 'morning:west', removeRecent: true }]);
});

test('removing the only pick on the last page returns to the remaining picks', async ({ page, request }) => {
  const missing = Array.from({ length: 51 }, (_, i) => ({
    ...favourite, channel: null, channelKey: `gone-${String(i).padStart(2, '0')}`, name: `Gone ${String(i).padStart(2, '0')}`,
  }));
  await mockPicks(page, missing);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await expect(page.getByText('Gone 00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Gone 50', exact: true }).click();
  await expect(page.getByText('Gone 49', { exact: true })).toBeVisible();
  await expect(page.getByText('1–50 of 50 channels', { exact: true })).toBeVisible();
});

test('a channel deep link exposes an accessible star at phone width without streaming', async ({ page, request }) => {
  const writes = await mockPicks(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, request);
  await page.goto('/bot-hub/1?iptv=10:morning:west');
  const star = page.getByRole('button', { name: 'Add Morning News to favourites', exact: true });
  await expect(star).toBeVisible();
  const bounds = await star.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  await star.click();
  await expect(page.getByRole('button', { name: 'Remove Morning News from favourites', exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
