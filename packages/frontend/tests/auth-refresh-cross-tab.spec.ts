import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import {
  e2eAuth,
  enableAuth,
  openSecondTab,
  refreshState,
  signIn,
} from './helpers/auth-refresh-e2e';

type AuthBlob = {
  state: {
    accessToken: string | null;
    refreshToken: string | null;
    user: { id: number; username: string; displayName: string; role: string } | null;
  };
  version: number;
};

async function readPersistedAuth(page: Page): Promise<AuthBlob['state']> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('ts6-auth');
    if (!raw) throw new Error('missing ts6-auth');
    return (JSON.parse(raw) as AuthBlob).state;
  });
}

test.describe('real two-tab refresh coordination', () => {
  test.beforeEach(async ({ request }) => {
    await enableAuth(request);
  });

  test('concurrent refresh from two tabs rotates once and both adopt the winner', async ({ page, context, request }) => {
    await signIn(page);
    const before = await readPersistedAuth(page);
    const pageB = await openSecondTab(context);
    await expect(pageB).toHaveURL('/dashboard');
    expect((await readPersistedAuth(pageB)).refreshToken).toBe(before.refreshToken);

    const hooksA = await e2eAuth(page);
    const hooksB = await e2eAuth(pageB);
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
    const hooksA = await e2eAuth(page);
    const hooksB = await e2eAuth(pageB);

    await hooksA.expireAccessInMemory();
    const rotatedAccess = await hooksA.refreshNow();
    expect(rotatedAccess).toBeTruthy();
    const afterA = await readPersistedAuth(page);
    expect(afterA.refreshToken).not.toBe(initial.refreshToken);

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

  test('after logout+login, Web Lock refresh restores peer adoption', async ({ page, context, request }) => {
    // Secure loopback has navigator.locks — exercises resolveRefresh + markLocalRefreshSuccess.
    await signIn(page);
    const caps = await page.evaluate(() => ({
      locks: typeof navigator !== 'undefined' && Boolean(navigator.locks),
      secure: window.isSecureContext,
    }));
    expect(caps.locks).toBe(true);
    expect(caps.secure).toBe(true);

    const hooksA = await e2eAuth(page);
    // logoutLocal navigates to /login (AppLayout) — wait so evaluate is not aborted.
    await Promise.all([
      page.waitForURL('**/login'),
      page.evaluate(() => {
        (window as unknown as { __ts6AuthTest: { logoutLocal: () => void } }).__ts6AuthTest.logoutLocal();
      }),
    ]);
    await signIn(page);
    const hooksAfterLogin = await e2eAuth(page);

    // Local refresh after session replace must clear ignorePeerResults.
    await hooksAfterLogin.expireAccessInMemory();
    const localRefresh = await hooksAfterLogin.refreshNow();
    expect(localRefresh).toBeTruthy();
    const afterLocal = await readPersistedAuth(page);

    const pageB = await openSecondTab(context);
    const hooksB = await e2eAuth(pageB);
    await hooksB.expireAccessInMemory();
    const peerRotated = await hooksB.refreshNow();
    expect(peerRotated).toBeTruthy();
    const afterPeer = await readPersistedAuth(page);
    expect(afterPeer.refreshToken).not.toBe(afterLocal.refreshToken);

    // Tab A still holds the pre-peer refresh in memory — must adopt, not logout.
    const staleA = await hooksAfterLogin.getMemoryTokens();
    expect(staleA.refreshToken).toBe(afterLocal.refreshToken);
    await hooksAfterLogin.expireAccessInMemory();
    const adopted = await hooksAfterLogin.refreshNow();
    expect(adopted).toBeTruthy();
    expect(adopted).toBe(afterPeer.accessToken);
    expect((await hooksAfterLogin.getMemoryTokens()).refreshToken).toBe(afterPeer.refreshToken);

    const state = await refreshState(request);
    expect(state.replayRevokes).toBe(0);
    expect(state.revoked).toBe(false);
  });

  test('background tab resumes after peer refresh', async ({ page, context, request }) => {
    await signIn(page);
    const pageB = await openSecondTab(context, '/settings');
    const hooksA = await e2eAuth(page);
    const hooksB = await e2eAuth(pageB);

    await hooksA.expireAccessInMemory();
    await hooksA.refreshNow();
    const peer = await readPersistedAuth(page);

    await pageB.bringToFront();
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
    const hooksA = await e2eAuth(page);
    const hooksB = await e2eAuth(pageB);

    const logoutRes = await request.post('/api/auth/logout', {
      data: { refreshToken: before.refreshToken },
    });
    expect(logoutRes.status()).toBe(204);
    expect((await refreshState(request)).revoked).toBe(true);

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
      Object.defineProperty(navigator, 'locks', { configurable: true, get: () => undefined });
    });
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    try {
      await signIn(pageA);
      const initial = await readPersistedAuth(pageA);
      await pageB.goto('/dashboard');
      await expect(pageB).toHaveURL('/dashboard');

      const hooksA = await e2eAuth(pageA);
      const hooksB = await e2eAuth(pageB);
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
