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

const defaultSections = {
  overview: true,
  management: true,
  security: true,
  content: true,
  system: false,
  automation: false,
} as const;

async function expectDefaultSections(page: Page) {
  for (const [index, label] of sectionLabels.entries()) {
    const expanded = defaultSections[sectionIds[index]];
    await expect(page.getByRole('button', { name: `${expanded ? 'Collapse' : 'Expand'} ${label} section` }))
      .toHaveAttribute('aria-expanded', String(expanded));
  }
}

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
  await expectDefaultSections(page);

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state);
  expect(state).toMatchObject({
    sidebarCollapsed: false,
    baseTheme: 'black',
    accent: 'violet',
    sidebarSections: defaultSections,
  });
});

test('existing fully expanded sidebars adopt the compact defaults once, then keep user choices', async ({ page, request }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: {
        sidebarCollapsed: false,
        sidebarSections: { overview: true, management: true, security: false, content: true, system: true, automation: true },
        baseTheme: 'dark',
        accent: 'cyan',
      },
      version: 6,
    }));
  });

  await signInAsAdmin(page, request);
  await expect(page.getByRole('button', { name: 'Expand Security section' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Expand System section' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Expand Automation section' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Music Bots', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Expand Automation section' }).click();
  await expect(page.getByRole('link', { name: 'Music Bots', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Collapse Automation section' })).toHaveAttribute('aria-expanded', 'true');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!));
  expect(persisted.version).toBe(7);
  expect(persisted.state.sidebarSections).toMatchObject({ security: false, system: false, automation: true });
});

test('collapsed sections advertise their size and still reveal the active destination', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAsAdmin(page, request);

  const automation = page.getByRole('button', { name: 'Expand Automation section' });
  await expect(automation.locator('[data-section-count]')).toHaveText('3');
  await expect(page.getByRole('button', { name: 'Collapse Management section' }).locator('[data-section-count]')).toHaveCount(0);

  await page.goto('/iptv');
  await expect(page.getByRole('link', { name: 'IPTV', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Music Bots', exact: true })).toHaveCount(0);
});

test('every section is keyboard controlled, persists independently, and keeps the active destination visible', async ({ page, request }) => {
  await signInAsAdmin(page, request);

  for (const label of sectionLabels) {
    const expanded = defaultSections[sectionIds[sectionLabels.indexOf(label)]];
    if (!expanded) {
      const expand = page.getByRole('button', { name: `Expand ${label} section` });
      await expand.focus();
      await page.keyboard.press('Space');
      await expect(page.getByRole('button', { name: `Collapse ${label} section` })).toHaveAttribute('aria-expanded', 'true');
    }
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

async function scrollNavigation(page: Page, navigationName: string, to: 'top' | 'bottom') {
  await page.getByRole('navigation', { name: navigationName }).evaluate((nav, position) => {
    const viewport = nav.closest<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    viewport.scrollTop = position === 'bottom' ? viewport.scrollHeight : 0;
  }, to);
}

for (const [width, height, navigationName, opensSheet] of [
  [1024, 700, 'Primary navigation', false],
  [390, 844, 'Mobile navigation', true],
] as const) {
  test(`overflowing navigation shows where hidden destinations are at ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    await signInAsAdmin(page, request);
    if (opensSheet) await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: 'Expand Automation section' }).click();
    await scrollNavigation(page, navigationName, 'top');
    const container = page.getByRole('navigation', { name: navigationName }).locator('xpath=ancestor::div[@data-nav-scroll-container][1]');

    await expect(container.locator('[data-nav-scroll-edge="bottom"]')).toHaveCount(1);
    await expect(container.locator('[data-nav-scroll-edge="top"]')).toHaveCount(0);

    await scrollNavigation(page, navigationName, 'bottom');
    await expect(container.locator('[data-nav-scroll-edge="bottom"]')).toHaveCount(0);
    await expect(container.locator('[data-nav-scroll-edge="top"]')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'IPTV', exact: true })).toBeInViewport();

    await page.getByRole('link', { name: 'IPTV', exact: true }).click();
    await expect(page).toHaveURL('/iptv');
  });
}

test('navigation that fits shows no scroll edges', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await signInAsAdmin(page, request);
  await expect(page.locator('[data-nav-scroll-edge]')).toHaveCount(0);
});

for (const [width, height] of [[390, 844], [768, 1024]] as const) {
  test(`mobile section navigation remains compact and usable at ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    await signInAsAdmin(page, request);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();

    await expect(page.getByRole('link', { name: 'Music Bots', exact: true })).toHaveCount(0);
    const automation = page.getByRole('button', { name: 'Expand Automation section' });
    await automation.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: 'Music Bots', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Collapse Automation section' }).focus();
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
