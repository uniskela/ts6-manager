import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const viewports = [
  [390, 844],
  [430, 932],
  [768, 1024],
  [844, 390],
  [1440, 900],
] as const;

async function signInForTables(
  page: Page,
  request: APIRequestContext,
  scenario: 'populated' | 'empty' = 'populated',
) {
  await request.post('/__test/dashboard?scenario=normal');
  await request.post(`/__test/data-table?scenario=${scenario}`);
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function openTable(page: Page, path: '/clients' | '/complaints') {
  await page.goto(path);
  await expect(page.getByRole('heading')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('consumers opt into compact sticky or comfortable non-sticky presentation', async ({ page, request }) => {
  await signInForTables(page, request);
  await openTable(page, '/clients');

  const clients = page.getByRole('region', { name: 'Clients table' });
  await expect(clients).toHaveAttribute('data-density', 'compact');
  await expect(clients).toHaveAttribute('data-sticky-header', 'true');
  await expect(clients.getByRole('columnheader', { name: /Nickname/ })).toHaveCSS('position', 'sticky');

  await openTable(page, '/complaints');
  const complaints = page.getByRole('region', { name: 'Complaints table' });
  await expect(complaints).toHaveAttribute('data-density', 'comfortable');
  await expect(complaints).toHaveAttribute('data-sticky-header', 'false');
  await expect(complaints.getByRole('columnheader', { name: /From/ })).toHaveCSS('position', 'static');
});

test('sortable headers expose state and cycle by keyboard', async ({ page, request }) => {
  await signInForTables(page, request);
  await openTable(page, '/complaints');

  const fromHeader = page.getByRole('columnheader', { name: /From/ });
  const sortButton = fromHeader.getByRole('button', { name: /Sort by From/ });
  await expect(fromHeader).toHaveAttribute('aria-sort', 'none');
  await sortButton.focus();
  await page.keyboard.press('Enter');
  await expect(fromHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('tbody tr').first().getByRole('cell').first()).toHaveText('Ada');

  await page.keyboard.press('Enter');
  await expect(fromHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('tbody tr').first().getByRole('cell').first()).toHaveText('Zoe');

  await page.keyboard.press('Enter');
  await expect(fromHeader).toHaveAttribute('aria-sort', 'none');
});

test('global search is labelled, clearable, and distinguishes filtered-empty from no data', async ({ page, request }) => {
  await signInForTables(page, request);
  await openTable(page, '/complaints');

  const search = page.getByRole('searchbox', { name: 'Search complaints' });
  await search.fill('Reported target B');
  await expect(page.getByRole('cell', { name: 'Mira' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Ada' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('cell', { name: 'Ada' })).toBeVisible();

  await search.fill('not present');
  await expect(page.getByText('No complaints match your search')).toBeVisible();
  await expect(page.getByText('0 results')).toBeVisible();
  await expect(page.getByText(/\d+ \/ \d+/)).toHaveCount(0);

  await request.post('/__test/data-table?scenario=empty');
  await page.reload();
  await expect(page.getByText('No complaints found')).toBeVisible();
  await expect(page.getByText('No complaints match your search')).toHaveCount(0);
});

test('pagination reports filtered rows and disables first and last page controls', async ({ page, request }) => {
  await signInForTables(page, request);
  await openTable(page, '/clients');

  await expect(page.getByText('25 results')).toBeVisible();
  await expect(page.getByText('1 / 2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('2 / 2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeEnabled();

  await page.getByRole('searchbox', { name: 'Search clients' }).fill('10.0.0.25');
  await expect(page.getByText('1 result', { exact: true })).toBeVisible();
  await expect(page.getByText(/\/ 0/)).toHaveCount(0);
});

test('sticky headers remain visible within vertical table scrolling', async ({ page, request }) => {
  await page.setViewportSize({ width: 768, height: 500 });
  await signInForTables(page, request);
  await openTable(page, '/clients');

  const table = page.getByRole('region', { name: 'Clients table' });
  const header = table.getByRole('columnheader', { name: /Nickname/ });
  expect(await table.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await table.evaluate(element => { element.scrollTop = 300; });
  await expect.poll(() => table.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const scrollport = await table.boundingBox();
  const pinnedHeader = await header.boundingBox();
  const borderWidth = await table.evaluate(element => element.clientTop);
  expect(scrollport).not.toBeNull();
  expect(pinnedHeader).not.toBeNull();
  expect(pinnedHeader!.y).toBeGreaterThanOrEqual(scrollport!.y);
  expect(pinnedHeader!.y).toBeLessThanOrEqual(scrollport!.y + borderWidth + 1);
});

test('mobile overflow stays contained, announces directions, and keeps row actions tappable', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInForTables(page, request);
  await openTable(page, '/clients');

  const table = page.getByRole('region', { name: 'Clients table' });
  expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  const scrollHint = page.getByText('Scroll right for more columns');
  await expect(scrollHint).toBeVisible();
  expect(await scrollHint.evaluate(element => Number.parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.001);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await table.focus();
  await expect(table).toBeFocused();

  await table.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect(page.getByText('Scroll left for more columns')).toBeVisible();
  const action = page.getByRole('button', { name: 'Actions for Ada Admin' });
  const actionState = page.locator('button[aria-label="Actions for Ada Admin"]');
  await action.scrollIntoViewIfNeeded();
  const target = await action.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(40);
  expect(target?.height).toBeGreaterThanOrEqual(40);
  await action.click();
  await expect(actionState).toHaveAttribute('aria-expanded', 'true');
});

test('a fitting table has no horizontal-scroll affordance', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInForTables(page, request);
  await openTable(page, '/complaints');

  const table = page.getByRole('region', { name: 'Complaints table' });
  expect(await table.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.getByText(/Scroll (right|left|horizontally) for more columns/)).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Scroll right for more columns')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByText(/Scroll (right|left|horizontally) for more columns/)).toHaveCount(0);
});

for (const [width, height] of viewports) {
  test(`data table keeps horizontal overflow local at ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    await signInForTables(page, request);
    await openTable(page, '/clients');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const [theme, accent] of [['light', 'red'], ['dark', 'violet'], ['black', 'amber']] as const) {
  test(`sticky table header remains opaque and focusable in ${theme}/${accent}`, async ({ page, request }) => {
    await page.addInitScript(({ theme, accent }) => {
      localStorage.setItem('ts6-ui', JSON.stringify({
        state: { sidebarCollapsed: false, baseTheme: theme, accent },
        version: 2,
      }));
    }, { theme, accent });
    await signInForTables(page, request);
    await openTable(page, '/clients');

    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveAttribute('data-accent', accent);
    const header = page.getByRole('columnheader', { name: /Nickname/ });
    expect(await header.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    const button = header.getByRole('button', { name: /Sort by Nickname/ });
    const restingShadow = await button.evaluate(element => getComputedStyle(element).boxShadow);
    await button.focus();
    await expect(button).toBeFocused();
    await expect.poll(() => button.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe(restingShadow);
  });
}
