/**
 * HttpOnly session cookie + readable CSRF cookie for Listener Remote.
 * Process-local sessions: backend restart clears remembered browsers (documented).
 */
import type { Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';

export const SESSION_COOKIE = 'ts6_lr_session';
export const CSRF_COOKIE = 'ts6_lr_csrf';
/** Cookie Path — host-only (no Domain attribute). */
const COOKIE_PATH = '/api/listener-remote';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name || !value) continue;
    try { out[name] = decodeURIComponent(value); } catch { /* ignore malformed */ }
  }
  return out;
}

export function sessionCredentialFromRequest(req: Request): string | undefined {
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') ?? '')?.[1];
  if (bearer) return bearer;
  const cookie = parseCookies(req.get('Cookie'))[SESSION_COOKIE];
  return typeof cookie === 'string' && /^[A-Za-z0-9_-]{43}$/.test(cookie) ? cookie : undefined;
}

function wantsSecureCookie(req: Request): boolean {
  if (req.secure || req.get('x-forwarded-proto') === 'https') return true;
  // Production always marks Secure so plaintext hosts cannot keep a session cookie.
  return process.env.NODE_ENV === 'production';
}

function cookieFlags(req: Request, maxAgeSec: number, httpOnly: boolean): string {
  const parts = [
    `Path=${COOKIE_PATH}`,
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (wantsSecureCookie(req)) parts.push('Secure');
  return parts.join('; ');
}

export function setListenerRemoteCookies(
  req: Request,
  res: Response,
  session: string,
  csrfToken: string,
  expiresAtMs: number,
): void {
  const maxAgeSec = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));
  const existing = res.getHeader('Set-Cookie');
  const next = [
    `${SESSION_COOKIE}=${encodeURIComponent(session)}; ${cookieFlags(req, maxAgeSec, true)}`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; ${cookieFlags(req, maxAgeSec, false)}`,
  ];
  if (!existing) res.setHeader('Set-Cookie', next);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing.map(String), ...next]);
  else res.setHeader('Set-Cookie', [String(existing), ...next]);
}

export function clearListenerRemoteCookies(req: Request, res: Response): void {
  const clear = (name: string, httpOnly: boolean) =>
    `${name}=; Path=${COOKIE_PATH}; SameSite=Strict; Max-Age=0${httpOnly ? '; HttpOnly' : ''}${wantsSecureCookie(req) ? '; Secure' : ''}`;
  const next = [clear(SESSION_COOKIE, true), clear(CSRF_COOKIE, false)];
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', next);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing.map(String), ...next]);
  else res.setHeader('Set-Cookie', [String(existing), ...next]);
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Allowed browser origins for cookie-authenticated remote calls. */
export function allowedRemoteOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of [config.frontendUrl, process.env.PUBLIC_URL]) {
    if (!raw) continue;
    try { origins.add(new URL(raw).origin); } catch { /* skip */ }
  }
  return origins;
}

function originOf(urlOrOrigin: string | undefined): string | null {
  if (!urlOrOrigin) return null;
  try {
    if (urlOrOrigin.startsWith('http://') || urlOrOrigin.startsWith('https://')) {
      return new URL(urlOrOrigin).origin;
    }
  } catch { return null; }
  return null;
}

/**
 * Cookie sessions require a matching Origin (preferred) or Referer.
 * Bearer-only clients skip this (tests / non-browser).
 */
export function cookieOriginAllowed(req: Request): boolean {
  const cookies = parseCookies(req.get('Cookie'));
  if (!cookies[SESSION_COOKIE]) return true;
  const allowed = allowedRemoteOrigins();
  if (allowed.size === 0) return false;
  const origin = originOf(req.get('Origin') ?? undefined)
    ?? originOf(req.get('Referer') ?? undefined);
  if (origin != null) return allowed.has(origin);
  // Same-origin fetch may omit Origin; reject explicit cross-site, else match Host.
  if (req.get('Sec-Fetch-Site') === 'cross-site') return false;
  const host = req.get('Host');
  if (!host) return false;
  for (const allowedOrigin of allowed) {
    try {
      if (new URL(allowedOrigin).host === host) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export function csrfTokenFromRequest(req: Request): string | undefined {
  const header = req.get('x-csrf-token')?.trim();
  if (header && /^[A-Za-z0-9_-]{43}$/.test(header)) return header;
  return undefined;
}

export function csrfMatches(req: Request): boolean {
  const cookies = parseCookies(req.get('Cookie'));
  if (!cookies[SESSION_COOKIE]) return true; // Bearer path
  const expected = cookies[CSRF_COOKIE];
  const provided = csrfTokenFromRequest(req);
  if (!expected || !provided || expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

/** Mutations with a session cookie must present CSRF + Origin. */
export function cookieMutationAllowed(req: Request): boolean {
  const cookies = parseCookies(req.get('Cookie'));
  if (!cookies[SESSION_COOKIE]) return true;
  return cookieOriginAllowed(req) && csrfMatches(req);
}

export function fingerprintCookiePresence(req: Request): string {
  const cookies = parseCookies(req.get('Cookie'));
  const has = cookies[SESSION_COOKIE] ? '1' : '0';
  return createHash('sha256').update(`lr-cookie:${has}`).digest('hex').slice(0, 12);
}
