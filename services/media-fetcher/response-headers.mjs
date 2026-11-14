/**
 * Client-facing response headers for the media-fetcher proxy.
 * Forward only content-type plus a validated Location on redirect statuses.
 * The proxy never follows redirects — ffmpeg issues the next hop, which is
 * re-checked (auth, host/port, DNS pin) like any other absolute-form request.
 */

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Match radio URL length bound used by the fetcher submit path. */
export const MAX_LOCATION_LENGTH = 2048;

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
    return url.href;
  }
  // Relative reference (path-absolute, path-relative, query/fragment).
  return value;
}

/** Headers returned to the ffmpeg/client hop. Never copies hop-by-hop fields. */
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
