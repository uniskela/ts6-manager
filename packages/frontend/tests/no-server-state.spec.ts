import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext, { scenario, role = 'admin' }: { scenario: string; role?: 'admin' | 'viewer' }) {
  await request.post(`/__test/dashboard?scenario=${scenario}`);
  await request.post(`/__test/auth?on&role=${role}`);
  await page.goto('/login');
  await page.getByLabel('Username').fill(role);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  test(`gated pages keep their title and offer connection setup at ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    await signIn(page, request, { scenario: 'no-connections' });

    for (const [path, title] of [['/tokens', 'Privilege Keys'], ['/channels', 'Channels'], ['/servers', 'Virtual Servers']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No server connection configured' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open connection setup' })).toHaveAttribute('href', '/settings?tab=connections&wizard=1');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('a selected connection without virtual servers explains that instead of asking for a selection', async ({ page, request }) => {
  await signIn(page, request, { scenario: 'no-selection' });
  await page.goto('/bans');

  await expect(page.getByRole('heading', { level: 1, name: 'Bans' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No virtual server available' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View virtual servers' })).toHaveAttribute('href', '/servers');
  await expect(page.getByRole('heading', { name: 'No server selected' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open connection setup' })).toHaveCount(0);
});

test('automation pages block creation until a connection exists', async ({ page, request }) => {
  await request.post('/__test/bots?scenario=empty');
  await signIn(page, request, { scenario: 'no-connections' });

  await page.goto('/bots');
  await expect(page.getByRole('heading', { name: 'Connect a TeamSpeak server first' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Bot' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'From Template' })).toBeDisabled();

  await page.goto('/media-bots');
  await expect(page.getByRole('heading', { name: 'Connect a TeamSpeak server first' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Bot' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Open connection setup' })).toHaveAttribute('href', '/settings?tab=connections&wizard=1');

  await request.post('/__test/dashboard?scenario=normal');
  await page.goto('/media-bots');
  await expect(page.getByRole('heading', { name: 'No music bots yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Bot' })).toBeEnabled();
});

test('existing bot flows stay listed while creation waits for a connection', async ({ page, request }) => {
  await signIn(page, request, { scenario: 'no-connections' });

  await page.goto('/bots');
  await expect(page.getByRole('heading', { level: 1, name: 'Bot Flows' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Bot' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'From Template' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'No bot flows yet' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'New bot flows need a TeamSpeak server connection.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open connection setup' })).toHaveAttribute('href', '/settings?tab=connections&wizard=1');
});

test('viewers without connections are not sent to admin-only setup', async ({ page, request }) => {
  await signIn(page, request, { scenario: 'no-connections', role: 'viewer' });
  await page.goto('/channels');

  await expect(page.getByRole('heading', { level: 1, name: 'Channels' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No server connection available' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open connection setup' })).toHaveCount(0);
});
