import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Sign in as the Playwright admin after resetting the Vite test harness. */
export async function signInAsAdmin(
  page: Page,
  request: APIRequestContext,
  options: { dashboardScenario?: string } = {},
): Promise<void> {
  const scenario = options.dashboardScenario ?? 'normal';
  await request.post('/__test/reset');
  await request.post(`/__test/dashboard?scenario=${encodeURIComponent(scenario)}`);
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}
