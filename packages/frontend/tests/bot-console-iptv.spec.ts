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
  await page.route('**/api/iptv/filters**', (route) => route.fulfill({ json: { countries: [], languages: [] } }));
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

test('streaming waits for the server defaults and keeps an early edit on top of them', async ({ page, request }) => {
  const streams = await mockIptv(page);
  let release!: () => void;
  const settingsLoaded = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/settings/video-streaming/servers/1', async (route) => {
    await settingsLoaded;
    await route.fulfill({ json: { global: {}, overrides: {}, effective: { defaultEncoder: 'h264_vaapi', noViewerTimeoutSec: 900 } } });
  });
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV' }).click();
  await page.getByRole('button', { name: /News/ }).click();
  const stream = page.getByRole('button', { name: 'Stream Morning News' });
  await expect(stream).toBeDisabled();

  await page.locator('summary', { hasText: 'Video options' }).click();
  await page.locator('#vo-quality').selectOption('1080p');
  await expect(stream).toBeDisabled();

  release();
  await expect(stream).toBeEnabled();
  await stream.click();
  await expect.poll(() => streams[0]).toEqual({
    botId: 1, channelId: 7, preset: '1080p', encoder: 'h264_vaapi', noViewerTimeoutSec: 900, sourceMode: 'live',
  });
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


