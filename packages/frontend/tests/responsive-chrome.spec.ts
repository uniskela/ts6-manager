import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await request.post('/__test/dashboard?scenario=normal');
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

test('phone header keeps the connection and virtual server pickers visibly distinct', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/bot-hub');
  await expect(page.getByRole('heading', { name: 'Bot Hub' })).toBeVisible();

  const connection = page.getByRole('combobox', { name: 'Select server connection' });
  const virtualServer = page.getByRole('combobox', { name: 'Select virtual server' });

  // Captions stay inside the triggers until `md`, where the selects get fixed widths.
  // At `sm` (640) the old side labels crushed the connection value down to a few pixels.
  // Closeout for #316: at 390px the Bot Hub Connection and Virtual Server header does not overlap.
  for (const width of [375, 390, 640]) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 844 });
      await expect(connection.getByText('Connection', { exact: true })).toBeVisible();
      await expect(virtualServer.getByText('Virtual server', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const [connectionBox, virtualBox] = await Promise.all([connection.boundingBox(), virtualServer.boundingBox()]);
      expect(connectionBox!.x + connectionBox!.width).toBeLessThanOrEqual(virtualBox!.x + 1);
      expect(await connection.locator('.truncate').evaluate((el) => el.clientWidth)).toBeGreaterThan(48);
      expect(await virtualServer.locator('.truncate').evaluate((el) => el.clientWidth)).toBeGreaterThan(48);
      if (width === 640) {
        await expect(connection).toContainText('Primary connection');
        await expect(virtualServer).toContainText('Operations Voice');
        expect(await connection.locator('.truncate').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect(await virtualServer.locator('.truncate').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
    });
  }

  for (const width of [768, 1440]) {
    await test.step(`${width}px desktop labels`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await expect(connection.getByText('Connection', { exact: true })).toBeHidden();
      await expect(virtualServer.getByText('Virtual server', { exact: true })).toBeHidden();
      expect(await connection.locator('.truncate').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }
});

test('overflowing tab bars fade the hidden edge and keep the selected tab in view', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=account');

  const tabs = page.getByRole('tablist');
  await expect(tabs).toHaveAttribute('data-overflow-end', 'true');
  await expect(tabs).not.toHaveAttribute('data-overflow-start', /.*/);

  await page.goto('/settings?tab=about');
  await expect(page.getByRole('tab', { name: 'About' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('tab', { name: 'About' })).toBeInViewport({ ratio: 1 });
  await expect(tabs).toHaveAttribute('data-overflow-start', 'true');

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(tabs).not.toHaveAttribute('data-overflow-end', /.*/);
  await expect(tabs).not.toHaveAttribute('data-overflow-start', /.*/);
});
