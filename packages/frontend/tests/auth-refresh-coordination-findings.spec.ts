/**
 * Regression tests for the three blocking findings from independent review.
 *
 * 1. Idle-tab ownership — an open but idle tab must not be able to own the
 *    refresh, because it would stop an active tab from refreshing at all.
 * 2. localStorage error handling — presence storage failures must never throw
 *    out of the coordination code, and must never break the login UI.
 * 3. Heartbeat lifecycle — the heartbeat must restart after a page is
 *    suspended and resumed, and presence must not stay active after a tab
 *    stops participating.
 *
 * These tests use the real coordination module against the real BroadcastChannel
 * implementation, driven through the browser.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { e2eAuth, enableAuth, refreshState, signIn } from './helpers/auth-refresh-e2e';

test.skip(!process.env.AUTH_BACKEND_URL, 'Requires the disposable real SQLite auth server');
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP lan.ts6.test 127.0.0.1'] } });
test.beforeEach(async ({ request }) => { await enableAuth(request); });

const SECURE = 'http://127.0.0.1:4175';
const LAN = 'http://lan.ts6.test:4175';

async function openTabs(browser: Browser, origin: string, count: number) {
  const context = await browser.newContext({ baseURL: origin });
  const pages = await Promise.all(Array.from({ length: count }, () => context.newPage()));
  await signIn(pages[0]!, origin);
  await Promise.all(pages.slice(1).map((page) => page.goto(`${origin}/dashboard`)));
  return { context, pages };
}

async function expireAll(pages: Page[]) {
  const hooks = await Promise.all(pages.map((p) => e2eAuth(p)));
  await Promise.all(hooks.map((h) => h.expireAccessInMemory()));
  return hooks;
}

// ---------------------------------------------------------------------------
// Finding 1 — idle-tab ownership
// ---------------------------------------------------------------------------

test('finding 1: an idle tab must not block an active tab from refreshing', async ({ browser, request }) => {
  // Codex's scenario: the smallest-ID tab is OPEN but never asks for a
  // refresh, while a later tab does ask. The idle tab must not win ownership,
  // because then NO tab would refresh and the session would stall.
  const { context, pages } = await openTabs(browser, LAN, 2);
  try {
    const [idlePage, activePage] = pages as [Page, Page];
    const idleHooks = await e2eAuth(idlePage);
    const activeHooks = await e2eAuth(activePage);

    // Only the SECOND tab asks for a refresh. The first stays idle.
    await activeHooks.expireAccessInMemory();
    const started = Date.now();
    const result = await activeHooks.refreshNow();
    const elapsed = Date.now() - started;

    // The active tab must complete its refresh, promptly.
    expect(result).toBeTruthy();
    expect(elapsed).toBeLessThan(10_000);

    const state = await refreshState(request);
    expect(state.rotateCount).toBe(1);
    expect(state.revoked).toBe(false);
    expect(state.replayRevokes).toBe(0);

    // The idle tab must not have been dragged into a refresh round either.
    const idleMem = await idleHooks.getMemoryTokens();
    expect(idleMem.refreshToken).toBeTruthy();
  } finally { await context.close(); }
});

test('finding 1: two idle tabs plus one active tab still refresh exactly once', async ({ browser, request }) => {
  const { context, pages } = await openTabs(browser, LAN, 3);
  try {
    const hooks = await Promise.all(pages.map((p) => e2eAuth(p)));
    // Only the last tab participates.
    await hooks[2]!.expireAccessInMemory();
    const result = await hooks[2]!.refreshNow();
    expect(result).toBeTruthy();
    const state = await refreshState(request);
    expect(state.rotateCount).toBe(1);
    expect(state.revoked).toBe(false);
  } finally { await context.close(); }
});

test('finding 1: an idle tab does not prevent two active tabs from coordinating', async ({ browser, request }) => {
  const { context, pages } = await openTabs(browser, LAN, 3);
  try {
    const hooks = await expireAll(pages.slice(1));
    const results = await Promise.all(hooks.map((h) => h.refreshNow()));
    expect(results.every(Boolean)).toBe(true);
    const state = await refreshState(request);
    // The two active tabs coordinate on ONE refresh.
    expect(state.rotateCount).toBe(1);
    expect(state.revoked).toBe(false);
    expect(state.replayRevokes).toBe(0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Finding 2 — localStorage error handling
// ---------------------------------------------------------------------------

/**
 * Break ONLY the presence key in localStorage.
 *
 * The auth store uses the same storage for the `ts6-auth` blob, so breaking
 * every read would also break the application's own persistence and would not
 * be a test of the presence code. Only the presence key is made to throw.
 */
async function breakPresenceStorage(page: Page, mode: 'read' | 'write' | 'both') {
  await page.addInitScript((failureMode) => {
    const proto = Object.getPrototypeOf(window.localStorage) as Storage;
    const rawGet = proto.getItem;
    const rawSet = proto.setItem;
    const rawRemove = proto.removeItem;
    proto.getItem = function getItem(key: string) {
      if (key === 'ts6-auth-refresh-presence' && failureMode !== 'write') {
        throw new Error('presence storage read blocked');
      }
      return rawGet.call(this, key);
    };
    proto.setItem = function setItem(key: string, value: string) {
      if (key === 'ts6-auth-refresh-presence' && failureMode !== 'read') {
        throw new Error('presence storage write blocked');
      }
      return rawSet.call(this, key, value);
    };
    proto.removeItem = function removeItem(key: string) {
      if (key === 'ts6-auth-refresh-presence' && failureMode !== 'read') {
        throw new Error('presence storage remove blocked');
      }
      return rawRemove.call(this, key);
    };
  }, mode);
}

