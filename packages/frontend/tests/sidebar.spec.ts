import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const sectionLabels = ['Overview', 'Management', 'Security', 'Content', 'System', 'Automation'] as const;
const sectionIds = ['overview', 'management', 'security', 'content', 'system', 'automation'] as const;
const destinations = [
  'Dashboard',
  'Virtual Servers',
  'Channels',
  'Clients',
  'Server Groups',
  'Channel Groups',
  'Permissions',
  'Bans',
  'Tokens',
  'Files',
  'Complaints',
  'Messages',
  'Server Logs',
  'Instance',
  'Music Request History',
  'Bot Flows',
  'Music Bots',
  'IPTV',
  'Settings',
] as const;

async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('old UI preferences migrate without disturbing appearance or whole-sidebar state', async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: { sidebarCollapsed: false, baseTheme: 'black', accent: 'violet' },
      version: 1,
    }));
  });

  await signInAsAdmin(page, request);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet');
  for (const label of sectionLabels) {
    await expect(page.getByRole('button', { name: `Collapse ${label} section` })).toHaveAttribute('aria-expanded', 'true');
  }

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state);
  expect(state).toMatchObject({
    sidebarCollapsed: false,
    baseTheme: 'black',
    accent: 'violet',
    sidebarSections: Object.fromEntries(sectionIds.map(id => [id, true])),
  });
});

test('every section is keyboard controlled, persists independently, and keeps the active destination visible', async ({ page, request }) => {
  await signInAsAdmin(page, request);

  for (const label of sectionLabels) {
    const control = page.getByRole('button', { name: `Collapse ${label} section` });
    await control.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: `Expand ${label} section` })).toHaveAttribute('aria-expanded', 'false');
  }

  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Channels', exact: true })).toHaveCount(0);

  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state.sidebarSections);
  expect(persisted).toEqual(Object.fromEntries(sectionIds.map(id => [id, false])));

  await page.reload();
  for (const label of sectionLabels) {
    await expect(page.getByRole('button', { name: `Expand ${label} section` })).toHaveAttribute('aria-expanded', 'false');
  }

  await page.goto('/clients');
  await expect(page.getByRole('link', { name: 'Clients', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Channels', exact: true })).toHaveCount(0);
});

test('icon-only desktop navigation keeps every destination accessible and discoverable', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAsAdmin(page, request);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();

  await expect(page.getByRole('button', { name: /section$/ })).toHaveCount(0);
  for (const label of destinations) {
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
  }

  await page.getByRole('link', { name: 'IPTV', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('IPTV');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const [width, height] of [[390, 844], [768, 1024]] as const) {
  test(`mobile section navigation remains compact and usable at ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    await signInAsAdmin(page, request);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();

    const automation = page.getByRole('button', { name: 'Collapse Automation section' });
    await automation.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Expand Automation section' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: 'Music Bots', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Collapse Overview section' }).click();
    await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.getByRole('button', { name: 'Close navigation' }).click();
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await expect(page.getByRole('button', { name: 'Expand Automation section' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
  });
}
