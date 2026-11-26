import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  cookieMutationAllowed,
  cookieOriginAllowed,
  csrfCookieValue,
  csrfMatches,
  parseCookies,
  resolveCsrfToken,
  sessionCredentialFromRequest,
} from './cookies.js';

function req( partial: {
  cookie?: string;
  authorization?: string;
  origin?: string;
  referer?: string;
  host?: string;
  site?: string;
  csrf?: string;
  method?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (partial.cookie) headers.cookie = partial.cookie;
  if (partial.authorization) headers.authorization = partial.authorization;
  if (partial.origin) headers.origin = partial.origin;
  if (partial.referer) headers.referer = partial.referer;
  if (partial.host) headers.host = partial.host;
  if (partial.site) headers['sec-fetch-site'] = partial.site;
  if (partial.csrf) headers['x-csrf-token'] = partial.csrf;
  return {
    method: partial.method ?? 'GET',
    get: (name: string) => headers[name.toLowerCase()],
  } as Request;
}

describe('listener remote cookies', () => {
  it('parses cookies and prefers Bearer over the session cookie', () => {
    assert.deepEqual(parseCookies(`${SESSION_COOKIE}=abc; ${CSRF_COOKIE}=def`), {
      [SESSION_COOKIE]: 'abc',
      [CSRF_COOKIE]: 'def',
    });
    const bearer = 'b'.repeat(43);
    const cookie = 'c'.repeat(43);
    assert.equal(sessionCredentialFromRequest(req({
      authorization: `Bearer ${bearer}`,
      cookie: `${SESSION_COOKIE}=${cookie}`,
    })), bearer);
    assert.equal(sessionCredentialFromRequest(req({
      cookie: `${SESSION_COOKIE}=${cookie}`,
    })), cookie);
  });

  it('allows Bearer mutations without CSRF and rejects cookie mutations without CSRF or Origin', () => {
    const session = 's'.repeat(43);
    const csrf = 'k'.repeat(43);
    assert.equal(cookieMutationAllowed(req({
      authorization: `Bearer ${session}`,
      method: 'POST',
    })), true);
    assert.equal(cookieMutationAllowed(req({
      cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`,
      origin: 'http://localhost:5173',
      csrf,
      method: 'POST',
    })), true);
    assert.equal(cookieMutationAllowed(req({
      cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`,
      origin: 'http://localhost:5173',
      method: 'POST',
    })), false);
    assert.equal(cookieMutationAllowed(req({
      cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`,
      origin: 'https://evil.example',
      csrf,
      method: 'POST',
    })), false);
    assert.equal(csrfMatches(req({
      cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`,
      csrf: 'x'.repeat(43),
    })), false);
  });

  it('accepts same-origin Host when Origin is omitted and rejects cross-site', () => {
    const session = 's'.repeat(43);
    assert.equal(cookieOriginAllowed(req({
      cookie: `${SESSION_COOKIE}=${session}`,
      host: 'localhost:5173',
    })), true);
    assert.equal(cookieOriginAllowed(req({
      cookie: `${SESSION_COOKIE}=${session}`,
      host: 'localhost:5173',
      site: 'cross-site',
    })), false);
    assert.equal(cookieOriginAllowed(req({
      cookie: `${SESSION_COOKIE}=${session}`,
      referer: 'http://localhost:5173/remote',
    })), true);
  });

  it('reuses a valid CSRF cookie and mints only when missing or malformed', () => {
    const csrf = 'k'.repeat(43);
    assert.equal(csrfCookieValue(req({ cookie: `${CSRF_COOKIE}=${csrf}` })), csrf);
    assert.equal(csrfCookieValue(req({ cookie: `${CSRF_COOKIE}=short` })), undefined);
    assert.equal(resolveCsrfToken(req({ cookie: `${CSRF_COOKIE}=${csrf}` })), csrf);
    const minted = resolveCsrfToken(req({}));
    assert.match(minted, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(minted, csrf);
  });
});
