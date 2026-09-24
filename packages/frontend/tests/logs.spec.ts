import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/logs?scenario=normal');
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

test('Server Logs 2.0 pages, labels instance vs VS, and keeps filters page-local', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/logs');

  await expect(page.getByTestId('server-logs-page')).toBeVisible();
  await expect(page.getByTestId('logs-scope-label')).toContainText('Virtual server log');
  await expect(page.getByTestId('logs-filter-hint')).toContainText('this page only');
  await expect(page.getByTestId('logs-timezone-hint')).toContainText('does not report whether');
  await expect(page.getByText('timezone unknown')).toHaveCount(0);
  await expect(page.getByText('UNK').first()).toBeVisible();

  await expect(page.getByTestId('logs-older')).toBeEnabled();
  await page.getByTestId('logs-older').click();
  await expect(page.getByTestId('logs-page-meta')).toContainText('Older page');
  await expect(page.getByText('Virtual server started successfully.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('logs-page-meta')).toContainText('Newest page');
  await expect(page.getByText('Virtual server started successfully.')).toBeVisible();

  await page.getByRole('textbox', { name: 'Filter this page' }).fill('no-such-match-on-this-page');
  await expect(page.getByTestId('logs-empty')).toHaveText('No matches on this page.');
  await page.getByRole('textbox', { name: 'Filter this page' }).fill('');

  await page.getByLabel('Level filter this page').click();
  await page.getByRole('option', { name: 'Warning (this page)' }).click();
  await expect(page.getByText(/privilege key/)).toBeVisible();
  await expect(page.getByText(/Client Sample User connected/)).toBeVisible();
  await expect(page.getByText('Virtual server started successfully.')).toHaveCount(0);
  await expect(page.getByTestId('logs-count')).toContainText('of');
  await page.getByLabel('Level filter this page').click();
  await page.getByRole('option', { name: 'All levels (this page)' }).click();

  await page.getByLabel('Log source scope').click();
  await page.getByRole('option', { name: 'Instance log' }).click();
  await expect(page.getByTestId('logs-scope-label')).toContainText('Instance log');
  await expect(page.getByText('TeamSpeak instance started.')).toBeVisible();
  await expect(page.getByText('Virtual server started successfully.')).toHaveCount(0);

  const state = await request.get('/__test/state').then((response) => response.json());
  expect(state.logsRequests.some((entry: { instance: boolean }) => entry.instance === true)).toBeTruthy();
  expect(state.logsRequests.some((entry: { beginPos: string | null }) => entry.beginPos !== null)).toBeTruthy();
});

test('Server Logs distinguishes empty instance log from filter no-matches', async ({ page, request }) => {
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/logs?scenario=instance-empty');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
  await page.goto('/logs');

  await expect(page.getByTestId('server-logs-page')).toBeVisible();
  await page.getByLabel('Log source scope').click();
  await page.getByRole('option', { name: 'Instance log' }).click();
  await expect(page.getByTestId('logs-empty')).toContainText('Instance log returned no entries');
  await expect(page.getByTestId('logs-empty')).not.toHaveText('No matches on this page.');
});

test('Server Logs separates initial fetch failure from stale refresh errors', async ({ page, request }) => {
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/logs?scenario=initial-failure');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
  await page.goto('/logs');

  await expect(page.getByText(/TeamSpeak logview unavailable|Could not load server logs/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

  await request.post('/__test/logs?scenario=normal');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('server-logs-page')).toBeVisible();
  await expect(page.getByText('Virtual server started successfully.')).toBeVisible();

  await request.post('/__test/logs?scenario=refresh-failure');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(/Log refresh failed|last successful page/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Virtual server started successfully.')).toBeVisible();
});

test('Server Logs shows logview I/O clearly and does not auto-retry stampede', async ({ page, request }) => {
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/logs?scenario=logview-io');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
  await page.goto('/logs');

  await expect(page.getByRole('heading', { name: 'TeamSpeak log file unavailable' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/could not read the server logfile.*file input\/output error/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connection failed' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

  await page.waitForTimeout(2500);
  const state = await request.get('/__test/state').then((response) => response.json());
  // One initial fetch only — no React Query retry storm (~1 req/s).
  expect(state.logsRequests.length).toBeLessThanOrEqual(2);
});

test('Server Logs stays contained at 390x844 without document overflow', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsAdmin(page, request);
  await page.goto('/logs');
  await expect(page.getByTestId('server-logs-page')).toBeVisible();
  await expect(page.getByText(/very long path/)).toBeVisible();

  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});
