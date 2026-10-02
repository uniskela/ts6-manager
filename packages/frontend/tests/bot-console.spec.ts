import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

const noStop = { lastMusicStop: null, lastVideoStop: null };

function media(now: number) {
  return [
    {
      botId: 1, botName: 'Aurora Radio', serverConfigId: 1, serverName: 'Operations Voice', status: 'playing',
      channelId: 5, channelName: 'Lounge',
      session: { id: 'a', kind: 'music', state: 'active', botId: 1, botName: 'Aurora Radio', startedAt: now - 90_000, label: 'Neon Skyline' },
      music: { title: 'Neon Skyline', artist: 'Midnight Transit', live: false, position: 75, duration: 214 },
      video: null, ...noStop,
    },
    {
      botId: 3, botName: 'Backup Bot', serverConfigId: 1, serverName: 'Operations Voice', status: 'stopped',
      channelId: null, channelName: null, session: null, music: null, video: null, ...noStop,
    },
  ];
}

const track = (id: string, title: string) => ({ id, title, artist: 'Artist', duration: 200, source: 'local' });

// Track 2 ("Neon Skyline", index 1) is playing, so Up next starts at absolute index 2.
const state = {
  status: 'playing', position: 75, duration: 214, volume: 60, currentIndex: 1, shuffle: false, repeat: 'off',
  nowPlaying: track('t2', 'Neon Skyline'),
  queue: [track('t1', 'Opening'), track('t2', 'Neon Skyline'), track('t3', 'Third Song'), track('t4', 'Fourth Song'), track('t5', 'Fifth Song')],
};

let currentState: typeof state = state;

async function mockBot(page: Page) {
  currentState = state;
  const calls: { method: string; url: string; body: unknown }[] = [];
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: media(Date.now()) }));
  await page.route('**/api/music-bots/1/state', (r) => r.fulfill({ json: currentState }));
  await page.route(/\/api\/music-bots\/1\/queue(\/.*)?$/, async (r) => {
    const req = r.request();
    calls.push({ method: req.method(), url: req.url(), body: req.postDataJSON?.() ?? null });
    await r.fulfill({ json: { success: true } });
  });
  return calls;
}

test('opens a bot console from the Bot Hub', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockBot(page);
  await signIn(page, request);

  await page.goto('/bot-hub');
  await page.getByRole('link', { name: 'Open console for Aurora Radio' }).click();
  await expect(page).toHaveURL('/bot-hub/1');
  await expect(page.getByRole('heading', { name: 'Aurora Radio', level: 1 })).toBeVisible();
  await expect(page.getByText('Operations Voice · #Lounge')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Now playing' })).toBeVisible();
});

test('Up next lists the tracks after the playing one', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockBot(page);
  await signIn(page, request);

  await page.goto('/bot-hub/1');
  const list = page.getByRole('list', { name: 'Up next' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('listitem').first()).toContainText('Third Song');
});

test('keyboard reorder and remove send absolute queue indexes', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1400 });
  const calls = await mockBot(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');

  // Move "Third Song" (Up next 0 → absolute 2) down one place (absolute 3).
  await expect(page.getByRole('list', { name: 'Up next' }).getByRole('listitem')).toHaveCount(3);
  const handle = page.getByRole('button', { name: 'Drag to reorder Third Song' });
  await handle.scrollIntoViewIfNeeded();
  await handle.focus();
  // Each key waits for dnd-kit's live-region announcement of the step before it.
  const live = page.locator('[id^="DndLiveRegion"]');
  await page.keyboard.press('Space');
  await expect(live).toContainText('over droppable area t3#0');
  await page.keyboard.press('ArrowDown');
  await expect(live).toContainText('over droppable area t4#0');
  await page.keyboard.press('Space');
  await expect.poll(() => calls.find((c) => c.method === 'PUT')?.body).toEqual({ from: 2, to: 3 });

  // Remove "Fifth Song" (Up next 2 → absolute 4).
  await page.getByRole('button', { name: 'Remove Fifth Song from the queue' }).click();
  await expect.poll(() => calls.find((c) => c.method === 'DELETE')?.url ?? '').toMatch(/\/queue\/4$/);
});

