import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * `private-peer` trusts exactly one hop, and only when the connecting peer has a private
 * address. It is the split backend image default: the bundled frontend proxy reaches the
 * backend from a private compose address that is not known in advance.
 */
export const PRIVATE_PEER = 'private-peer';

/** Parsed TRUST_PROXY: `false` (trust nothing), `private-peer`, or an explicit list. */
export type TrustProxySetting = false | typeof PRIVATE_PEER | string[];

/** What Express receives for `trust proxy`. */
export type ExpressTrustProxy = false | string[] | ((address: string, hop: number) => boolean);

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
  if (lower.includes(PRIVATE_PEER)) {
    if (lower.some(token => token !== PRIVATE_PEER)) {
      throw new Error(
        `TRUST_PROXY mixes "${PRIVATE_PEER}" with proxy addresses; list every proxy address or range explicitly instead.`,
      );
    }
    return PRIVATE_PEER;
  }
  for (const token of tokens) {
    if (token.toLowerCase() === 'true' || /^\d+$/.test(token)) {
      throw new Error(
        `TRUST_PROXY=${token} is not supported: boolean and hop-count values trust any client at that position. ` +
        `Use proxy IPs/CIDRs or loopback, linklocal, uniquelocal, ${PRIVATE_PEER}, or "none".`,
      );
    }
  }
  return tokens;
}

/** Express compiles named ranges with proxy-addr; reuse that instead of our own CIDR checks. */
function compileRange(range: string): (address: string, hop: number) => boolean {
  const probe = express();
  probe.set('trust proxy', [range]);
  return probe.get('trust proxy fn') as (address: string, hop: number) => boolean;
}

/**
 * The value for `app.set('trust proxy', …)`. Express asks about the socket peer as hop 0
 * and then about each X-Forwarded-For entry from the right; `req.ip` is the first address
 * that is not trusted. For `private-peer` only hop 0 can be trusted, so `req.ip` is the
 * address the proxy itself observed and nothing a client wrote further left is believed.
 */
export function expressTrustProxy(setting: TrustProxySetting): ExpressTrustProxy {
  if (setting !== PRIVATE_PEER) return setting;
  const isPrivate = compileRange('uniquelocal');
  return (address, hop) => hop === 0 && isPrivate(address, 0);
}

export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) return 'none (forwarded headers ignored)';
  if (setting === PRIVATE_PEER) return `${PRIVATE_PEER} (one hop, only when the connecting peer has a private address)`;
  return setting.join(', ');
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
