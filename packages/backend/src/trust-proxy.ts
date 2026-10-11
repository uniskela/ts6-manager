import type { NextFunction, Request, Response } from 'express';

/** Express `trust proxy` value this backend uses: `false` (trust nothing) or an explicit list. */
export type TrustProxySetting = false | string[];

const NONE_WORDS = new Set(['false', 'none', 'off', 'no']);

/**
 * Parse TRUST_PROXY. Unset/blank and an explicit none-word both mean "trust nothing".
 * `true` and numeric hop counts are rejected on purpose: they trust whatever sits at
 * that position and let a direct client choose its own rate-limit key.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const tokens = (raw ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (tokens.length === 0) return false;
  const lower = tokens.map(token => token.toLowerCase());
  if (lower.every(token => NONE_WORDS.has(token))) return false;
  if (lower.some(token => NONE_WORDS.has(token))) {
    throw new Error('TRUST_PROXY mixes a "none" value (false/none/off/no) with proxy addresses; use one or the other.');
  }
  for (const token of tokens) {
    if (token.toLowerCase() === 'true' || /^\d+$/.test(token)) {
      throw new Error(
        `TRUST_PROXY=${token} is not supported: boolean and hop-count values trust any client at that position. ` +
        'Use proxy IPs/CIDRs or loopback, linklocal, uniquelocal, or "none".',
      );
    }
  }
  return tokens;
}

export function describeTrustProxy(setting: TrustProxySetting): string {
  return setting === false ? 'none (forwarded headers ignored)' : setting.join(', ');
}

/** Logs once when X-Forwarded-For arrives while no proxy is trusted. Never logs the header value. */
export function forwardedHeaderWarning(
  setting: TrustProxySetting,
  warn: (message: string) => void = message => console.warn(message),
) {
  let warned = false;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!warned && setting === false && req.headers['x-forwarded-for'] !== undefined) {
      warned = true;
      warn(
        '[WARN] Received X-Forwarded-For but TRUST_PROXY trusts no proxy, so the header is ignored. ' +
        'Behind a reverse proxy, rate limits then treat every user as one client; set TRUST_PROXY to the proxy address/CIDR.',
      );
    }
    next();
  };
}
