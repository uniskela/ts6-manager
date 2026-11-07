import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

export type E2EAuthTest = {
  getMemoryTokens: () => { accessToken: string | null; refreshToken: string | null };
  expireAccessInMemory: () => Promise<void>;
  refreshNow: () => Promise<string | null>;
  logoutLocal: () => void;
};

export type RefreshState = {
  rotateCount: number;
  replayRevokes: number;
  presented: string[];
  live: string | null;
  revoked: boolean;
  seq?: number | null;
  consumedCount?: number;
};

export async function enableAuth(request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/auth?on');
}

export async function signIn(page: Page, origin = '') {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(`${origin}/dashboard`);
}

export async function e2eAuth(page: Page): Promise<E2EAuthTest> {
  const ok = await page.evaluate(() => Boolean((window as unknown as { __ts6AuthTest?: unknown }).__ts6AuthTest));
  if (!ok) {
    throw new Error('__ts6AuthTest missing — rebuild with pnpm --filter @ts6/frontend run build:e2e');
  }
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

export async function refreshState(request: APIRequestContext): Promise<RefreshState> {
  return (await request.get('/__test/refresh-state')).json() as RefreshState;
}

export async function concurrentRefresh(pages: Page[]) {
  const hooks = await Promise.all(pages.map((p) => e2eAuth(p)));
  await Promise.all(hooks.map((h) => h.expireAccessInMemory()));
  return Promise.all(hooks.map((h) => h.refreshNow()));
}

export async function openSecondTab(context: BrowserContext, path = '/dashboard') {
  const page = await context.newPage();
  await page.goto(path);
  return page;
}
