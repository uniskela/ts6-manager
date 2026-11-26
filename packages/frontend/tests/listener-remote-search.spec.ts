import { expect, test, type Page, type Route } from '@playwright/test';
import {
  REMOTE_CSRF,
  REMOTE_SESSION,
  REMOTE_TOKEN,
  expectCookieAuth,
  fulfillJson,
  installRemoteAuthRoutes,
  remotePath,
} from './listener-remote-fixtures';

const idA = 'a'.repeat(22);
const idB = 'b'.repeat(22);

const state = {
  bot: { id: 12, name: 'Aurora Radio', status: 'playing' },
  nowPlaying: { id: '1', title: 'Glass Harbor', artist: 'Northline', duration: 180 },
  upNext: [],
  upNextCount: 0,
  permissions: {
    searchLibrary: true,
    addToQueue: true,
    requestUrl: true,
    browsePlaylists: false,
    searchMusic: true,
  },
};

const found = {
  results: [
    { id: idA, title: 'Neon Skyline', artist: 'Midnight Transit', duration: 214 },
    { id: idB, title: 'Paper Lanterns', artist: null, duration: 95 },
  ],
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

type Reply = { status: number; body: unknown };

/** Opens the remote with search allowed. `search` and `queue` decide each reply. */
async function openSearch(page: Page, options: {
  remoteState?: unknown;
  search?: (body: unknown) => Reply;
  queue?: (body: unknown) => Reply;
} = {}) {
  const calls = { search: [] as unknown[], queue: [] as unknown[] };
  await installRemoteAuthRoutes(page);
  await page.route(remotePath('/state'), async (route) => {
    expectCookieAuth(route);
    await fulfillJson(route, options.remoteState ?? state);
  });
  await page.route(/\/api\/listener-remote\/library/, async (route) => {
    expectCookieAuth(route);
    await fulfillJson(route, { songs: [], page: 1, pageSize: 25 });
  });
  await page.route(remotePath('/search'), async (route) => {
    expectCookieAuth(route);
    const body = route.request().postDataJSON();
    calls.search.push(body);
    const reply = options.search?.(body) ?? { status: 200, body: found };
    return fulfillJson(route, reply.body, reply.status);
  });
  await page.route(remotePath('/search/queue'), async (route) => {
    expectCookieAuth(route);
    const body = route.request().postDataJSON();
    calls.queue.push(body);
    const reply = options.queue?.(body) ?? { status: 200, body: { ok: true } };
    return fulfillJson(route, reply.body, reply.status);
  });
  await page.goto(`/remote#token=${REMOTE_TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Aurora Radio' })).toBeVisible();
  return calls;
}

function searchRegion(page: Page) {
  return page.getByRole('region', { name: 'Search', exact: true });
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('phone: search and queue a result with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const calls = await openSearch(page);
  const region = searchRegion(page);
  await expect(region.getByText(/Songs over 15 minutes and live streams are not shown\./)).toBeVisible();

  const input = page.getByLabel('Search for a song');
  await input.focus();
  await page.keyboard.type('  neon skyline  ');
  await page.keyboard.press('Enter');

  const results = page.getByTestId('search-results');
  await expect(results.getByText('Neon Skyline')).toBeVisible();
  await expect(results).toBeFocused();
  await expect(region.locator('[aria-live="polite"]')).toHaveText('2 search results.');
  expect(calls.search).toEqual([{ query: 'neon skyline' }]);
  expect(page.url()).not.toContain('neon');

  const add = page.getByRole('button', { name: 'Add Neon Skyline to the queue' });
  const addBox = await add.boundingBox();
  expect(addBox?.width).toBeGreaterThanOrEqual(44);
  expect(addBox?.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press('Tab');
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(region.getByText('Added Neon Skyline to the queue.')).toBeVisible();
  expect(calls.queue).toEqual([{ resultId: idA }]);
  await expect(add).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Paper Lanterns to the queue' })).toBeVisible();

  const stored = await page.evaluate((secrets) => {
    const dump = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
    return secrets.some((secret) => dump.includes(secret));
  }, [REMOTE_TOKEN, REMOTE_SESSION, idA, idB, 'neon skyline']);
  expect(stored).toBe(false);
  await noHorizontalOverflow(page);
});

test('desktop: search sits in the add column without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSearch(page);
  const now = await page.getByRole('heading', { name: 'Now playing' }).boundingBox();
  const search = await page.getByLabel('Search for a song').boundingBox();
  expect(now && search).toBeTruthy();
  expect(search!.x).toBeGreaterThan(now!.x + 300);
  await page.getByLabel('Search for a song').fill('neon');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('search-results').getByText('Paper Lanterns')).toBeVisible();
  await noHorizontalOverflow(page);
});

test('a refused result is removed and the reason is announced', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const calls = await openSearch(page, {
    queue: (body) => ((body as { resultId: string }).resultId === idA
      ? { status: 422, body: { error: 'This track is longer than 15 minutes.', code: 'too_long' } }
      : { status: 404, body: { error: 'Search result not found.', code: 'not_found' } }),
  });
  await page.getByLabel('Search for a song').fill('neon');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Add Neon Skyline to the queue' }).click();

  const region = searchRegion(page);
  const tooLong = region.getByRole('alert');
  await expect(tooLong).toHaveText('This track is longer than 15 minutes.');
  await expect(tooLong).toBeFocused();
  await expect(page.getByRole('button', { name: 'Add Neon Skyline to the queue' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add Paper Lanterns to the queue' }).click();
  await expect(region.getByRole('alert')).toHaveText('These search results have run out. Search again.');
  await expect(page.getByTestId('search-results').getByRole('listitem')).toHaveCount(0);
  expect(calls.queue).toEqual([{ resultId: idA }, { resultId: idB }]);
});

test('a full queue keeps the session and says to search again', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openSearch(page, {
    queue: () => ({ status: 409, body: { error: 'The queue is full.', code: 'queue_full' } }),
  });
  await page.getByLabel('Search for a song').fill('neon');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Add Neon Skyline to the queue' }).click();
  await expect(searchRegion(page).getByRole('alert')).toHaveText('The queue is full. Search again to try this song.');
  await expect(page.getByRole('heading', { name: 'Aurora Radio' })).toBeVisible();
});

test('rate limits, empty results and links get plain messages', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let reply: Reply = { status: 200, body: { results: [], expiresAt: found.expiresAt } };
  const calls = await openSearch(page, { search: () => reply });
  const region = searchRegion(page);
  const input = page.getByLabel('Search for a song');

  await input.fill('nothing here');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(region.getByText('No songs found.')).toBeVisible();
  await expect(region.locator('[aria-live="polite"]')).toHaveText('0 search results.');

  reply = { status: 429, body: { error: 'Too many remote requests', code: 'rate_limited' } };
  await input.fill('neon');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(region.getByRole('alert')).toHaveText('Too many searches right now. Wait a minute, then try again.');

  await input.fill('https://example.com/song');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(region.getByRole('alert')).toHaveText('Paste a song name, not a link.');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(calls.search).toEqual([{ query: 'nothing here' }, { query: 'neon' }]);

  await input.fill('a');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
});

test('an expired session during search returns to the link prompt', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openSearch(page, {
    search: () => ({ status: 401, body: { error: 'Remote access is invalid or expired', code: 'invalid_access' } }),
  });
  await page.getByLabel('Search for a song').fill('neon');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Remote access is invalid or expired');
  await expect(page.getByText(/Type !remote/)).toBeVisible();
  await expect(page.getByLabel('Search for a song')).toHaveCount(0);
});

test('search is hidden unless the listener may search and queue', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openSearch(page, {
    remoteState: { ...state, permissions: { ...state.permissions, addToQueue: false, requestUrl: false } },
  });
  await expect(page.getByLabel('Search songs')).toBeVisible();
  await expect(page.getByLabel('Search for a song')).toHaveCount(0);
});

test('search is hidden when the backend does not offer it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { searchMusic: _omit, ...withoutFlag } = state.permissions;
  await openSearch(page, { remoteState: { ...state, permissions: withoutFlag } });
  await expect(page.getByLabel('Media URL')).toBeVisible();
  await expect(page.getByLabel('Search for a song')).toHaveCount(0);
});

test('two tabs keep CSRF after the second tab probes the session', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4175' });
  const pageA = await context.newPage();
  await pageA.setViewportSize({ width: 375, height: 812 });

  const queueCalls: Array<{ tab: string; csrf: string | undefined }> = [];
  const install = async (page: Page, tab: string) => {
    await installRemoteAuthRoutes(page);
    await page.route(remotePath('/state'), async (route) => {
      expectCookieAuth(route);
      await fulfillJson(route, state);
    });
    await page.route(/\/api\/listener-remote\/library/, (route) => fulfillJson(route, { songs: [], page: 1, pageSize: 25 }));
    await page.route(remotePath('/search'), async (route) => {
      expectCookieAuth(route);
      await fulfillJson(route, found);
    });
    await page.route(remotePath('/search/queue'), async (route) => {
      expectCookieAuth(route);
      queueCalls.push({ tab, csrf: route.request().headers()['x-csrf-token'] });
      await fulfillJson(route, { ok: true });
    });
  };

  await install(pageA, 'A');
  await pageA.goto(`/remote#token=${REMOTE_TOKEN}`);
  await expect(pageA.getByRole('heading', { name: 'Aurora Radio' })).toBeVisible();

  const pageB = await context.newPage();
  await pageB.setViewportSize({ width: 375, height: 812 });
  await install(pageB, 'B');
  // No fragment token — restore from shared HttpOnly cookie via GET /session.
  await pageB.goto('/remote');
  await expect(pageB.getByRole('heading', { name: 'Aurora Radio' })).toBeVisible();

  await pageA.getByLabel('Search for a song').fill('neon');
  await pageA.getByRole('button', { name: 'Search', exact: true }).click();
  await pageA.getByRole('button', { name: 'Add Neon Skyline to the queue' }).click();
  await expect(pageA.getByText('Added Neon Skyline to the queue.')).toBeVisible();

  await pageB.getByLabel('Search for a song').fill('neon');
  await pageB.getByRole('button', { name: 'Search', exact: true }).click();
  await pageB.getByRole('button', { name: 'Add Paper Lanterns to the queue' }).click();
  await expect(pageB.getByText('Added Paper Lanterns to the queue.')).toBeVisible();

  expect(queueCalls).toEqual([
    { tab: 'A', csrf: REMOTE_CSRF },
    { tab: 'B', csrf: REMOTE_CSRF },
  ]);
  await context.close();
});
