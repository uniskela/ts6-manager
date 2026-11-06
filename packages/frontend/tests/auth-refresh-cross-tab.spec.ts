import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

type AuthBlob = {
  state: {
    accessToken: string | null;
    refreshToken: string | null;
    user: { id: number; username: string; displayName: string; role: string } | null;
  };
  version: number;
};

type E2EAuthTest = {
  getMemoryTokens: () => { accessToken: string | null; refreshToken: string | null };
  expireAccessInMemory: () => Promise<void>;
  refreshNow: () => Promise<string | null>;
  logoutLocal: () => void;
};

async function enableAuth(request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/auth?on');
}

async function enableE2EHooks(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('ts6-e2e-hooks', '1');
  });
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function readPersistedAuth(page: Page): Promise<AuthBlob['state']> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('ts6-auth');
    if (!raw) throw new Error('missing ts6-auth');
    return (JSON.parse(raw) as AuthBlob).state;
  });
}

async function e2e(page: Page): Promise<E2EAuthTest> {
  const hooks = await page.evaluateHandle(() => (window as unknown as { __ts6AuthTest?: E2EAuthTest }).__ts6AuthTest);
  const value = await hooks.jsonValue();
  if (!value) throw new Error('__ts6AuthTest hooks missing — is ts6-e2e-hooks set before load?');
  return {
    getMemoryTokens: () => page.evaluate(() => {
      const h = (window as unknown as { __ts6AuthTest: E2EAuthTest }).__ts6AuthTest;
      return h.getMemoryTokens();
    }),
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
    seq: number | null;
    revoked: boolean;
    consumedCount: number;
  };
}

async function openSecondTab(context: BrowserContext, path = '/dashboard') {
  const page = await context.newPage();
  await page.goto(path);
  return page;
}