test('a queue refresh during a drag does not change what the drop moves', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1400 });
  const calls = await mockBot(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await expect(page.getByRole('list', { name: 'Up next' }).getByRole('listitem')).toHaveCount(3);

  const live = page.locator('[id^="DndLiveRegion"]');
  await page.getByRole('button', { name: 'Drag to reorder Third Song' }).focus();
  await page.keyboard.press('Space');
  await expect(live).toContainText('over droppable area t3#0');

  // Someone else queues a song mid-drag; the 2 s refresh brings it in.
  currentState = { ...state, queue: [...state.queue, track('t6', 'Sixth Song')] };
  await page.waitForTimeout(2600);

  await page.keyboard.press('ArrowDown');
  await expect(live).toContainText('over droppable area t4#0');
  await page.keyboard.press('Space');
  await expect.poll(() => calls.find((c) => c.method === 'PUT')?.body).toEqual({ from: 2, to: 3 });
});

test('an unknown bot shows Bot not found with a way back', async ({ page, request }) => {
  await mockBot(page);
  await signIn(page, request);
  await page.goto('/bot-hub/999');
  await expect(page.getByText('Bot not found')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Bot Hub' })).toBeVisible();
});

test('an offline bot asks to be started before playing anything', async ({ page, request }) => {
  await mockBot(page);
  await signIn(page, request);
  await page.goto('/bot-hub/3');
  await expect(page.getByText('Start the bot to play something')).toBeVisible();
});

test('the console fits a phone screen', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBot(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await expect(page.getByRole('heading', { name: 'Up next' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a failed Start bot says why', async ({ page, request }) => {
  await mockBot(page);
  await page.route('**/api/music-bots/3/start', (r) => r.fulfill({ status: 500, json: { error: 'Server is unreachable' } }));
  await signIn(page, request);
  await page.goto('/bot-hub/3');
  await page.getByRole('button', { name: 'Start bot' }).click();
  await expect(page.getByRole('alert')).toContainText('Server is unreachable');
});

test('a failed queue load shows an error instead of an empty queue', async ({ page, request }) => {
  await mockBot(page);
  await page.route('**/api/music-bots/1/state', (r) => r.fulfill({ status: 500, json: { error: 'State unavailable' } }));
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await expect(page.getByText('Could not load the queue')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Queue is empty')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Shuffle' })).toHaveCount(0);
});

test('queue rows cannot be dragged again until a move is saved', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1400 });
  const calls = await mockBot(page);
  let release: () => void = () => {};
  const saved = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/music-bots\/1\/queue\/move$/, async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await saved;
    await r.fulfill({ json: { success: true } });
  });
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await expect(page.getByRole('list', { name: 'Up next' }).getByRole('listitem')).toHaveCount(3);

  const live = page.locator('[id^="DndLiveRegion"]');
  await page.getByRole('button', { name: 'Drag to reorder Third Song' }).focus();
  await page.keyboard.press('Space');
  await expect(live).toContainText('over droppable area t3#0');
  await page.keyboard.press('ArrowDown');
  await expect(live).toContainText('over droppable area t4#0');
  await page.keyboard.press('Space');
  await expect.poll(() => calls.filter((c) => c.method === 'PUT').length).toBe(1);

  await expect(page.getByRole('button', { name: 'Drag to reorder Fifth Song' })).toBeDisabled();
  release();
  await expect(page.getByRole('button', { name: 'Drag to reorder Fifth Song' })).toBeEnabled();
  expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
});

test('until source tabs arrive, the console links to the media controls for this bot', async ({ page, request }) => {
  await mockBot(page);
  await signIn(page, request);
  await page.goto('/bot-hub/1');
  await expect(page.getByRole('link', { name: 'Open Media Bots' })).toHaveAttribute('href', '/media-bots?bot=1');
});
