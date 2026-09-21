import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext, dashboardScenario = 'normal') {
  await request.post('/__test/dashboard?scenario=' + dashboardScenario);
  await request.post('/__test/channels?scenario=normal');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('high-traffic pages expose the shared title, description, metadata, and actions contract', async ({ page, request }) => {
  await signIn(page, request);

  const pages = [
    { path: '/dashboard', title: 'Operations Voice', description: 'Live TeamSpeak server overview', action: 'Widgets' },
    { path: '/channels', title: 'Channels', description: /channels · 2 users online/, action: 'Create Channel' },
    { path: '/clients', title: 'Clients', description: '2 online' },
    { path: '/servers', title: 'Virtual Servers', description: /2 servers/ },
    { path: '/music-bots', title: 'Music Bots', description: /playback/i },
    { path: '/iptv', title: 'IPTV', description: /Stream live IPTV channels/ , action: 'Add Playlist' },
  ] as const;

  for (const target of pages) {
    await page.goto(target.path);
    const header = page.getByTestId('page-header');
    await expect(header).toBeVisible();
    await expect(header.getByRole('heading', { name: target.title })).toBeVisible();
    await expect(header).toContainText(target.description);
    if (target.action) await expect(header.getByRole('button', { name: target.action })).toBeVisible();
  }
});

test('dashboard header preserves online state, widgets action, and live refresh status', async ({ page, request }) => {
  await signIn(page, request);
  const header = page.getByTestId('page-header');
  await expect(header.getByRole('heading', { name: 'Operations Voice' })).toBeVisible();
  await expect(header.getByText('ONLINE', { exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Widgets' })).toBeVisible();
  await expect(header).toContainText('Live monitoring active');
});

test('channel background failure preserves stale content and Retry exposes pending recovery', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/channels');
  await expect(page.getByText('Alice')).toBeVisible();
  await request.post('/__test/channels?scenario=refresh-failure');

  const notice = page.getByRole('status').filter({ hasText: 'Channel refresh failed' });
  await expect(notice).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText('Alice')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Channel' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Show Query clients' })).toBeVisible();

  await request.post('/__test/channels?scenario=normal');
  await page.route('**/api/servers/*/vs/*/channels', async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  }, { times: 1 });
  await notice.getByRole('button', { name: 'Retry refresh' }).click();
  await expect(notice.getByRole('button', { name: 'Retrying…' })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(page.getByText('Alice')).toBeVisible();
});

test('dashboard long titles wrap safely and header actions remain contained on a phone', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, request, 'long-name');
  const header = page.getByTestId('page-header');
  await expect(header.getByRole('heading', { name: /Operations Voice with an intentionally long/ })).toBeVisible();
  await expect(header.getByTestId('page-header-actions')).toHaveCSS('flex-wrap', 'wrap');
  await expectNoHorizontalOverflow(page);
});

test('clients format missing idle telemetry without exposing invalid numbers', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/clients');
  await expect(page.getByRole('region', { name: 'Clients table' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('NaNm');
  await expect(page.locator('body')).not.toContainText('NaN');
  await expect(page.locator('body')).not.toContainText('Infinity');
});

test('IPTV uses browser-local formatting and gives icon controls useful accessible names', async ({ page, request }) => {
  await request.post('/__test/iptv?scenario=populated');
  await signIn(page, request);
  await page.goto('/iptv');

  const { expectedDate, expectedCount } = await page.evaluate(() => ({
    expectedDate: new Date('2026-09-21T01:23:45.000Z').toLocaleString(),
    expectedCount: (1234).toLocaleString(),
  }));
  await expect(page.getByText(`${expectedCount} channels`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`Updated ${expectedDate}`, { exact: true })).toBeVisible();

  const refresh = page.getByRole('button', { name: 'Refresh Local News & Events' });
  await expect(refresh).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete Local News & Events' })).toBeVisible();
  const restingFocusStyle = await refresh.evaluate(element => ({
    outline: getComputedStyle(element).outline,
    shadow: getComputedStyle(element).boxShadow,
  }));
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await expect.poll(() => refresh.evaluate(element => ({
    outline: getComputedStyle(element).outline,
    shadow: getComputedStyle(element).boxShadow,
  }))).not.toEqual(restingFocusStyle);
});

test('targeted pages remain document-contained at narrow and desktop widths', async ({ page, request }) => {
  test.setTimeout(180_000);
  await signIn(page, request);
  for (const [width, height] of [[390, 844], [430, 932], [768, 1024], [844, 390], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    for (const path of ['/dashboard', '/channels', '/clients', '/servers', '/music-bots', '/iptv']) {
      await page.goto(path);
      await expect(page.getByTestId('page-header')).toBeVisible({ timeout: 15_000 });
      await expectNoHorizontalOverflow(page);
    }
  }
});
