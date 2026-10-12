import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Layout-only checks for the wide-viewport treatment of Settings > Appearance,
// Settings > YouTube and the Bot Flows > Chat commands permissions card.
// Set WIDE_LAYOUT_SHOTS=<dir> to also write screenshots there (not committed).

const shotDir = process.env.WIDE_LAYOUT_SHOTS;
const widths = [
  { width: 1920, height: 900 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 800 },
  { width: 390, height: 844 },
];

async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function mockYoutube(page: Page) {
  await page.route('**/api/settings/yt-cookies', (route) => route.fulfill({ json: { active: true, size: 2048 } }));
  await page.route('**/api/settings/limits', (route) => route.fulfill({ json: { maxVideoDuration: 900, maxPlaylistImport: 250, youtubeDirectStream: false } }));
  await page.route('**/api/settings/runtime-diagnostics', (route) => route.fulfill({
    json: {
      checkedAt: '2026-01-01T00:00:00.000Z',
      overall: 'ok',
      meta: { sidecarMode: 'disabled' },
      stages: [
        { id: 'yt-dlp', status: 'ok', message: 'ready', version: '2026.01.01' },
        { id: 'ffmpeg', status: 'ok', message: 'ready', version: '6.1' },
        { id: 'ffprobe', status: 'ok', message: 'ready', version: '6.1' },
      ],
    },
  }));
}

type Policy = Record<'playback' | 'queue' | 'video', { mode: 'everyone' } | { mode: 'server_groups'; serverGroupIds: number[] }>;

async function mockPermissions(page: Page, initial?: Policy) {
  const permissions: Policy = initial ?? { playback: { mode: 'everyone' }, queue: { mode: 'everyone' }, video: { mode: 'everyone' } };
  await page.route('**/api/servers', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [{ id: 1, name: 'Primary server', host: 'primary.invalid' }] });
    return route.fallback();
  });
  await page.route('**/api/servers/*/chat-commands**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/chat-commands')[1] ?? '';
    if (suffix.startsWith('/permissions/')) return route.fulfill({ json: permissions });
    if (suffix === '/presets') return route.fulfill({ json: [] });
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/servers/*/vs/*/server-groups**', (route) => route.fulfill({
    json: [{ sgid: 6, name: 'Server Admin' }, { sgid: 7, name: 'Normal' }, { sgid: 8, name: 'DJ with a rather long group name' }],
  }));
  await page.addInitScript(() => localStorage.setItem('ts6-server', JSON.stringify({ state: { selectedConfigId: 1, selectedSid: 1 }, version: 0 })));
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function shot(page: Page, name: string, width: number) {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}-${width}.png`, fullPage: true });
}

async function box(page: Page, testId: string) {
  const b = await page.getByTestId(testId).boundingBox();
  expect(b, testId).not.toBeNull();
  return b!;
}

async function expectColumns(page: Page, first: string, second: string, sideBySide: boolean) {
  const a = await box(page, first);
  const b = await box(page, second);
  if (sideBySide) {
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  } else {
    expect(Math.abs(a.x - b.x)).toBeLessThan(2);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  }
}

for (const size of widths) {
  const wide = size.width >= 1280;

  test(`Appearance layout at ${size.width}px`, async ({ page, request }) => {
    await page.setViewportSize(size);
    await signInAsAdmin(page, request);
    await page.goto('/settings?tab=appearance');
    await expect(page.getByRole('button', { name: 'Dark base theme' })).toBeVisible();
    await expectColumns(page, 'appearance-column-theme', 'appearance-column-background', wide);
    await noHorizontalScroll(page);
    await shot(page, 'appearance', size.width);
  });

  test(`YouTube layout at ${size.width}px`, async ({ page, request }) => {
    await mockYoutube(page);
    await page.setViewportSize(size);
    await signInAsAdmin(page, request);
    await page.goto('/settings?tab=youtube');
    await expect(page.getByText('Download & Stream Limits')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Limits' })).toBeVisible();
    await expectColumns(page, 'youtube-column-sources', 'youtube-column-limits', wide);
    await noHorizontalScroll(page);
    await shot(page, 'youtube', size.width);
  });

  test(`Built-in command permissions layout at ${size.width}px`, async ({ page, request }) => {
    await mockPermissions(page, {
      playback: { mode: 'server_groups', serverGroupIds: [6, 8] },
      queue: { mode: 'everyone' },
      video: { mode: 'server_groups', serverGroupIds: [] },
    });
    await page.setViewportSize(size);
    await signInAsAdmin(page, request);
    await page.goto('/bots?tab=commands');
    const groups = page.getByTestId('media-permission-groups');
    await expect(groups).toBeVisible();
    const fieldsets = groups.locator('fieldset');
    await expect(fieldsets).toHaveCount(3);
    const boxes = [];
    for (let i = 0; i < 3; i++) boxes.push((await fieldsets.nth(i).boundingBox())!);
    if (wide) {
      expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width - 1);
      expect(boxes[2].x).toBeGreaterThan(boxes[1].x + boxes[1].width - 1);
      expect(Math.abs(boxes[0].y - boxes[2].y)).toBeLessThan(2);
    } else {
      expect(Math.abs(boxes[0].x - boxes[1].x)).toBeLessThan(2);
      expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height - 1);
    }
    // Restricted-mode controls stay inside their own group card.
    const playback = fieldsets.nth(0);
    await expect(playback.getByRole('checkbox', { name: /Server Admin/ })).toBeChecked();
    const pb = (await playback.boundingBox())!;
    const cb = (await playback.getByRole('checkbox', { name: /DJ with a rather long/ }).boundingBox())!;
    expect(cb.x + cb.width).toBeLessThanOrEqual(pb.x + pb.width + 1);
    await expect(page.getByRole('button', { name: 'Save permissions' })).toBeVisible();
    await noHorizontalScroll(page);
    await shot(page, 'permissions', size.width);
  });
}

test('permission groups keep their select labels and accessible names', async ({ page, request }) => {
  await mockPermissions(page);
  await signInAsAdmin(page, request);
  await page.goto('/bots?tab=commands');
  for (const name of ['Playback and music controls', 'Queue and playlist changes', 'Video and IPTV controls']) {
    await expect(page.getByRole('group', { name })).toBeVisible();
  }
  await expect(page.getByLabel('Who can use this?')).toHaveCount(3);
});