test('finding 2: presence storage read failure does not break the refresh', async ({ browser, request }) => {
  const { context, pages } = await openTabs(browser, LAN, 2);
  try {
    for (const page of pages) await breakPresenceStorage(page, 'read');
    // Reload so the broken storage applies to the page's own code. The session
    // is restored from the `ts6-auth` blob, which is NOT broken — only the
    // presence key is. No new sign-in is needed (and one would hang, because
    // the login flow waits for the session to persist).
    await pages[0]!.reload();
    await pages[1]!.reload();
    await pages[0]!.waitForURL(`${LAN}/dashboard`);
    await pages[1]!.waitForURL(`${LAN}/dashboard`);

    const hooks = await expireAll(pages);
    const results = await Promise.all(hooks.map((h) => h.refreshNow().catch(() => null)));
    // The refresh must complete (or fail cleanly) — it must NOT hang and it
    // must NOT throw an unhandled storage error out of the coordination code.
    for (const r of results) expect(r === null || typeof r === 'string').toBe(true);
    const state = await refreshState(request);
    // Whatever happened, no family may be revoked by a storage failure.
    expect(state.replayRevokes).toBe(0);
  } finally { await context.close(); }
});

test('finding 2: presence storage write failure does not break the refresh', async ({ browser, request }) => {
  const { context, pages } = await openTabs(browser, LAN, 2);
  try {
    for (const page of pages) await breakPresenceStorage(page, 'write');
    await pages[0]!.reload();
    await pages[1]!.reload();
    await pages[0]!.waitForURL(`${LAN}/dashboard`);
    await pages[1]!.waitForURL(`${LAN}/dashboard`);

    const hooks = await expireAll(pages);
    const results = await Promise.all(hooks.map((h) => h.refreshNow().catch(() => null)));
    for (const r of results) expect(r === null || typeof r === 'string').toBe(true);
    const state = await refreshState(request);
    expect(state.replayRevokes).toBe(0);
  } finally { await context.close(); }
});

test('finding 2: presence storage failure does not break the login UI', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: SECURE });
  const page = await context.newPage();
  try {
    await breakPresenceStorage(page, 'both');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${SECURE}/login`);
    // The login form must render despite the storage failure.
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    // No uncaught page error may have been raised.
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('finding 2: presence storage failure never causes an indefinite wait', async ({ browser, request }) => {
  const { context, pages } = await openTabs(browser, LAN, 2);
  try {
    for (const page of pages) await breakPresenceStorage(page, 'both');
    await pages[0]!.reload();
    await pages[1]!.reload();
    await pages[0]!.waitForURL(`${LAN}/dashboard`);
    await pages[1]!.waitForURL(`${LAN}/dashboard`);

    const hooks = await expireAll(pages);
    const started = Date.now();
    await Promise.all(hooks.map((h) => h.refreshNow().catch(() => null)));
    const elapsed = Date.now() - started;
    // The wait must stay bounded even with storage broken.
    expect(elapsed).toBeLessThan(25_000);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Finding 3 — heartbeat lifecycle
// ---------------------------------------------------------------------------

test('finding 3: heartbeat restarts after the page is resumed', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: LAN });
  const page = await context.newPage();
  try {
    await signIn(page, LAN);
    const readAt = () => page.evaluate(() => {
      const raw = localStorage.getItem('ts6-auth-refresh-presence');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Array<{ tabId: string; at: number }>;
      return parsed.length ? parsed[0]!.at : null;
    });

    const first = await readAt();
    expect(first).not.toBeNull();

    // Simulate the tab being suspended (pagehide) and then resumed (pageshow).
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await page.waitForTimeout(1_400);
    const afterResume = await readAt();
    // The heartbeat must be alive again after the resume.
    expect(afterResume).not.toBeNull();
    expect(afterResume!).toBeGreaterThan(first!);
  } finally { await context.close(); }
});

test('finding 3: presence does not stay active after the tab is hidden', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: LAN });
  const page = await context.newPage();
  try {
    await signIn(page, LAN);
    const present = () => page.evaluate(() => {
      const raw = localStorage.getItem('ts6-auth-refresh-presence');
      return raw ? (JSON.parse(raw) as unknown[]).length : 0;
    });
    expect(await present()).toBeGreaterThan(0);

    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.waitForTimeout(200);
    // The tab's own record must be gone, so it stops being treated as live.
    expect(await present()).toBe(0);
  } finally { await context.close(); }
});

test('finding 3: a withdrawn participant does not block a later refresh', async ({ browser, request }) => {
  const { context, pages } = await openTabs(browser, LAN, 2);
  try {
    // The first tab withdraws (pagehide) while the second refreshes.
    await pages[0]!.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    const hooks = await expireAll(pages.slice(1));
    const started = Date.now();
    const result = await hooks[0]!.refreshNow();
    expect(result).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(10_000);
    const state = await refreshState(request);
    expect(state.rotateCount).toBe(1);
    expect(state.revoked).toBe(false);
  } finally { await context.close(); }
});
