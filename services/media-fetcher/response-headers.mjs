/**
 * Client-facing response headers for the media-fetcher proxy.
 * Forward only content-type plus a validated Location on redirect statuses.
 * The proxy never follows redirects — ffmpeg issues the next hop, which is
 * re-checked (auth, host/port, DNS pin) like any other absolute-form request.
 */
import { isIP } from 'node:net';

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Match radio URL length bound used by the fetcher submit path. */
export const MAX_LOCATION_LENGTH = 2048;

/** DNS hostname (ASCII / punycode). Rejects empty labels and control chars. */
const DNS_HOSTNAME =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;

/**
 * Rebuild an absolute http(s) Location from validated components only.
 * Scheme is chosen from literal constants so the string is not a passthrough
 * of the upstream header bytes (normalization + clearer static analysis).
 */
function rebuildAbsoluteLocation(url) {
  let scheme;
  if (url.protocol === 'http:') scheme = 'http';
  else if (url.protocol === 'https:') scheme = 'https';
  else return null;

  const hostname = url.hostname;
  if (!hostname) return null;
  const ipKind = isIP(hostname);
  if (ipKind === 0 && !DNS_HOSTNAME.test(hostname)) return null;

  const host = ipKind === 6 ? `[${hostname}]` : hostname;
  const port = url.port ? `:${url.port}` : '';
  const pathname = url.pathname || '/';
  const search = url.search || '';
  // Hash is unused by media clients for stream hops; omit to avoid confusing parsers.
  const rebuilt = `${scheme}://${host}${port}${pathname}${search}`;
  if (rebuilt.length > MAX_LOCATION_LENGTH) return null;
  return rebuilt;
}

/** Relative Location: printable ASCII path/query/fragment only (no scheme). */
function sanitizeRelativeLocation(value) {
  if (value.startsWith('//')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
    out += value[i];
  }
  return out || null;
}

/**
 * Return a safe Location value, or null to omit the header.
 * Absolute http(s) only (no credentials). Relative refs without a scheme.
 * Protocol-relative (`//host/...`) is refused — it can become HTTPS and
 * would need CONNECT that HTTP-start jobs intentionally lack.
 */
export function sanitizeRedirectLocation(raw) {
  if (raw == null) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_LOCATION_LENGTH) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (value.startsWith('//')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    return rebuildAbsoluteLocation(url);
  }
  return sanitizeRelativeLocation(value);
}

/**
 * Headers returned to the ffmpeg/client hop.
 * Never copies hop-by-hop or upstream-sensitive fields (Set-Cookie, Server, …).
 * Location is only set after sanitizeRedirectLocation rebuilds/validates it.
 */
export function buildClientResponseHeaders(upRes) {
  const headers = { connection: 'close' };
  const contentType = upRes?.headers?.['content-type'];
  if (typeof contentType === 'string' && contentType) {
    headers['content-type'] = contentType;
  } else if (Array.isArray(contentType) && typeof contentType[0] === 'string' && contentType[0]) {
    headers['content-type'] = contentType[0];
  }
  const status = Number(upRes?.statusCode) || 0;
  if (REDIRECT_STATUSES.has(status)) {
    const location = sanitizeRedirectLocation(upRes?.headers?.location);
    if (location) headers.location = location;
  }
  return headers;
}
