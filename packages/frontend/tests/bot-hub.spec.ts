import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await request.post('/__test/dashboard?scenario=normal');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

function media(now: number) {
  const noStop = { lastMusicStop: null, lastVideoStop: null };
  return [
    {
      botId: 1, botName: 'Aurora Radio', serverConfigId: 1, serverName: 'Operations Voice', status: 'playing',
      channelId: 5, channelName: 'Lounge',
      session: { id: 'a', kind: 'music', state: 'active', botId: 1, botName: 'Aurora Radio', startedAt: now - 90_000, label: 'Neon Skyline' },
      music: { title: 'Neon Skyline', artist: 'Midnight Transit', live: false, position: 75, duration: 214 },
      video: null, ...noStop,
    },
    {
      botId: 2, botName: 'Cinema', serverConfigId: 1, serverName: 'Operations Voice', status: 'connected',
      channelId: 9, channelName: 'Movie Night',
      session: { id: 'b', kind: 'video', state: 'active', botId: 2, botName: 'Cinema', startedAt: now - 600_000, label: 'iptv.example' },
      music: null,
      video: {
        streaming: true, streamId: 's', preset: '1080p', framerate: 30, bitrate: '4500k', startedAt: now - 600_000,
        viewerCount: 0,
        quality: { requested: 'auto', actual: '1080p', width: 1920, height: 1080, sourceWidth: 1920, sourceHeight: 1080, note: null },
        encoder: { requested: 'auto', selected: 'h264_vaapi', active: 'h264_vaapi', codec: 'h264', hardware: true, fallbackReason: null, note: null },
        noViewer: { timeoutSec: 300, stopAt: now + 185_000 }, lastStop: null,
      },
      ...noStop,
    },
    {
      botId: 3, botName: 'Backup Bot', serverConfigId: 1, serverName: 'Operations Voice', status: 'connected',
      channelId: 2, channelName: 'Lobby', session: null, music: null, video: null,
      lastMusicStop: null,
      lastVideoStop: { reason: 'no_viewers', at: now - 8 * 60_000, detail: 'Stopped after 5 minutes with no viewers' },
    },
  ];
}

function summaries() {
  const base = {
    serverConfigId: 1, serverConfig: { id: 1, name: 'Operations Voice', host: 'ops.invalid' }, serverPassword: null,
    defaultChannel: 'Lounge', commandChannelIds: [], virtualServerId: 1, channelPassword: null, voicePort: 9987,
    volume: 50, autoStart: false, nowPlaying: null, createdAt: '2026-09-20T00:00:00.000Z',
  };
  return [
    { ...base, id: 1, name: 'Aurora Radio', nickname: 'Aurora Radio', status: 'playing' },
    { ...base, id: 2, name: 'Cinema', nickname: 'Cinema', status: 'connected' },
    { ...base, id: 3, name: 'Backup Bot', nickname: 'Backup Bot', status: 'connected' },
  ];
}