test('country and language selects stay hidden when the server has no metadata', async ({ page, request }) => {
  await mockIptv(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await expect(page.getByRole('button', { name: /News/ })).toBeVisible();
  await expect(page.getByLabel('Country', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Language', { exact: true })).toHaveCount(0);
});

for (const [countries, languages, visible, hidden] of [
  [['US'], [], 'Country', 'Language'],
  [[], ['en'], 'Language', 'Country'],
] as const) {
  test(`only ${visible} appears when the server has only its metadata`, async ({ page, request }) => {
    await mockIptv(page);
    await page.route('**/api/iptv/filters**', (route) => route.fulfill({ json: { countries, languages } }));
    await signIn(page, request);
    await page.goto('/bot-hub/1');
    await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
    await expect(page.getByLabel(visible, { exact: true })).toBeVisible();
    await expect(page.getByLabel(hidden, { exact: true })).toHaveCount(0);
  });
}

test('country and language combine with playlist, group and search at phone width', async ({ page, request }) => {
  await mockIptv(page);
  const groups: URLSearchParams[] = [];
  const requests: URLSearchParams[] = [];
  await page.route('**/api/iptv/filters**', (route) => {
    expect(new URL(route.request().url()).searchParams.get('serverConfigId')).toBe('1');
    return route.fulfill({ json: { countries: ['CA', 'US'], languages: ['en', 'fr'] } });
  });
  await page.route('**/api/iptv/groups**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    groups.push(params);
    return route.fulfill({ json: [{ group: 'News', count: params.get('country') === 'CA' ? 1 : 2 }] });
  });
  await page.route('**/api/iptv/channels**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const rows = params.get('country') === 'CA' && params.get('language') === 'fr'
      ? [{ ...channel, name: 'French News' }]
      : [channel, { ...channel, id: 8, name: 'French News' }];
    return route.fulfill({ json: { total: rows.length, page: Number(params.get('page')), pageSize: 50, channels: rows } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await page.getByLabel('Playlist', { exact: true }).selectOption('10');
  await page.getByLabel('Country', { exact: true }).selectOption('CA');
  await page.getByLabel('Language', { exact: true }).selectOption('fr');
  await expect.poll(() => groups.some((params) => params.get('serverConfigId') === '1'
    && params.get('playlistId') === '10' && params.get('country') === 'CA' && params.get('language') === 'fr')).toBe(true);
  await page.getByRole('button', { name: /News/ }).click();
  await page.getByLabel('Search channels').fill('News');
  await expect(page.getByText('French News', { exact: true })).toBeVisible();
  await expect(page.getByText('Morning News', { exact: true })).toHaveCount(0);
  await expect.poll(() => requests.some((params) => params.get('serverConfigId') === '1'
    && params.get('playlistId') === '10' && params.get('country') === 'CA' && params.get('language') === 'fr'
    && params.get('group') === 'News' && params.get('search') === 'News' && params.get('page') === '1')).toBe(true);
  for (const name of ['Country', 'Language']) {
    const bounds = await page.getByLabel(name, { exact: true }).boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('country and language filter favourites and recent by exact case-insensitive split codes', async ({ page, request }) => {
  const matches = { ...favourite, channel: { ...channel, tvgCountry: 'us; CA', tvgLanguage: 'EN,fr' }, lastStreamedAt: '2026-10-03T09:00:00.000Z' };
  const others = [
    { ...favourite, channelKey: 'other', name: 'Other News', channel: { ...channel, id: 8, channelKey: 'other', name: 'Other News', tvgCountry: 'CAM', tvgLanguage: 'fra' }, lastStreamedAt: matches.lastStreamedAt },
    { ...favourite, channelKey: 'missing', name: 'Gone News', channel: null, lastStreamedAt: matches.lastStreamedAt },
  ];
  await mockPicks(page, [matches, ...others]);
  await page.route('**/api/iptv/filters**', (route) => route.fulfill({ json: { countries: ['CA', 'CAM', 'US'], languages: ['en', 'fr', 'fra'] } }));
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await expect(page.getByText('Gone News', { exact: true })).toBeVisible();
  await page.getByLabel('Country', { exact: true }).selectOption('CA');
  await page.getByLabel('Language', { exact: true }).selectOption('fr');
  for (const view of ['Favourites', 'Recent']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByText('Morning News', { exact: true })).toBeVisible();
    await expect(page.getByText('Other News', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Gone News', { exact: true })).toHaveCount(0);
  }
  await page.getByLabel('Country', { exact: true }).selectOption('');
  await expect(page.getByText('Other News', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Gone News', { exact: true })).toHaveCount(0);
  await page.getByLabel('Language', { exact: true }).selectOption('');
  await expect(page.getByText('Other News', { exact: true })).toBeVisible();
  await expect(page.getByText('Gone News', { exact: true })).toBeVisible();
});

test('changing metadata filters resets group and channel pagination', async ({ page, request }) => {
  await mockIptv(page);
  await page.route('**/api/iptv/filters**', (route) => route.fulfill({ json: { countries: ['US'], languages: ['en'] } }));
  await page.route('**/api/iptv/groups**', (route) => route.fulfill({ json: Array.from({ length: 51 }, (_, index) => ({ group: `Group ${String(index).padStart(2, '0')}`, count: 51 })) }));
  const requests: URLSearchParams[] = [];
  await page.route('**/api/iptv/channels**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const number = Number(params.get('page'));
    return route.fulfill({ json: { total: 51, page: number, pageSize: 50, channels: [{ ...channel, name: `Channel page ${number}` }] } });
  });
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Group 50', exact: false })).toBeVisible();
  await page.getByLabel('Country', { exact: true }).selectOption('US');
  await expect(page.getByRole('button', { name: 'Group 00', exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Group 00', exact: false }).click();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('Channel page 2', { exact: true })).toBeVisible();
  await page.getByLabel('Language', { exact: true }).selectOption('en');
  await expect(page.getByText('Channel page 1', { exact: true })).toBeVisible();
  await expect.poll(() => requests.at(-1)?.get('page')).toBe('1');
  expect(requests.at(-1)?.get('country')).toBe('US');
  expect(requests.at(-1)?.get('language')).toBe('en');
});

test('switching servers hides old metadata and channels while the new server loads', async ({ page, request }) => {
  await mockIptv(page);
  await page.route('**/api/music-bots/media', (route) => route.fulfill({ json: [...media, { ...media[0], botId: 2, botName: 'Second bot', serverConfigId: 2 }] }));
  await page.route('**/api/music-bots/2/state', (route) => route.fulfill({ json: { status: 'playing', currentIndex: 0, queue: [], position: 0, duration: 200, volume: 50, shuffle: false, repeat: 'off' } }));
  let release: () => void = () => {};
  const loaded = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/iptv/filters**', async (route) => {
    const second = new URL(route.request().url()).searchParams.get('serverConfigId') === '2';
    if (second) await loaded;
    await route.fulfill({ json: second ? { countries: [], languages: [] } : { countries: ['CA'], languages: ['fr'] } });
  });
  await page.route('**/api/iptv/channels**', async (route) => {
    const second = new URL(route.request().url()).searchParams.get('serverConfigId') === '2';
    if (second) await loaded;
    await route.fulfill({ json: { total: second ? 0 : 1, page: 1, pageSize: 50, channels: second ? [] : [channel] } });
  });
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await page.getByLabel('Country', { exact: true }).selectOption('CA');
  await page.getByLabel('Search channels').fill('Morning');
  await expect(page.getByText('Morning News', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.history.pushState({}, '', '/bot-hub/2'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('heading', { name: 'Second bot', exact: true })).toBeVisible();
  await expect(page.getByLabel('Country', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Language', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Morning News', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Search channels')).toHaveValue('');
  release();
  await expect(page.getByRole('button', { name: /News/ })).toBeVisible();
  await expect(page.getByLabel('Country', { exact: true })).toHaveCount(0);
});

test('metadata values disappearing after a refresh clear the hidden filters', async ({ page, request }) => {
  await page.clock.install();
  await mockIptv(page);
  let metadata = { countries: ['US'], languages: ['en'] };
  await page.route('**/api/iptv/filters**', (route) => route.fulfill({ json: metadata }));
  const groups: URLSearchParams[] = [];
  await page.route('**/api/iptv/groups**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    groups.push(params);
    return route.fulfill({ json: [{ group: 'News', count: 1 }] });
  });
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await page.getByRole('tab', { name: 'IPTV', exact: true }).click();
  await page.getByLabel('Country', { exact: true }).selectOption('US');
  await page.getByLabel('Language', { exact: true }).selectOption('en');
  await expect.poll(() => groups.at(-1)?.get('language')).toBe('en');
  metadata = { countries: [], languages: [] };
  await page.clock.fastForward(31_000);
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  await expect(page.getByLabel('Country', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Language', { exact: true })).toHaveCount(0);
  await expect.poll(() => groups.at(-1)?.get('country')).toBeNull();
  await expect.poll(() => groups.at(-1)?.get('language')).toBeNull();
});
