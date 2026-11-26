import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import {
  e2eAuth,
  enableAuth,
  muteAuthPersist,
  openSecondTab,
  redactAuthDiag,
  redactRefreshStateDiag,
  refreshState,
  signIn,
  unmuteAuthPersist,
} from './helpers/auth-refresh-e2e';

type AuthBlob = {
  state: {
    accessToken: string | null;
    refreshToken: string | null;
    user: { id: number; username: string; displayName: string; role: string } | null;
    authRev?: number;
    sessionKey?: string | null;
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

    // Sequencing only: mute follower writes while the leader expires+rotates.
    // Production stale-write coverage lives in the unmuted test below.
    await muteAuthPersist(pageB);

    await hooksA.expireAccessInMemory();
    const memAfterExpire = await hooksA.getMemoryTokens();
    const persistAfterExpire = await readPersistedAuth(page);
    const rotatedAccess = await hooksA.refreshNow();
    expect(rotatedAccess).toBeTruthy();
    try {
      await expect.poll(async () => (await readPersistedAuth(page)).refreshToken).not.toBe(initial.refreshToken);
    } catch {
      const mem = await hooksA.getMemoryTokens();
      const persisted = await readPersistedAuth(page);
      const state = await refreshState(request);
      throw new Error(
        `Tab A did not persist rotation after refreshNow. `
        + `beforeRefresh mem=${JSON.stringify(redactAuthDiag(memAfterExpire))} `
        + `persist=${JSON.stringify(redactAuthDiag(persistAfterExpire))} `
        + `after mem=${JSON.stringify(redactAuthDiag(mem))} `
        + `persist=${JSON.stringify(redactAuthDiag(persisted))} `
        + `refreshState=${JSON.stringify(redactRefreshStateDiag(state))} `
        + `rotatedAccessEqInitial=${rotatedAccess === initial.accessToken}`,
      );
    }
    const afterA = await readPersistedAuth(page);
    expect((await refreshState(request)).rotateCount).toBe(1);

    const staleMem = await hooksB.getMemoryTokens();
    expect(staleMem.refreshToken).toBe(initial.refreshToken);

    await expect.poll(async () => (await readPersistedAuth(pageB)).refreshToken).toBe(afterA.refreshToken);

    await unmuteAuthPersist(pageB);

    await hooksB.expireAccessInMemory();
    await expect.poll(async () => (await readPersistedAuth(pageB)).refreshToken).toBe(afterA.refreshToken);
    expect((await hooksB.getMemoryTokens()).refreshToken).toBe(initial.refreshToken);

    const adopted = await hooksB.refreshNow();
    if (!adopted) {
      const mem = await hooksB.getMemoryTokens();
      const persisted = await readPersistedAuth(pageB);
      const state = await refreshState(request);
      throw new Error(
        `adopt returned null mem=${JSON.stringify(redactAuthDiag(mem))} `
        + `persist=${JSON.stringify(redactAuthDiag(persisted))} `
        + `refreshState=${JSON.stringify(redactRefreshStateDiag(state))}`,
      );
    }
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

  test('persist guard blocks unmuted stale follower rewrite after peer rotation', async ({ page, context, request }) => {
    await signIn(page);
    const initial = await readPersistedAuth(page);
    const pageB = await openSecondTab(context);
    const hooksA = await e2eAuth(page);
    const hooksB = await e2eAuth(pageB);

    const staleBefore = await hooksB.getMemoryTokens();
    expect(staleBefore.refreshToken).toBe(initial.refreshToken);
    expect(staleBefore.authRev).toBe(initial.authRev ?? 0);

    // No mute: follower may flush freely. Leader rotates to a newer authRev.
    await hooksA.expireAccessInMemory();
    const rotated = await hooksA.refreshNow();
    expect(rotated).toBeTruthy();
    await expect.poll(async () => (await readPersistedAuth(page)).refreshToken).not.toBe(initial.refreshToken);
    const afterA = await readPersistedAuth(page);
    expect((afterA.authRev ?? 0)).toBeGreaterThan(initial.authRev ?? 0);
    expect((await refreshState(request)).rotateCount).toBe(1);

    // Follower still holds R0 + old authRev in memory — flush through zustand persist.
    expect((await hooksB.getMemoryTokens()).refreshToken).toBe(initial.refreshToken);
    await hooksB.flushPersistFromMemory();

    const afterStaleFlush = await readPersistedAuth(page);
    expect(afterStaleFlush.refreshToken).toBe(afterA.refreshToken);
    expect(afterStaleFlush.accessToken).toBe(afterA.accessToken);
    expect(afterStaleFlush.authRev).toBe(afterA.authRev);
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
    await Promise.all([
      page.waitForURL('**/login'),
      page.evaluate(() => {
        (window as unknown as { __ts6AuthTest: { logoutLocal: () => void } }).__ts6AuthTest.logoutLocal();
      }),
    ]);
    await signIn(page);
    const hooksAfterLogin = await e2eAuth(page);

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

    const staleA = await hooksAfterLogin.getMemoryTokens();
    expect(staleA.refreshToken).toBe(afterLocal.refreshToken);
    await expect.poll(async () => (await readPersistedAuth(page)).refreshToken).toBe(afterPeer.refreshToken);
    await hooksAfterLogin.expireAccessInMemory();
    await expect.poll(async () => (await readPersistedAuth(page)).refreshToken).toBe(afterPeer.refreshToken);
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
    const initial = await readPersistedAuth(page);
    const pageB = await openSecondTab(context, '/settings');
    const hooksA = await e2eAuth(page);
    const hooksB = await e2eAuth(pageB);

    await muteAuthPersist(pageB);

    await hooksA.expireAccessInMemory();
    const rotated = await hooksA.refreshNow();
    expect(rotated).toBeTruthy();
    await expect.poll(async () => (await readPersistedAuth(page)).refreshToken).not.toBe(initial.refreshToken);
    const peer = await readPersistedAuth(page);
    expect((await refreshState(request)).rotateCount).toBeGreaterThanOrEqual(1);

    await pageB.bringToFront();
    await expect.poll(async () => (await readPersistedAuth(pageB)).refreshToken).toBe(peer.refreshToken);
    expect((await hooksB.getMemoryTokens()).refreshToken).toBe(initial.refreshToken);

    await unmuteAuthPersist(pageB);

    const resumed = await hooksB.refreshNow();
    if (!resumed) {
      const mem = await hooksB.getMemoryTokens();
      const persisted = await readPersistedAuth(pageB);
      const state = await refreshState(request);
      throw new Error(
        `resume returned null mem=${JSON.stringify(redactAuthDiag(mem))} `
        + `persist=${JSON.stringify(redactAuthDiag(persisted))} `
        + `refreshState=${JSON.stringify(redactRefreshStateDiag(state))}`,
      );
    }
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
    expect(after.authRev).toBe(before.authRev);
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

  test('logout after peer rotation tombstones successor and revokes family', async ({ page, context, request }) => {
    await signIn(page);
    const initial = await readPersistedAuth(page);
    expect(initial.sessionKey).toBeTruthy();
    const pageB = await openSecondTab(context);
    const hooksA = await e2eAuth(page);
    const hooksB = await e2eAuth(pageB);

    // Keep Tab B on R0 in memory while Tab A rotates to R1 (same sessionKey).
    await muteAuthPersist(pageB);
    await hooksA.expireAccessInMemory();
    const rotatedAccess = await hooksA.refreshNow();
    expect(rotatedAccess).toBeTruthy();
    await expect.poll(async () => (await readPersistedAuth(page)).refreshToken).not.toBe(initial.refreshToken);
    const afterRotate = await readPersistedAuth(page);
    expect(afterRotate.sessionKey).toBe(initial.sessionKey);
    expect((await hooksB.getMemoryTokens()).refreshToken).toBe(initial.refreshToken);
    expect((await hooksB.getMemoryTokens()).sessionKey).toBe(initial.sessionKey);
    await unmuteAuthPersist(pageB);

    const stale = await hooksB.getMemoryTokens();
    const logoutRes = await request.post('/api/auth/logout', {
      data: { refreshToken: stale.refreshToken },
    });
    expect(logoutRes.status()).toBe(204);
    expect((await refreshState(request)).revoked).toBe(true);

    await hooksB.logoutLocal();
    await expect.poll(async () => {
      const raw = await pageB.evaluate(() => localStorage.getItem('ts6-auth'));
      if (!raw) return true;
      const state = (JSON.parse(raw) as AuthBlob).state;
      return !state.accessToken && !state.refreshToken;
    }).toBe(true);

    await expect.poll(async () => {
      const memA = await hooksA.getMemoryTokens();
      return memA.refreshToken === null && memA.accessToken === null;
    }).toBe(true);

    const resurrect = await request.post('/api/auth/refresh', {
      data: { refreshToken: afterRotate.refreshToken },
    });
    expect(resurrect.status()).toBe(401);
  });

  test('stale logout after same-account new login leaves the new session intact', async ({ page, context, request }) => {
    await signIn(page);
    const first = await readPersistedAuth(page);
    const pageB = await openSecondTab(context);
    const hooksA = await e2eAuth(page);
    const hooksB = await e2eAuth(pageB);

    // Freeze Tab A on the first lineage while Tab B mints a genuine new login
    // (new family + sessionKey) without a logout BC that would clear Tab A.
    await muteAuthPersist(page);
    const minted = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'test-password' },
    });
    expect(minted.status()).toBe(200);
    const pair = await minted.json() as {
      accessToken: string;
      refreshToken: string;
      user: { id: number; username: string; displayName: string; role: 'admin' | 'viewer' };
    };
    await hooksB.replaceSession(pair.accessToken, pair.refreshToken, pair.user);
    const second = await readPersistedAuth(pageB);
    expect(second.refreshToken).toBe(pair.refreshToken);
    expect(second.sessionKey).toBeTruthy();
    expect(second.sessionKey).not.toBe(first.sessionKey);

    const stale = await hooksA.getMemoryTokens();
    expect(stale.refreshToken).toBe(first.refreshToken);
    expect(stale.sessionKey).toBe(first.sessionKey);

    const logoutRes = await request.post('/api/auth/logout', {
      data: { refreshToken: stale.refreshToken },
    });
    expect(logoutRes.status()).toBe(204);
    // Prior-family token is unknown to the new family — must not revoke it.
    expect((await refreshState(request)).revoked).toBe(false);
    expect((await refreshState(request)).live).toBe(second.refreshToken);

    await hooksA.logoutLocal();
    await unmuteAuthPersist(page);

    const persisted = await readPersistedAuth(pageB);
    expect(persisted.refreshToken).toBe(second.refreshToken);
    expect(persisted.sessionKey).toBe(second.sessionKey);
    expect((await hooksB.getMemoryTokens()).refreshToken).toBe(second.refreshToken);

    const stillLive = await request.post('/api/auth/refresh', {
      data: { refreshToken: second.refreshToken },
    });
    expect(stillLive.status()).toBe(200);
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

  test('followers adopt leader authRev without inflating it', async ({ browser, request }: { browser: Browser; request: APIRequestContext }) => {
    await enableAuth(request);
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'locks', { configurable: true, get: () => undefined });
    });
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const pageC = await context.newPage();
    try {
      await signIn(pageA);
      const before = await readPersistedAuth(pageA);
      await pageB.goto('/dashboard');
      await pageC.goto('/dashboard');
      await expect(pageB).toHaveURL('/dashboard');
      await expect(pageC).toHaveURL('/dashboard');

      const hooks = await Promise.all([pageA, pageB, pageC].map((p) => e2eAuth(p)));
      await Promise.all(hooks.map((h) => h.expireAccessInMemory()));
      const tokens = await Promise.all(hooks.map((h) => h.refreshNow()));
      expect(new Set(tokens.filter(Boolean)).size).toBe(1);

      const memRevs = await Promise.all(hooks.map(async (h) => (await h.getMemoryTokens()).authRev));
      const persistA = await readPersistedAuth(pageA);
      const persistB = await readPersistedAuth(pageB);
      const persistC = await readPersistedAuth(pageC);

      // One leader rotation bump only — not +1 per follower.
      expect(persistA.authRev).toBe((before.authRev ?? 0) + 1);
      expect(persistB.authRev).toBe(persistA.authRev);
      expect(persistC.authRev).toBe(persistA.authRev);
      expect(new Set(memRevs).size).toBe(1);
      expect(memRevs[0]).toBe(persistA.authRev);

      const state = await refreshState(request);
      expect(state.rotateCount).toBe(1);
      expect(state.replayRevokes).toBe(0);
    } finally {
      await context.close();
    }
  });
});