test('Bot Hub shows each bot\'s active media session and links to its sections', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await signIn(page, request);

  await page.goto('/bot-hub');
  await expect(page.getByRole('heading', { name: 'Bot Hub' })).toBeVisible();

  await expect(page.getByText('Neon Skyline — Midnight Transit')).toBeVisible();
  await expect(page.getByText('Streaming from iptv.example')).toBeVisible();
  await expect(page.getByText(/Auto → 1080p · Auto → H\.264 \(VAAPI\) · 0 viewers/)).toBeVisible();
  // The fixture counts down from ~3:05; assert the format, not a moment.
  await expect(page.getByText(/auto-stop in \d+:\d{2}/)).toBeVisible();
  await expect(page.getByText(/Last stream: Stopped after 5 minutes with no viewers · 8 min ago/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop stream' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop media' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New bot' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Settings for Backup Bot' })).toBeVisible();

  if (process.env.BOT_HUB_SCREENSHOT) await page.screenshot({ path: process.env.BOT_HUB_SCREENSHOT, fullPage: true });

  const sections = page.getByRole('navigation', { name: 'Bot sections' });
  await expect(sections.getByRole('link')).toHaveText(['Bot Flows', 'Media Library', 'Streaming defaults', 'IPTV']);
  await sections.getByRole('link', { name: 'Streaming defaults' }).click();
  await expect(page).toHaveURL('/media-bots?tab=streaming');
  await expect(page.getByRole('heading', { name: 'Media Library' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Streaming defaults' })).toHaveAttribute('aria-selected', 'true');
});

test('New bot creates a media bot on the chosen server', async ({ page, request }) => {
  const created: unknown[] = [];
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await page.route('**/api/music-bots', async (route) => {
    if (route.request().method() === 'POST') {
      created.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { ...summaries()[2], id: 9, name: 'Night Shift' } });
      return;
    }
    await route.fulfill({ json: summaries() });
  });
  await signIn(page, request);

  await page.goto('/bot-hub');
  await page.getByRole('button', { name: 'New bot' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Media Bot' });
  await dialog.getByLabel('Bot name and TeamSpeak nickname').fill('Night Shift');
  await dialog.getByRole('combobox', { name: 'Server' }).click();
  await page.getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({ name: 'Night Shift', nickname: 'Night Shift' });
  await expect(dialog).toBeHidden();
});

test('a bot\'s settings menu edits, stops, shows the widget link, and deletes', async ({ page, request }) => {
  const calls: string[] = [];
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await page.route('**/api/music-bots', (route) => route.fulfill({ json: summaries() }));
  await page.route(/\/api\/music-bots\/3(\/.*)?$/, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push(`${req.method()} ${path}`);
    if (path.endsWith('/player-widget-token')) {
      await route.fulfill({ status: 500, json: { error: 'Widget tokens are unavailable' } });
      return;
    }
    await route.fulfill({ json: { success: true } });
  });
  await signIn(page, request);
  await page.goto('/bot-hub');

  const openMenu = () => page.getByRole('button', { name: 'Settings for Backup Bot' }).click();

  await openMenu();
  await expect(page.getByRole('menuitem')).toHaveText(['Edit bot', 'Stop bot', 'Widget link', 'Delete bot']);
  await page.getByRole('menuitem', { name: 'Edit bot' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Media Bot' });
  await expect(edit.getByLabel('Bot name and TeamSpeak nickname')).toHaveValue('Backup Bot');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => calls).toContain('PUT /api/music-bots/3');

  await openMenu();
  await page.getByRole('menuitem', { name: 'Stop bot' }).click();
  await expect.poll(() => calls).toContain('POST /api/music-bots/3/stop');

  // A failed token request explains itself instead of an empty dialog.
  await openMenu();
  await page.getByRole('menuitem', { name: 'Widget link' }).click();
  const widget = page.getByRole('dialog', { name: 'Player widget: Backup Bot' });
  await expect(widget.getByRole('alert')).toHaveText('Widget tokens are unavailable');
  await expect(widget.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.keyboard.press('Escape');

  await openMenu();
  await page.getByRole('menuitem', { name: 'Delete bot' }).click();
  await page.getByRole('dialog', { name: 'Delete Backup Bot?' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => calls).toContain('DELETE /api/music-bots/3');
});

test('Edit closes with a message when the bot is gone from the bot list', async ({ page, request }) => {
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await page.route('**/api/music-bots', (route) => route.fulfill({ json: summaries().filter((b) => b.id !== 3) }));
  await signIn(page, request);
  await page.goto('/bot-hub');

  await page.getByRole('button', { name: 'Settings for Backup Bot' }).click();
  await page.getByRole('menuitem', { name: 'Edit bot' }).click();
  await expect(page.getByText('Backup Bot no longer exists', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit Media Bot' })).toHaveCount(0);

  // A later list that includes the bot must not open Edit by itself.
  await page.unroute('**/api/music-bots');
  await page.route('**/api/music-bots', (route) => route.fulfill({ json: summaries() }));
  await page.getByRole('button', { name: 'Settings for Aurora Radio' }).click();
  await page.getByRole('menuitem', { name: 'Edit bot' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Media Bot' })).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Edit Media Bot' }).getByLabel('Bot name and TeamSpeak nickname')).toHaveValue('Aurora Radio');
});

test('old Media Bots links land on their 1.10.0 pages', async ({ page, request }) => {
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await signIn(page, request);

  for (const [from, to] of [
    ['/media-bots?tab=bots', '/bot-hub'],
    ['/media-bots?tab=queue&bot=2', '/bot-hub/2'],
    ['/media-bots?tab=queue', '/bot-hub'],
    ['/media-bots?tab=video&bot=2', '/bot-hub/2'],
    ['/media-bots?tab=video', '/media-bots?tab=streaming'],
    ['/media-bots?tab=commands', '/bots?tab=commands'],
    ['/music-bots?tab=video&bot=1', '/bot-hub/1'],
  ] as const) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
  }

  await page.goto('/media-bots');
  await expect(page.getByRole('heading', { name: 'Media Library' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveText(['Library', 'Playlists', 'Radio stations', 'Requests', 'Streaming defaults']);
});

test('a live stream switches source from the console without stopping', async ({ page, request }) => {
  const switches: unknown[] = [];
  const stops: string[] = [];
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await page.route('**/api/music-bots', (route) => route.fulfill({ json: summaries() }));
  await page.route('**/api/music-bots/*/state', (route) => route.fulfill({ json: { status: 'connected', currentIndex: -1, queue: [], position: 0, duration: 0, volume: 50, shuffle: false, repeat: 'off' } }));
  await page.route('**/api/music-bots/2/stream/status', (route) => route.fulfill({ json: { streaming: true, viewerCount: 0, viewers: [] } }));
  await page.route('**/api/music-bots/2/stream/stop', (route) => { stops.push(route.request().url()); return route.fulfill({ json: { success: true } }); });
  await page.route('**/api/music-bots/2/stream/source', async (route) => { switches.push(route.request().postDataJSON()); await route.fulfill({ json: { success: true } }); });
  await signIn(page, request);

  await page.goto('/bot-hub/2');
  const input = page.getByLabel('New source for this stream');
  await input.fill('https://video.invalid/next.mp4');
  await page.getByRole('button', { name: 'Switch', exact: true }).click();

  await expect.poll(() => switches).toEqual([{ source: 'https://video.invalid/next.mp4' }]);
  await expect(page.getByText('Stream source switched', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  expect(stops).toHaveLength(0);
});

test('IPTV Stream on… opens the chosen bot\'s console with the channel selected, without streaming', async ({ page, request }) => {
  const streams: unknown[] = [];
  const channel = { id: 7, playlistId: 10, name: 'Morning News', url: 'http://news.invalid/live', logo: null, groupTitle: 'News', tvgId: 'morning.west', position: 0 };
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await page.route('**/api/music-bots', (route) => route.fulfill({ json: summaries() }));
  await page.route('**/api/music-bots/*/state', (route) => route.fulfill({ json: { status: 'connected', currentIndex: -1, queue: [], position: 0, duration: 0, volume: 50, shuffle: false, repeat: 'off' } }));
  await page.route(/\/api\/iptv\/playlists(\?.*)?$/, (route) => route.fulfill({ json: [{ id: 10, name: 'News', serverConfigId: 1, url: 'http://news.invalid/list.m3u', channelCount: 1, lastRefreshed: null, autoRefresh: false, refreshInterval: 0 }] }));
  await page.route(/\/api\/iptv\/playlists\/10\/groups/, (route) => route.fulfill({ json: ['News'] }));
  await page.route(/\/api\/iptv\/playlists\/10\/channels/, (route) => route.fulfill({ json: { total: 1, page: 1, pageSize: 24, channels: [channel] } }));
  const lookups: string[] = [];
  await page.route('**/api/iptv/channels**', (route) => {
    lookups.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { total: 1, page: 1, pageSize: 1, channels: [{ ...channel, group: 'News', playlistName: 'News', channelKey: 'morning.west' }] } });
  });
  await page.route('**/api/iptv/stream', async (route) => { streams.push(route.request().postDataJSON()); await route.fulfill({ json: { success: true } }); });
  await signIn(page, request);

  await page.goto('/iptv');
  await page.getByRole('button', { name: 'Stream Morning News on…' }).click();
  await page.getByRole('menuitem', { name: /Cinema/ }).click();

  await expect(page).toHaveURL('/bot-hub/2?iptv=10%3Amorning.west&iptvChannel=7');
  await expect(page.getByRole('tab', { name: 'IPTV' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Stream Morning News' })).toBeVisible();
  // The exact row is looked up, since tvg-id can repeat across a playlist's channels.
  expect(lookups.some((q) => new URLSearchParams(q).get('channelId') === '7')).toBe(true);
  expect(streams).toHaveLength(0);
});
