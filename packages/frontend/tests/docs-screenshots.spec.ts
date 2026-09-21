import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const docsDirectory = fileURLToPath(new URL('../../../docs/', import.meta.url));
const updateScreenshots = process.env.UPDATE_DOCS_SCREENSHOTS === '1';

async function signIn(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await page.addInitScript(() => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: {
        sidebarCollapsed: false,
        sidebarSections: {
          overview: true,
          management: true,
          security: true,
          content: true,
          system: true,
          automation: true,
        },
        baseTheme: 'dark',
        accent: 'cyan',
        permissionLabelMode: 'simple',
        showQueryClients: false,
      },
      version: 4,
    }));
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function capture(page: Page, filename: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${docsDirectory}${filename}`,
    animations: 'disabled',
    caret: 'hide',
    clip: { x: 0, y: 0, width: 1600, height: 960 },
  });
}

test.describe('maintained documentation screenshots', () => {
  test.skip(!updateScreenshots, 'Run pnpm --filter @ts6/frontend docs:screenshots to update documentation assets.');

  test('renders the shipped 1.7 UI from deterministic production fixtures', async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.clock.install({ time: new Date('2026-09-21T12:00:00.000Z') });
    await signIn(page, request);

    await expect(page.getByRole('heading', { name: 'Operations Voice' })).toBeVisible();
    await page.clock.fastForward(10_000);
    await expect(page.locator('.recharts-area')).toHaveCount(2);
    await expect(page.getByText('Live monitoring active')).toBeVisible();
    await capture(page, 'dashboard.png');

    await page.goto('/music-bots');
    await expect(page.getByRole('heading', { name: 'Music Bots' })).toBeVisible();
    await expect(page.getByText('Aurora Radio')).toBeVisible();
    await expect(page.getByText('Neon Skyline')).toBeVisible();
    await expect(page.getByText('Queue (3)')).toBeVisible();
    await capture(page, 'musicbots.png');

    await page.goto('/iptv');
    await expect(page.getByRole('heading', { name: 'IPTV' })).toBeVisible();
    await expect(page.getByText('Demo Community Channels', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Community News')).toBeVisible();
    await expect(page.getByText('6 channels', { exact: true }).first()).toBeVisible();
    await capture(page, 'iptv.png');

    await page.goto('/bots/1');
    const canvas = page.locator('.flow-canvas');
    await expect(canvas.locator('.flow-node')).toHaveCount(6);
    await expect(canvas.locator('svg g[aria-label="True connection"] text')).toHaveText('True');
    await expect(canvas.locator('svg g[aria-label="False connection"] text')).toHaveText('False');
    await capture(page, 'flow-editor.png');

    await page.goto('/bots');
    await page.getByRole('button', { name: 'From Template' }).click();
    const templates = page.getByRole('dialog', { name: 'Flow Templates' });
    await expect(templates).toBeVisible();
    await expect(templates.getByRole('button', { name: /AFK Mover/ })).toBeVisible();
    await capture(page, 'flow-templates.png');

    await page.keyboard.press('Escape');
    await page.goto('/permissions');
    for (const name of ['Administrators', 'Moderators', 'Guests', 'Operators']) {
      await page.getByRole('button', { name: `Select ${name} for Compare` }).click();
    }
    await page.getByRole('button', { name: 'Compare 4 selected entities' }).click();
    await page.getByRole('checkbox', { name: 'Set on any' }).check();
    await page.getByRole('checkbox', { name: 'Differences only' }).check();
    const compare = page.getByTestId('permissions-compare');
    await expect(compare.getByRole('cell', { name: 'Moderators: Value 25, Skip' })).toBeVisible();
    await expect(compare.getByRole('cell', { name: 'Guests: Value 25, Negate' })).toBeVisible();
    await expect(compare.getByRole('cell', { name: 'Operators: Value 75, Skip, Negate' })).toBeVisible();
    await capture(page, 'permissions-compare.png');
  });
});
