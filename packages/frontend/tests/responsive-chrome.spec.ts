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
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsAdmin(page, request);

  const connection = page.getByRole('combobox', { name: 'Select server connection' });
  const virtualServer = page.getByRole('combobox', { name: 'Select virtual server' });
  await expect(connection.getByText('Connection', { exact: true })).toBeVisible();
  await expect(virtualServer.getByText('Virtual server', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(connection.getByText('Connection', { exact: true })).toBeHidden();
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