test.describe('real two-tab refresh coordination', () => {
  test.beforeEach(async ({ request, context }) => {
    await enableAuth(request);
    await enableE2EHooks(context);
  });

  test('concurrent refresh from two tabs rotates once and both adopt the winner', async ({ page, context, request }) => {
    await signIn(page);
    const before = await readPersistedAuth(page);
    const pageB = await openSecondTab(context);
    await expect(pageB).toHaveURL('/dashboard');
    expect((await readPersistedAuth(pageB)).refreshToken).toBe(before.refreshToken);

    const hooksA = await e2e(page);
    const hooksB = await e2e(pageB);
    await hooksA.expireAccessInMemory();
    await hooksB.expireAccessInMemory();

    const [tokenA, tokenB] = await Promise.all([hooksA.refreshNow(), hooksB.refreshNow()]);
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(tokenA).toBe(tokenB);

    const authA = await readPersistedAuth(page);
    const authB = await readPersistedAuth(pageB);
    expect(authA.refreshToken).toBe(authB.refreshToken);
    expect(authA.refreshToken).not.toBe(before.refreshToken);

    const memA = await hooksA.getMemoryTokens();
    const memB = await hooksB.getMemoryTokens();
    expect(memA.refreshToken).toBe(authA.refreshToken);
    expect(memB.refreshToken).toBe(authA.refreshToken);

    const state = await refreshState(request);
    expect(state.rotateCount).toBe(1);
    expect(state.replayRevokes).toBe(0);
    expect(state.revoked).toBe(false);
    expect(state.presented).toEqual([before.refreshToken]);
  });

  test('tab with stale in-memory refresh adopts peer rotation', async ({ page, context, request }) => {
    await signIn(page);
    const initial = await readPersistedAuth(page);
    const pageB = await openSecondTab(context);
    const hooksA = await e2e(page);
    const hooksB = await e2e(pageB);

    await hooksA.expireAccessInMemory();
    const rotatedAccess = await hooksA.refreshNow();
    expect(rotatedAccess).toBeTruthy();
    const afterA = await readPersistedAuth(page);
    expect(afterA.refreshToken).not.toBe(initial.refreshToken);

    // B still holds R1 in memory; persist already has the peer-rotated pair.
    const staleMem = await hooksB.getMemoryTokens();
    expect(staleMem.refreshToken).toBe(initial.refreshToken);

    await hooksB.expireAccessInMemory();
    const adopted = await hooksB.refreshNow();
    expect(adopted).toBeTruthy();
    expect(adopted).toBe(afterA.accessToken);

    const memB = await hooksB.getMemoryTokens();
    expect(memB.refreshToken).toBe(afterA.refreshToken);
    expect(memB.accessToken).toBe(afterA.accessToken);

    const state = await refreshState(request);
    expect(state.presented).toEqual([initial.refreshToken]);
    expect(state.rotateCount).toBe(1);
    expect(state.replayRevokes).toBe(0);
    expect(state.revoked).toBe(false);
  });

  test('background tab resumes after peer refresh', async ({ page, context, request }) => {
    await signIn(page);
    const pageB = await openSecondTab(context, '/settings');
    const hooksA = await e2e(page);
    const hooksB = await e2e(pageB);

    await hooksA.expireAccessInMemory();
    await hooksA.refreshNow();
    const peer = await readPersistedAuth(page);

    await pageB.bringToFront();
    await hooksB.expireAccessInMemory();
    const resumed = await hooksB.refreshNow();
    expect(resumed).toBeTruthy();
    expect((await hooksB.getMemoryTokens()).refreshToken).toBe(peer.refreshToken);

    const state = await refreshState(request);
    expect(state.replayRevokes).toBe(0);
    expect(state.revoked).toBe(false);
  });

  test('browser reload keeps persisted credentials', async ({ page }) => {
    await signIn(page);
    const before = await readPersistedAuth(page);
    await page.reload();
    await expect(page).toHaveURL('/dashboard');
    const after = await readPersistedAuth(page);
    expect(after.refreshToken).toBe(before.refreshToken);
    expect(after.accessToken).toBe(before.accessToken);
  });

  test('consumed refresh replay revokes the family', async ({ page, request }) => {
    await signIn(page);
    const initial = await readPersistedAuth(page);

    const rotate = await request.post('/api/auth/refresh', {
      data: { refreshToken: initial.refreshToken },
    });
    expect(rotate.status()).toBe(200);
    const rotated = await rotate.json();

    const replay = await request.post('/api/auth/refresh', {
      data: { refreshToken: initial.refreshToken },
    });
    expect(replay.status()).toBe(401);

    const state = await refreshState(request);
    expect(state.replayRevokes).toBe(1);
    expect(state.revoked).toBe(true);

    const afterRevoke = await request.post('/api/auth/refresh', {
      data: { refreshToken: rotated.refreshToken },
    });
    expect(afterRevoke.status()).toBe(401);
  });

  test('logout and failed refresh do not restore revoked credentials', async ({ page, context, request }) => {
    await signIn(page);
    const pageB = await openSecondTab(context);
    const before = await readPersistedAuth(page);
    const hooksA = await e2e(page);
    const hooksB = await e2e(pageB);

    const logoutRes = await request.post('/api/auth/logout', {
      data: { refreshToken: before.refreshToken },
    });
    expect(logoutRes.status()).toBe(204);
    expect((await refreshState(request)).revoked).toBe(true);

    // Clear memory + persist on both pages so neither rehydrates revoked creds.
    await hooksA.logoutLocal();
    await page.waitForURL('**/login', { timeout: 5000 }).catch(() => undefined);
    await hooksB.logoutLocal();
    await pageB.waitForURL('**/login', { timeout: 5000 }).catch(() => undefined);

    await page.goto('/login');
    await expect(page).toHaveURL('/login');
    await pageB.goto('/login');
    await expect(pageB).toHaveURL('/login');
    for (const tab of [page, pageB]) {
      const persisted = await tab.evaluate(() => {
        const raw = localStorage.getItem('ts6-auth');
        if (!raw) return { accessToken: null, refreshToken: null };
        return (JSON.parse(raw) as AuthBlob).state;
      });
      expect(persisted.accessToken).toBeNull();
      expect(persisted.refreshToken).toBeNull();
    }

    const resurrect = await request.post('/api/auth/refresh', {
      data: { refreshToken: before.refreshToken },
    });
    expect(resurrect.status()).toBe(401);
    expect((await refreshState(request)).revoked).toBe(true);
    expect((await refreshState(request)).live).toBeNull();
  });
});

test.describe('no-Web-Lock BroadcastChannel ownership', () => {
  test('concurrent refresh without locks rotates once via BroadcastChannel', async ({ browser, request }: { browser: Browser; request: APIRequestContext }) => {
    await enableAuth(request);
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('ts6-e2e-hooks', '1');
      Object.defineProperty(navigator, 'locks', { configurable: true, get: () => undefined });
    });
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    try {
      await signIn(pageA);
      const initial = await readPersistedAuth(pageA);
      await pageB.goto('/dashboard');
      await expect(pageB).toHaveURL('/dashboard');

      const hooksA = await e2e(pageA);
      const hooksB = await e2e(pageB);
      await hooksA.expireAccessInMemory();
      await hooksB.expireAccessInMemory();
      const [tokenA, tokenB] = await Promise.all([hooksA.refreshNow(), hooksB.refreshNow()]);
      expect(tokenA).toBeTruthy();
      expect(tokenB).toBeTruthy();
      expect(tokenA).toBe(tokenB);

      const state = await refreshState(request);
      expect(state.rotateCount).toBe(1);
      expect(state.replayRevokes).toBe(0);
      expect(state.revoked).toBe(false);
      expect(initial.refreshToken).toBeTruthy();
    } finally {
      await context.close();
    }
  });
});
