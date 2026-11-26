/**
 * Cross-tab refresh coordination — investigation harness (real SQLite routes).
 *
 * Captures, per trial:
 *   - number of leaders elected (tabs that issued a refresh POST)
 *   - number of HTTP refresh POSTs
 *   - whether the SAME refresh token was presented more than once
 *   - whether the POSTs overlapped in time
 *   - whether the refresh-token family was revoked
 *   - whether the browser session stayed usable
 *
 * Token identity is reported as a short nonreversible digest, never raw.
 */
import { createHash } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { concurrentRefresh, e2eAuth, enableAuth, refreshState, signIn } from './helpers/auth-refresh-e2e';

test.skip(!process.env.AUTH_BACKEND_URL, 'Requires the disposable real SQLite auth server');
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP lan.ts6.test 127.0.0.1'] } });
test.beforeEach(async ({ request }) => { await enableAuth(request); });

/** Short, nonreversible identifier for a refresh token. */
function tokenId(token: string | null | undefined): string {
  if (!token) return 'none';
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

async function tabs<T>(
  browser: Browser,
  origin: string,
  count: number,
  opts: { delayBcMs?: number; delayReorder?: boolean },
  run: (pages: Page[]) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ baseURL: origin });
  if (opts.delayBcMs) {
    await context.addInitScript((delayMs) => {
      const send = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (message) {
        // Model a stalled sender: claim/leader delivery is delayed.
        if (message?.type === 'claim' || message?.type === 'leader') {
          setTimeout(() => send.call(this, message), delayMs);
        } else send.call(this, message);
      };
    }, opts.delayBcMs);
  }
  const pages = await Promise.all(Array.from({ length: count }, () => context.newPage()));
  try {
    await signIn(pages[0]!, origin);
    await Promise.all(pages.slice(1).map((page) => page.goto(`${origin}/dashboard`)));
    return await run(pages);
  } finally { await context.close(); }
}

type Trial = Record<string, unknown>;

async function runTrial(
  browser: Browser,
  request: import('@playwright/test').APIRequestContext,
  origin: string,
  count: number,
  opts: { delayBcMs?: number },
): Promise<Trial> {
  await enableAuth(request);
  return tabs(browser, origin, count, opts, async (pages) => {
    // Record every refresh POST: which tab, which token, when it started/ended.
    const arrivals: Array<{ tab: number; tokenId: string; start: number; end: number; status: number }> = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!;
      await p.route('**/api/auth/refresh', async (route) => {
        const body = route.request().postDataJSON() as { refreshToken: string };
        const start = Date.now();
        const response = await route.fetch({
          url: route.request().url().replace('http://lan.ts6.test', 'http://127.0.0.1'),
        });
        const end = Date.now();
        arrivals.push({ tab: i, tokenId: tokenId(body.refreshToken), start, end, status: response.status() });
        await route.fulfill({ response });
      });
    }
    const tokens = await concurrentRefresh(pages);
    const state = await refreshState(request);
    const diag = await (await request.get('/__test/refresh-diagnostics')).json() as {
      events: Array<{ index: number; known: boolean; consumed: boolean; successorOfPresented: boolean; family: string | null }>;
    };

    // Overlap: two POSTs overlap when their [start,end) windows intersect.
    let overlapped = false;
    for (let i = 0; i < arrivals.length; i++) {
      for (let j = i + 1; j < arrivals.length; j++) {
        const a = arrivals[i]!, b = arrivals[j]!;
        if (a.start < b.end && b.start < a.end) overlapped = true;
      }
    }
    const distinctTokens = new Set(arrivals.map((a) => a.tokenId));
    return {
      posts: arrivals.length,
      leaders: distinctTokens.size === 0 ? 0 : new Set(arrivals.map((a) => a.tab)).size,
      distinctTokens: distinctTokens.size,
      sameTokenPresented: distinctTokens.size < arrivals.length,
      overlapped,
      revoked: state.revoked,
      replayRevokes: state.replayRevokes,
      rotateCount: state.rotateCount,
      sessionUsable: tokens.every(Boolean) && !state.revoked && state.live !== null,
      nullTokens: tokens.filter((t) => !t).length,
      statuses: arrivals.map((a) => a.status),
      tokenIds: arrivals.map((a) => a.tokenId),
      // A benign extra POST presents the successor of an earlier presented token.
      benignExtraPost: diag.events.length > 1 && diag.events[1]!.successorOfPresented,
      rowsDeleted: diag.events.filter((e) => !e.known).length,
    };
  });
}

for (const [label, origin, count] of [
  ['secure-2tab', 'http://127.0.0.1:4175', 2],
  ['secure-3tab', 'http://127.0.0.1:4175', 3],
  ['lan-2tab', 'http://lan.ts6.test:4175', 2],
  ['lan-3tab', 'http://lan.ts6.test:4175', 3],
] as const) {
  test(`coord: ${label} (15 trials)`, async ({ browser, request }) => {
    test.setTimeout(900_000);
    const trials: Trial[] = [];
    for (let t = 0; t < 15; t++) trials.push(await runTrial(browser, request, origin, count, {}));
    console.log(`COORD_${label}=` + JSON.stringify(summarize(trials)));
    expect(true).toBe(true);
  });
}

for (const delay of [300]) {
  test(`coord: lan-3tab delayed-${delay}ms (15 trials)`, async ({ browser, request }) => {
    test.setTimeout(900_000);
    const trials: Trial[] = [];
    for (let t = 0; t < 15; t++) {
      trials.push(await runTrial(browser, request, 'http://lan.ts6.test:4175', 3, { delayBcMs: delay }));
    }
    console.log(`COORD_lan-3tab-delayed${delay}=` + JSON.stringify(summarize(trials)));
    expect(true).toBe(true);
  });
}

function summarize(trials: Trial[]) {
  const n = trials.length;
  const count = (pred: (t: Trial) => boolean) => trials.filter(pred).length;
  const rates: Record<string, string> = {};
  for (const key of ['sameTokenPresented', 'overlapped', 'revoked', 'sessionUsable'] as const) {
    const c = count((t) => Boolean(t[key]));
    rates[key] = `${c}/${n}`;
  }
  return {
    trials: n,
    ...rates,
    postsDist: trials.reduce((a, t) => { const k = String(t.posts); a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>),
    exactOnePost: count((t) => t.posts === 1),
    replayRevokes: count((t) => Boolean(t.replayRevokes)),
    benignExtraPost: count((t) => Boolean(t.benignExtraPost)),
    rowsDeletedTrials: count((t) => (t.rowsDeleted as number) > 0),
  };
}
