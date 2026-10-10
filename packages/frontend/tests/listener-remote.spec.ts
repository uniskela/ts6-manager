import { expect, test, type Page, type Route } from '@playwright/test';

const token = 't'.repeat(43);
const session = 's'.repeat(43);
const title = 'Neon Skyline and a long title that has to stay inside a 375px phone';

const playing = {
  bot: { id: 12, name: 'Aurora Radio', status: 'playing' },
  nowPlaying: { id: '1', title, artist: 'Midnight Transit', duration: 214 },
  upNext: [{ id: '2', title: 'Glass Harbor', artist: 'Northline', duration: 180 }],
  upNextCount: 2,
  permissions: { searchLibrary: true, addToQueue: true, requestUrl: true },
};

const library = {
  songs: [{ id: 9, title: 'Paper Moon', artist: 'Low Tide', duration: 200 }],
  page: 1,
  pageSize: 25,
};

function remote(path: string): RegExp {
  return new RegExp(`/api/listener-remote${path}$`);
}

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('opens a phone remote from a fragment token', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let exchanges = 0;
  let releaseState: () => void = () => {};
  const stateGate = new Promise<void>((resolve) => { releaseState = resolve; });
  let releaseUrl: () => void = () => {};
  const urlGate = new Promise<void>((resolve) => { releaseUrl = resolve; });
  let urlCalls = 0;
  const queueBodies: unknown[] = [];

  await page.route(remote('/exchange'), async (route) => {
    exchanges += 1;
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().postDataJSON()).toEqual({ token });
    await fulfill(route, { session, expiresAt: new Date(Date.now() + 60_000).toISOString(), botId: 12 });
  });
  await page.route(remote('/state'), async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${session}`);
    await stateGate;
    await fulfill(route, playing);
  });
  await page.route(/\/api\/listener-remote\/library/, async (route) => {
    await fulfill(route, library);
  });
  await page.route(remote('/queue'), async (route) => {
    queueBodies.push(route.request().postDataJSON());
    await fulfill(route, { ok: true });
  });
  await page.route(remote('/requests'), async (route) => {
    urlCalls += 1;
    expect(route.request().postDataJSON()).toEqual({ url: 'https://example.com/track.mp3' });
    await urlGate;
    await fulfill(route, { ok: true });
  });

  await page.goto(`/remote#token=${token}`);
  await expect(page).toHaveURL(/\/remote$/);
  expect(page.url()).not.toContain(token);
  await expect(page.getByText('Loading the remote…')).toBeVisible();
  releaseState();
  await expect(page.getByRole('heading', { name: 'Aurora Radio' })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Playback progress' })).toHaveAttribute('aria-valuetext', 'Playing · 3:34');
  await expect(page.getByRole('list', { name: 'Up next' }).getByText('Glass Harbor')).toBeVisible();
  await expect(page.getByText('Paper Moon')).toBeVisible();
  expect(exchanges).toBe(1);

  await page.getByRole('button', { name: 'Add Paper Moon to the queue' }).click();
  await expect(page.getByText('Added Paper Moon to the queue.')).toBeVisible();
  expect(queueBodies).toEqual([{ songId: 9 }]);

  await page.getByLabel('Media URL').fill('https://example.com/track.mp3');
  await page.getByRole('button', { name: 'Request URL' }).click();
  await expect(page.getByRole('button', { name: 'Adding…' })).toBeDisabled();
  releaseUrl();
  await expect(page.getByText('Added the link to the queue.')).toBeVisible();
  expect(urlCalls).toBe(1);

  for (const name of ['Pause', 'Skip', 'Stop', 'Shuffle', 'Volume', 'Settings']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.locator('a[href="/settings"], a[href="/bot-hub"]')).toHaveCount(0);
  const stored = await page.evaluate((secrets) => {
    const dump = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
    return secrets.some((secret) => dump.includes(secret));
  }, [token, session]);
  expect(stored).toBe(false);
  const addBox = await page.getByRole('button', { name: 'Add Paper Moon to the queue' }).boundingBox();
  expect(addBox?.height).toBeGreaterThanOrEqual(44);
  expect(addBox?.width).toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await noHorizontalOverflow(page);
});

test('hides library actions the listener is not allowed to use', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route(remote('/exchange'), (route) => fulfill(route, { session, expiresAt: new Date(Date.now() + 60_000).toISOString(), botId: 12 }));
  await page.route(remote('/state'), (route) => fulfill(route, {
    ...playing,
    permissions: { searchLibrary: true, addToQueue: false, requestUrl: false },
  }));
  await page.route(/\/api\/listener-remote\/library/, (route) => fulfill(route, library));
  await page.goto(`/remote#token=${token}`);
  await expect(page.getByLabel('Search songs')).toBeVisible();
  await expect(page.getByText('Paper Moon')).toBeVisible();
  await expect(page.getByRole('button', { name: /Add .+ to the queue/ })).toHaveCount(0);
  await expect(page.getByLabel('Media URL')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request URL' })).toHaveCount(0);
});

test('clears the remote when the session is revoked', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route(remote('/exchange'), (route) => fulfill(route, { session, expiresAt: new Date(Date.now() + 60_000).toISOString(), botId: 12 }));
  await page.route(remote('/state'), (route) => fulfill(route, playing));
  await page.route(/\/api\/listener-remote\/library/, (route) => fulfill(route, library));
  await page.route(remote('/queue'), (route) => fulfill(route, { error: 'Listener access is invalid or expired.', code: 'invalid_access' }, 401));
  await page.goto(`/remote#token=${token}`);
  await expect(page.getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Add Paper Moon to the queue' }).click();
  await expect(page.getByRole('alert')).toHaveText('Listener access is invalid or expired.');
  await expect(page.getByText(title)).toHaveCount(0);
  await expect(page.getByText('Paper Moon')).toHaveCount(0);
});

test('shows an empty remote, a load error, and the link prompt', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/remote#token=short');
  await expect(page).toHaveURL(/\/remote$/);
  await expect(page.getByText(/Type !remote/)).toBeVisible();

  let stateStatus = 503;
  let stateBody: unknown = { error: 'Listener remote is unavailable.', code: 'unavailable' };
  let exchangeSession = session;
  await page.route(remote('/exchange'), (route) => fulfill(route, { session: exchangeSession, expiresAt: new Date(Date.now() + 60_000).toISOString(), botId: 12 }));
  await page.route(remote('/state'), (route) => fulfill(route, stateBody, stateStatus));
  await page.route(/\/api\/listener-remote\/library/, (route) => fulfill(route, { songs: [], page: 1, pageSize: 25 }));
  await page.goto(`/remote#token=${token}`);
  await expect(page.getByRole('alert')).toHaveText('Listener remote is unavailable.');
  await expect(page.getByText('Nothing is playing.')).toHaveCount(0);

  stateStatus = 200;
  stateBody = { ...playing, nowPlaying: null, upNext: [], upNextCount: 0 };
  exchangeSession = 'v'.repeat(43);
  await page.goto(`/remote#token=${'u'.repeat(43)}`);
  await expect(page.getByText('Nothing is playing.')).toBeVisible();
  await expect(page.getByText('Nothing is queued.')).toBeVisible();
  await expect(page.getByText('No songs found.')).toBeVisible();
});
