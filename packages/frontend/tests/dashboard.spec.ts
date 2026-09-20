import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const viewports = [
  [390, 844],
  [430, 932],
  [768, 1024],
  [844, 390],
  [1440, 900],
] as const;

async function setScenario(request: APIRequestContext, scenario: string) {
  await request.post(`/__test/dashboard?scenario=${scenario}`);
}

async function signInAsAdmin(page: Page, request: APIRequestContext, scenario = 'normal') {
  await setScenario(request, scenario);
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

test('populated dashboard presents server status, traffic, and runtime capacity hierarchy', async ({ page, request }) => {
  await signInAsAdmin(page, request);

  await expect(page.getByRole('heading', { name: 'Operations Voice' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Server Status' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Traffic' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Runtime & Capacity' })).toBeVisible();
  await expect(page.getByText('18 / 32')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'User slot utilisation' })).toHaveAttribute('aria-valuenow', '56');
  await expect(page.getByText('27', { exact: true })).toBeVisible();
  await expect(page.getByText('18.4 ms')).toBeVisible();
  await expect(page.getByText('0.12%')).toBeVisible();
  await expect(page.getByText(/6\.0\.0-beta\.7 build 20260920/)).toBeVisible();
  await expect(page.getByText(/Linux x86_64 with an intentionally long/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('zero capacity and zero telemetry render finite, useful values', async ({ page, request }) => {
  await signInAsAdmin(page, request, 'zero-capacity');

  await expect(page.getByText('0 / 0')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'User slot utilisation' })).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByText('0% utilised')).toBeVisible();
  await expect(page.getByText('0 B/s')).toHaveCount(2);
  await expect(page.locator('body')).not.toContainText('NaN');
  await expect(page.locator('body')).not.toContainText('Infinity');
});

test('configured connection without a virtual server preserves no-selection guidance', async ({ page, request }) => {
  await signInAsAdmin(page, request, 'no-selection');

  await expect(page.getByRole('heading', { name: 'No server selected' })).toBeVisible();
  await expect(page.getByText('Select a server connection from the header to view the dashboard.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open connection setup' })).toHaveCount(0);
});

test('no configured connection preserves onboarding and Settings wizard links', async ({ page, request }) => {
  await signInAsAdmin(page, request, 'no-connections');

  await expect(page.getByText('Connect your TeamSpeak server to get started')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No server connection configured' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Connections' })).toHaveAttribute('href', '/settings?tab=connections&wizard=1');
  await expect(page.getByRole('link', { name: 'Open connection setup' })).toHaveAttribute('href', '/settings?tab=connections&wizard=1');
});

test('initial dashboard failure shows detailed error and retries successfully', async ({ page, request }) => {
  await signInAsAdmin(page, request, 'initial-failure');

  await expect(page.getByRole('heading', { name: 'Connection failed' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('TeamSpeak connection unavailable. WebQuery handshake timed out')).toBeVisible();
  await setScenario(request, 'normal');
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('heading', { name: 'Operations Voice' })).toBeVisible();
});

test('background refresh failure keeps the last dashboard snapshot visible', async ({ page, request }) => {
  await signInAsAdmin(page, request, 'background-failure');
  await expect(page.getByRole('heading', { name: 'Operations Voice' })).toBeVisible();

  await expect(page.getByRole('status').filter({ hasText: 'Live refresh failed' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('The last successful snapshot is still available')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Server Status' })).toBeVisible();
  await expect(page.getByText('18 / 32')).toBeVisible();
});

test('429 Query flood response recovers on the controlled polling interval', async ({ page, request }) => {
  await signInAsAdmin(page, request, 'query-flood');

  await expect(page.getByText('Query flood protection active. Retry after the TeamSpeak cooldown')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operations Voice' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('18 / 32')).toBeVisible();
});

test.describe('browser-local bandwidth labels', () => {
  test.use({ locale: 'en-US' });

  test('traffic history uses the browser locale instead of a fixed locale', async ({ page, request }) => {
    await signInAsAdmin(page, request);
    await expect(page.getByText('Collecting bandwidth samples…')).toBeVisible();
    await expect(page.locator('.recharts-xAxis .recharts-cartesian-axis-tick-value').first()).toContainText(/AM|PM/, { timeout: 15_000 });
  });
});

test('switching connection context clears dashboard-local bandwidth history', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await expect(page.locator('.recharts-area')).toHaveCount(2, { timeout: 15_000 });

  await page.getByLabel('Select server connection').click();
  await page.getByRole('option', { name: 'Secondary connection' }).click();
  await expect(page.getByRole('heading', { name: 'Backup Voice' })).toBeVisible();
  await expect(page.getByText('1 / 4')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'User slot utilisation' })).toHaveAttribute('aria-valuenow', '25');
  await expect(page.getByText('Collecting bandwidth samples…')).toBeVisible();
  await expect(page.locator('.recharts-area')).toHaveCount(0);
});

test('dashboard motion is reduced when the browser requests it', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInAsAdmin(page, request);

  const timings = await page.getByRole('progressbar', { name: 'User slot utilisation' }).locator('div').evaluate(element => ({
    transition: Number.parseFloat(getComputedStyle(element).transitionDuration),
    pulse: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('.pulse-dot')!).animationDuration),
  }));
  expect(timings.transition).toBeLessThanOrEqual(0.001);
  expect(timings.pulse).toBeLessThanOrEqual(0.001);
});

for (const [width, height] of viewports) {
  test(`dashboard hierarchy has no document overflow at ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    await signInAsAdmin(page, request);
    await expect(page.getByRole('heading', { name: 'Server Status' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Traffic' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Runtime & Capacity' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

for (const [theme, accent] of [['light', 'red'], ['dark', 'violet'], ['black', 'amber']] as const) {
  test(`dashboard chart follows ${theme}/${accent} appearance tokens`, async ({ page, request }) => {
    await page.addInitScript(({ theme, accent }) => {
      localStorage.setItem('ts6-ui', JSON.stringify({
        state: { sidebarCollapsed: false, baseTheme: theme, accent },
        version: 2,
      }));
    }, { theme, accent });
    await signInAsAdmin(page, request);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveAttribute('data-accent', accent);
    await expect(page.locator('[data-traffic-series="incoming"]')).toHaveCSS('color', await page.locator('html').evaluate(el => {
      const value = getComputedStyle(el).getPropertyValue('--primary').trim();
      const probe = document.createElement('span');
      probe.style.color = `hsl(${value})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    }));
    await expect(page.getByText('ONLINE', { exact: true })).toHaveCSS('color', /rgb/);
    const widgets = page.getByRole('button', { name: 'Widgets' });
    const restingShadow = await widgets.evaluate(element => getComputedStyle(element).boxShadow);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let index = 0; index < 50 && !(await widgets.evaluate(element => element === document.activeElement)); index++) {
      await page.keyboard.press('Tab');
    }
    expect(await widgets.evaluate(element => element === document.activeElement)).toBe(true);
    await expect.poll(() => widgets.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe(restingShadow);
    await expectNoHorizontalOverflow(page);
  });
}
