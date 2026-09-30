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
  await expect(page.getByRole('button', { name: 'Stop music' })).toBeVisible();

  if (process.env.BOT_HUB_SCREENSHOT) await page.screenshot({ path: process.env.BOT_HUB_SCREENSHOT, fullPage: true });

  await page.getByRole('link', { name: /Video streaming/ }).click();
  // VideoTab auto-selects the first running bot and may append `&bot=` after landing.
  await expect(page).toHaveURL((url) => (
    url.pathname === '/media-bots' && url.searchParams.get('tab') === 'video'
  ));
  await expect(page.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true');

  // A bot link selects that bot, and the selector keeps the URL in sync.
  await page.goto('/media-bots?tab=video&bot=7');
  const botSelect = page.getByText('Select Bot:').locator('..').getByRole('combobox');
  await expect(botSelect).toContainText('Aurora Radio');
});
