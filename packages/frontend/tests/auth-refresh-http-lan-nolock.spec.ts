/**
 * Plain HTTP LAN-style origin (insecure context): Web Locks absent,
 * BroadcastChannel ownership must prevent family revoke on concurrent refresh.
 */
import { expect, test, chromium, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAN_ORIGIN = 'http://lan.ts6.test:4176';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:4176';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

type E2EAuthTest = {
  expireAccessInMemory: () => Promise<void>;
  refreshNow: () => Promise<string | null>;
  logoutLocal: () => void;
};

test.use({
  baseURL: LOOPBACK_ORIGIN,
  launchOptions: {
    args: ['--host-resolver-rules=MAP lan.ts6.test 127.0.0.1'],
  },
});

test.describe.configure({ mode: 'serial' });

async function waitForServer(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not ready: ${url}`);
}

async function enableAuth(request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/auth?on');
}

async function signIn(page: Page) {
  await page.goto(`${LAN_ORIGIN}/login`);
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(`${LAN_ORIGIN}/dashboard`);
}

async function e2e(page: Page): Promise<E2EAuthTest> {
  const ok = await page.evaluate(() => Boolean((window as unknown as { __ts6AuthTest?: unknown }).__ts6AuthTest));
  if (!ok) throw new Error('__ts6AuthTest missing');
  return {
    expireAccessInMemory: () => page.evaluate(() => (
      (window as unknown as { __ts6AuthTest: E2EAuthTest }).__ts6AuthTest.expireAccessInMemory()
    )),
    refreshNow: () => page.evaluate(() => (
      (window as unknown as { __ts6AuthTest: E2EAuthTest }).__ts6AuthTest.refreshNow()
    )),
    logoutLocal: () => page.evaluate(() => {
      (window as unknown as { __ts6AuthTest: E2EAuthTest }).__ts6AuthTest.logoutLocal();
    }),
  };
}

async function refreshState(request: APIRequestContext) {
  return (await request.get('/__test/refresh-state')).json() as {
    rotateCount: number;
    replayRevokes: number;
    presented: string[];
    live: string | null;
    revoked: boolean;
  };
}

async function concurrentRefresh(pages: Page[]) {
  const hooks = await Promise.all(pages.map((p) => e2e(p)));
  await Promise.all(hooks.map((h) => h.expireAccessInMemory()));
  return Promise.all(hooks.map((h) => h.refreshNow()));
}

let server: ChildProcess | null = null;

test.beforeAll(async () => {
  server = spawn('node', [path.join(ROOT, 'serve-production.mjs')], {
    env: {
      ...process.env,
      APP_ORIGIN: LAN_ORIGIN,
      PORT: '4176',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer('http://127.0.0.1:4176/login');
});

test.afterAll(async () => {
  server?.kill('SIGTERM');
});

test('HTTP LAN: insecure, no locks, BroadcastChannel present', async ({ page, request }) => {
  await enableAuth(request);
  await page.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
  await page.goto(`${LAN_ORIGIN}/login`);
  const caps = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasLocks: typeof navigator.locks !== 'undefined' && !!navigator.locks,
    hasBroadcastChannel: typeof BroadcastChannel !== 'undefined',
  }));
  expect(caps.isSecureContext).toBe(false);
  expect(caps.hasLocks).toBe(false);
  expect(caps.hasBroadcastChannel).toBe(true);
});

test('two-tab concurrent refresh on HTTP LAN does not revoke the family', async ({ browser, request }) => {
  await enableAuth(request);
  const context = await browser.newContext({ baseURL: LAN_ORIGIN });
  await context.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await signIn(pageA);
    await pageB.goto(`${LAN_ORIGIN}/dashboard`);
    const tokens = await concurrentRefresh([pageA, pageB]);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).toBeTruthy();
    expect(tokens[0]).toBe(tokens[1]);
    const state = await refreshState(request);
    expect(state.revoked).toBe(false);
    expect(state.replayRevokes).toBe(0);
    expect(state.rotateCount).toBe(1);
  } finally {
    await context.close();
  }
});

test('three-tab concurrent refresh on HTTP LAN rotates once', async ({ browser, request }) => {
  await enableAuth(request);
  const context = await browser.newContext({ baseURL: LAN_ORIGIN });
  await context.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
  const pages = [await context.newPage(), await context.newPage(), await context.newPage()];
  try {
    await signIn(pages[0]!);
    await pages[1]!.goto(`${LAN_ORIGIN}/dashboard`);
    await pages[2]!.goto(`${LAN_ORIGIN}/settings`);
    const tokens = await concurrentRefresh(pages);
    expect(tokens.every(Boolean)).toBe(true);
    expect(new Set(tokens).size).toBe(1);
    const state = await refreshState(request);
    expect(state.revoked).toBe(false);
    expect(state.replayRevokes).toBe(0);
    expect(state.rotateCount).toBe(1);
  } finally {
    await context.close();
  }
});

test('closing a tab during coordination does not leave peers stuck', async ({ browser, request }) => {
  await enableAuth(request);
  const context = await browser.newContext({ baseURL: LAN_ORIGIN });
  await context.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await signIn(pageA);
    await pageB.goto(`${LAN_ORIGIN}/dashboard`);
    const hooksA = await e2e(pageA);
    const hooksB = await e2e(pageB);
    await hooksA.expireAccessInMemory();
    await hooksB.expireAccessInMemory();
    // Start A's refresh, then close mid-coordination; ignore evaluate abort on close.
    void hooksA.refreshNow().catch(() => null);
    await pageA.waitForTimeout(40);
    await pageA.close();
    const tokenB = await hooksB.refreshNow();
    expect(tokenB).toBeTruthy();
    const state = await refreshState(request);
    expect(state.revoked).toBe(false);
    expect(state.rotateCount).toBeGreaterThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test('slow/suspended leader still delivers result to peer', async ({ browser, request }) => {
  await enableAuth(request);
  const context = await browser.newContext({ baseURL: LAN_ORIGIN });
  await context.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await signIn(pageA);
    await pageB.goto(`${LAN_ORIGIN}/dashboard`);
    await pageA.route('**/api/auth/refresh', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const hooksA = await e2e(pageA);
    const hooksB = await e2e(pageB);
    await hooksA.expireAccessInMemory();
    await hooksB.expireAccessInMemory();
    const [tokenA, tokenB] = await Promise.all([hooksA.refreshNow(), hooksB.refreshNow()]);
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(tokenA).toBe(tokenB);
    const state = await refreshState(request);
    expect(state.revoked).toBe(false);
    expect(state.rotateCount).toBe(1);
  } finally {
    await context.close();
  }
});

test('reload during refresh keeps a usable session', async ({ browser, request }) => {
  await enableAuth(request);
  const context = await browser.newContext({ baseURL: LAN_ORIGIN });
  await context.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
  const page = await context.newPage();
  try {
    await signIn(page);
    const hooks = await e2e(page);
    await hooks.expireAccessInMemory();
    void hooks.refreshNow().catch(() => null);
    await page.reload();
    await expect(page).toHaveURL(`${LAN_ORIGIN}/dashboard`);
    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem('ts6-auth');
      if (!raw) return null;
      return (JSON.parse(raw) as { state: { refreshToken: string | null } }).state.refreshToken;
    });
    expect(persisted).toBeTruthy();
    const state = await refreshState(request);
    expect(state.revoked).toBe(false);
  } finally {
    await context.close();
  }
});

test('logout on one tab clears peer credentials without restoring revoked refresh', async ({ browser, request }) => {
  await enableAuth(request);
  const context = await browser.newContext({ baseURL: LAN_ORIGIN });
  await context.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await signIn(pageA);
    await pageB.goto(`${LAN_ORIGIN}/dashboard`);
    const before = await pageA.evaluate(() => {
      const raw = localStorage.getItem('ts6-auth');
      return raw ? (JSON.parse(raw) as { state: { refreshToken: string } }).state.refreshToken : null;
    });
    const hooksA = await e2e(pageA);
    await request.post('/api/auth/logout', { data: { refreshToken: before } });
    await hooksA.logoutLocal();
    await pageB.waitForTimeout(200);
    await pageB.goto(`${LAN_ORIGIN}/login`);
    await expect(pageB).toHaveURL(`${LAN_ORIGIN}/login`);
    const resurrect = await request.post('/api/auth/refresh', { data: { refreshToken: before } });
    expect(resurrect.status()).toBe(401);
  } finally {
    await context.close();
  }
});

test('40-trial concurrent refresh reliability on HTTP LAN', async ({ request }) => {
  test.setTimeout(180_000);
  const browser = await chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP lan.ts6.test 127.0.0.1'],
  });
  const outcomes: Array<{ rotateCount: number; replayRevokes: number; revoked: boolean }> = [];
  try {
    for (let i = 0; i < 40; i++) {
      await enableAuth(request);
      const context = await browser.newContext({ baseURL: LAN_ORIGIN });
      await context.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      try {
        await signIn(pageA);
        await pageB.goto(`${LAN_ORIGIN}/dashboard`);
        await concurrentRefresh([pageA, pageB]);
        const state = await refreshState(request);
        outcomes.push({
          rotateCount: state.rotateCount,
          replayRevokes: state.replayRevokes,
          revoked: state.revoked,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const revokeHits = outcomes.filter((o) => o.revoked || o.replayRevokes >= 1).length;
  const singleWinner = outcomes.filter((o) => o.rotateCount === 1 && !o.revoked && o.replayRevokes === 0).length;
  console.log(JSON.stringify({ trials: outcomes.length, revokeHits, singleWinner }));
  expect(outcomes.length).toBe(40);
  // BroadcastChannel ownership must make family revoke rare; allow a tiny flake budget.
  expect(revokeHits).toBeLessThanOrEqual(2);
  expect(singleWinner).toBeGreaterThanOrEqual(36);
});

test('genuine consumed-token replay still revokes on HTTP LAN', async ({ page, request }) => {
  await enableAuth(request);
  await page.addInitScript(() => localStorage.setItem('ts6-e2e-hooks', '1'));
  await signIn(page);
  const initial = await page.evaluate(() => {
    const raw = localStorage.getItem('ts6-auth');
    if (!raw) throw new Error('missing auth');
    return (JSON.parse(raw) as { state: { refreshToken: string } }).state.refreshToken;
  });
  const rotate = await request.post('/api/auth/refresh', { data: { refreshToken: initial } });
  expect(rotate.status()).toBe(200);
  const rotated = await rotate.json();
  const replay = await request.post('/api/auth/refresh', { data: { refreshToken: initial } });
  expect(replay.status()).toBe(401);
  const state = await refreshState(request);
  expect(state.replayRevokes).toBe(1);
  expect(state.revoked).toBe(true);
  const after = await request.post('/api/auth/refresh', { data: { refreshToken: rotated.refreshToken } });
  expect(after.status()).toBe(401);
});
