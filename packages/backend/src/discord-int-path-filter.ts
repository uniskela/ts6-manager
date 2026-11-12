/**
 * Localhost-only path filter for Stage B HTTPS tunnels.
 * Forwards only POST /api/discord/interactions to the isolated backend.
 * All other paths (health, auth, admin, websocket) are refused.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

export const DISCORD_INTERACTIONS_PATH = '/api/discord/interactions';
export const PATH_FILTER_BODY_LIMIT_BYTES = 256 * 1024;
export const PATH_FILTER_REQUEST_TIMEOUT_MS = 15_000;

export type PathFilterProxyOptions = {
  /** Upstream isolated backend, e.g. http://127.0.0.1:3011 */
  upstreamOrigin: string;
  /** Local bind host for the filter (default 127.0.0.1). */
  listenHost?: string;
  listenPort: number;
  bodyLimitBytes?: number;
  requestTimeoutMs?: number;
};

/**
 * Exact-path allowlist after URL parsing (decoded pathname, no query).
 * Rejects trailing slashes, dot-segments that normalize away, and non-POST.
 */
export function isAllowedDiscordInteractionsRequest(
  method: string,
  pathname: string,
): boolean {
  const m = method.toUpperCase();
  if (pathname !== DISCORD_INTERACTIONS_PATH) return false;
  // Discord Interactions Endpoint uses POST (PING + commands).
  return m === 'POST';
}

/** Normalize and refuse anything that is not exactly the interactions path. */
export function normalizeFilterPathname(rawUrl: string, hostHeader: string): string | null {
  try {
    const url = new URL(rawUrl || '/', `http://${hostHeader || '127.0.0.1'}`);
    // Collapse dot segments via URL; still require exact match (no trailing slash).
    if (url.pathname !== DISCORD_INTERACTIONS_PATH) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit = PATH_FILTER_BODY_LIMIT_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const PRESERVED_SIGNATURE_HEADERS = [
  'x-signature-ed25519',
  'x-signature-timestamp',
  'content-type',
] as const;

/**
 * Create a filtering reverse proxy. Callers must listen(); this does not bind.
 * Forwards the raw body bytes and Discord signature headers unchanged.
 */
export function createDiscordInteractionsPathFilter(
  opts: PathFilterProxyOptions,
): http.Server {
  const upstream = new URL(opts.upstreamOrigin);
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error('upstreamOrigin must be http(s)');
  }
  const bodyLimit = opts.bodyLimitBytes ?? PATH_FILTER_BODY_LIMIT_BYTES;
  const timeoutMs = opts.requestTimeoutMs ?? PATH_FILTER_REQUEST_TIMEOUT_MS;

  return http.createServer((req, res) => {
    const host = req.headers.host || '127.0.0.1';
    const method = req.method || 'GET';
    const pathname = normalizeFilterPathname(req.url || '/', host);

    if (!pathname || !isAllowedDiscordInteractionsRequest(method, pathname)) {
      sendJson(res, 404, { error: 'Not exposed by Discord interactions path filter.' });
      req.resume();
      return;
    }

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        sendJson(res, 504, { error: 'Path filter request timed out.' });
      }
      req.destroy();
    }, timeoutMs);
    timer.unref?.();

    void (async () => {
      try {
        const body = await readBody(req, bodyLimit);
        // Rebuild upstream headers from the original request; keep signature headers verbatim.
        const headers: http.OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (value == null) continue;
          const lower = key.toLowerCase();
          if (lower === 'host' || lower === 'connection' || lower === 'transfer-encoding') continue;
          headers[key] = value;
        }
        for (const name of PRESERVED_SIGNATURE_HEADERS) {
          const v = req.headers[name];
          if (typeof v === 'string') headers[name] = v;
        }
        headers.host = upstream.host;
        headers['content-length'] = body.length;

        await new Promise<void>((resolve, reject) => {
          const upstreamReq = http.request(
            {
              protocol: upstream.protocol,
              hostname: upstream.hostname,
              port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
              path: DISCORD_INTERACTIONS_PATH,
              method: 'POST',
              headers,
              timeout: timeoutMs,
            },
            (upstreamRes) => {
              const outHeaders = { ...upstreamRes.headers };
              delete outHeaders['transfer-encoding'];
              const status = upstreamRes.statusCode || 502;
              const hasSig = typeof req.headers['x-signature-ed25519'] === 'string';
              const hasTs = typeof req.headers['x-signature-timestamp'] === 'string';
              // Stage C2 observation only — no body/token material.
              console.log(
                `[discord-int-path-filter] ${method} ${pathname} status=${status} bytes=${body.length} sig=${hasSig} ts=${hasTs}`,
              );
              res.writeHead(status, outHeaders);
              upstreamRes.pipe(res);
              upstreamRes.on('end', () => resolve());
              upstreamRes.on('error', reject);
            },
          );
          upstreamReq.on('timeout', () => {
            upstreamReq.destroy(new Error('upstream_timeout'));
          });
          upstreamReq.on('error', reject);
          upstreamReq.end(body);
        });
      } catch (err) {
        if (!res.headersSent) {
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'body_too_large') {
            sendJson(res, 413, { error: 'Request body too large.' });
          } else if (msg === 'upstream_timeout') {
            sendJson(res, 504, { error: 'Upstream timed out.' });
          } else {
            sendJson(res, 502, { error: 'Upstream isolated backend unreachable.' });
          }
        } else {
          res.destroy();
        }
      } finally {
        clearTimeout(timer);
      }
    })();
  });
}

export function listenDiscordInteractionsPathFilter(
  opts: PathFilterProxyOptions,
): Promise<{ server: http.Server; url: string }> {
  const listenHost = opts.listenHost ?? '127.0.0.1';
  const server = createDiscordInteractionsPathFilter(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.listenPort, listenHost, () => {
      resolve({
        server,
        url: `http://${listenHost}:${opts.listenPort}`,
      });
    });
  });
}
