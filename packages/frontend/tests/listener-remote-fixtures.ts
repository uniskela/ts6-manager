import { expect, type Page, type Route } from '@playwright/test';

/** Opaque HttpOnly session secret — never returned in JSON. */
export const REMOTE_SESSION = 's'.repeat(43);
/** Double-submit CSRF token returned in JSON and readable cookie. */
export const REMOTE_CSRF = 'c'.repeat(43);
export const REMOTE_TOKEN = 't'.repeat(43);

export function remotePath(path: string): RegExp {
  return new RegExp(`/api/listener-remote${path}$`);
}

export async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Cookie + JSON contract for POST /exchange (no session field in body). */
export async function fulfillExchange(
  page: Page,
  route: Route,
  options: { session?: string; csrf?: string; botId?: number; remember?: boolean; expiresAt?: string } = {},
) {
  const session = options.session ?? REMOTE_SESSION;
  const csrf = options.csrf ?? REMOTE_CSRF;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  const botId = options.botId ?? 12;
  await page.context().addCookies([
    {
      name: 'ts6_lr_session',
      value: session,
      domain: '127.0.0.1',
      path: '/api/listener-remote',
      httpOnly: true,
      sameSite: 'Strict',
    },
    {
      name: 'ts6_lr_csrf',
      value: csrf,
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Strict',
    },
  ]);
  await fulfillJson(route, {
    expiresAt,
    botId,
    csrfToken: csrf,
    remember: options.remember === true,
  });
}

/** Cookie-authenticated remote: exchange sets cookies; mutations require CSRF, not Bearer. */
export async function installRemoteAuthRoutes(
  page: Page,
  options: {
    session?: string;
    csrf?: string;
    botId?: number;
    remember?: boolean;
    onExchange?: (route: Route) => Promise<void> | void;
  } = {},
) {
  const session = options.session ?? REMOTE_SESSION;
  const csrf = options.csrf ?? REMOTE_CSRF;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const botId = options.botId ?? 12;

  await page.route(remotePath('/exchange'), async (route) => {
    if (options.onExchange) await options.onExchange(route);
    expect(route.request().headers().authorization).toBeUndefined();
    await fulfillExchange(page, route, { session, csrf, botId, remember: options.remember, expiresAt });
  });

  await page.route(remotePath('/session'), async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      expect(route.request().headers().authorization).toBeUndefined();
      await fulfillJson(route, { expiresAt, botId, csrfToken: csrf });
      return;
    }
    if (method === 'DELETE') {
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      await page.context().clearCookies();
      await fulfillJson(route, { ok: true });
      return;
    }
    await fulfillJson(route, { error: 'Method not allowed', code: 'invalid_request' }, 400);
  });
}

export function expectCookieAuth(route: Route, csrf = REMOTE_CSRF) {
  const headers = route.request().headers();
  expect(headers.authorization).toBeUndefined();
  const method = route.request().method().toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    expect(headers['x-csrf-token']).toBe(csrf);
  }
}
