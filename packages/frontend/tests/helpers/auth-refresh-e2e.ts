import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

export type E2EAuthTest = {
  getMemoryTokens: () => {
    accessToken: string | null;
    refreshToken: string | null;
    authRev: number;
    sessionKey: string | null;
  };
  expireAccessInMemory: () => Promise<void>;
  flushPersistFromMemory: () => void;
  refreshNow: () => Promise<string | null>;
  logoutLocal: () => void;
  replaceSession: (
    accessToken: string,
    refreshToken: string,
    user: { id: number; username: string; displayName: string; role: 'admin' | 'viewer' },
  ) => void;
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
    flushPersistFromMemory: () => page.evaluate(() => {
      (window as unknown as { __ts6AuthTest: E2EAuthTest }).__ts6AuthTest.flushPersistFromMemory();
    }),
    refreshNow: () => page.evaluate(() => (
      (window as unknown as { __ts6AuthTest: E2EAuthTest }).__ts6AuthTest.refreshNow()
    )),
    logoutLocal: () => page.evaluate(() => {
      (window as unknown as { __ts6AuthTest: E2EAuthTest }).__ts6AuthTest.logoutLocal();
    }),
    replaceSession: (accessToken, refreshToken, user) => page.evaluate(({ accessToken: a, refreshToken: r, user: u }) => {
      (window as unknown as { __ts6AuthTest: E2EAuthTest }).__ts6AuthTest.replaceSession(a, r, u);
    }, { accessToken, refreshToken, user }),
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

/** Mute this tab's `ts6-auth` writes (controlled sequencing only). */
export async function muteAuthPersist(page: Page) {
  await page.evaluate(() => {
    const raw = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key: string, value: string) => {
      if (key === 'ts6-auth') return;
      raw(key, value);
    };
    (window as unknown as { __ts6UnmuteAuthPersist?: () => void }).__ts6UnmuteAuthPersist = () => {
      localStorage.setItem = raw;
    };
  });
}

export async function unmuteAuthPersist(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __ts6UnmuteAuthPersist?: () => void }).__ts6UnmuteAuthPersist?.();
  });
}

/** Redacted auth snapshot for CI failure diagnostics — never raw tokens. */
export function redactAuthDiag(input: {
  accessToken?: string | null;
  refreshToken?: string | null;
  user?: { id?: number } | null;
  authRev?: number;
} | null | undefined) {
  if (!input) return null;
  return {
    hasAccess: Boolean(input.accessToken),
    hasRefresh: Boolean(input.refreshToken),
    accessLen: input.accessToken?.length ?? 0,
    refreshLen: input.refreshToken?.length ?? 0,
    userId: input.user?.id ?? null,
    authRev: typeof input.authRev === 'number' ? input.authRev : null,
  };
}

export function redactRefreshStateDiag(state: RefreshState) {
  return {
    rotateCount: state.rotateCount,
    replayRevokes: state.replayRevokes,
    revoked: state.revoked,
    livePresent: state.live != null,
    presentedCount: state.presented?.length ?? 0,
    seq: state.seq ?? null,
    consumedCount: state.consumedCount ?? null,
  };
}
