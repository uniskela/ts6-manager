import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import tls from 'tls';
import { RADIO_EGRESS_PORTS, mediaEgressRefusal } from '../egress/egress-policy.js';

/**
 * Fetch the current StreamTitle from an ICY/Shoutcast/Icecast radio stream.
 *
 * Uses a raw TCP socket to handle both standard HTTP and the non-standard
 * ICY protocol (which responds with "ICY 200 OK" instead of "HTTP/1.x 200 OK").
 * Node.js http module cannot parse ICY responses.
 *
 * Each hop is resolved and pinned by the media-egress address policy before
 * connect. Redirects are not followed until the next hop passes the same check.
 */

export type IcyConnectDeps = {
  resolve?: (host: string) => Promise<string[]>;
  connect?: (opts: { host: string; port: number; tls: boolean; servername: string }) => Promise<net.Socket>;
};

export async function fetchIcyMetadata(
  streamUrl: string,
  timeoutMs = 10000,
  deps: IcyConnectDeps = {},
): Promise<string | null> {
  let currentUrl = streamUrl;
  const maxRedirects = 5;

  for (let i = 0; i <= maxRedirects; i++) {
    const result = await fetchIcySingle(currentUrl, timeoutMs, deps);
    if (result.redirect) {
      currentUrl = result.redirect;
      continue;
    }
    return result.title;
  }
  return null;
}

interface IcyResult {
  title: string | null;
  redirect?: string;
}

async function defaultResolve(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 4_000, tries: 2 });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  return [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
}

function defaultConnect(opts: { host: string; port: number; tls: boolean; servername: string }): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = opts.tls
      ? tls.connect({
        host: opts.host,
        port: opts.port,
        servername: opts.servername,
        rejectUnauthorized: true,
      }, () => resolve(socket))
      : net.connect({ host: opts.host, port: opts.port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

async function approvedAddresses(host: string, resolve: (host: string) => Promise<string[]>): Promise<string[]> {
  const literal = host.replace(/^\[|\]$/g, '');
  const answers = net.isIP(literal) ? [literal] : await resolve(literal);
  return answers.filter((address) => mediaEgressRefusal(address) == null);
}

function parseRadioUrl(streamUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(streamUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!RADIO_EGRESS_PORTS.has(port)) return null;
  return url;
}

async function openCheckedSocket(streamUrl: string, deps: IcyConnectDeps): Promise<{ socket: net.Socket; url: URL } | null> {
  const url = parseRadioUrl(streamUrl);
  if (!url) return null;
  const approved = await approvedAddresses(url.hostname, deps.resolve ?? defaultResolve);
  if (!approved.length) return null;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  const socket = await (deps.connect ?? defaultConnect)({
    host: approved[0],
    port,
    tls: url.protocol === 'https:',
    servername: url.hostname,
  });
  return { socket, url };
}

function fetchIcySingle(streamUrl: string, timeoutMs: number, deps: IcyConnectDeps): Promise<IcyResult> {
  return new Promise((resolve) => {
    let resolved = false;
    let socket: net.Socket | undefined;
    const timer = setTimeout(() => done({ title: null }), timeoutMs);

    void openCheckedSocket(streamUrl, deps).then((opened) => {
      if (resolved) {
        opened?.socket.destroy();
        return;
      }
      if (!opened) {
        done({ title: null });
        return;
      }
      socket = opened.socket;
      const path = opened.url.pathname + opened.url.search;
      const request =
        `GET ${path || '/'} HTTP/1.0\r\n` +
        `Host: ${opened.url.host}\r\n` +
        `User-Agent: TS6-MusicBot/1.0\r\n` +
        `Icy-MetaData: 1\r\n` +
        `Connection: close\r\n` +
        `\r\n`;
      socket.write(request);
      attach(socket, opened.url);
    }).catch(() => done({ title: null }));

    function attach(live: net.Socket, current: URL) {
      let buffer = Buffer.alloc(0);
      let headersParsed = false;
      let metaInt = 0;
      let headersEndOffset = 0;

      live.on('data', (chunk: Buffer) => {
        if (resolved) return;
        buffer = Buffer.concat([buffer, chunk]);

        if (!headersParsed) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;

          const headersRaw = buffer.subarray(0, headerEnd).toString('latin1');
          const headersLower = headersRaw.toLowerCase();
          headersParsed = true;
          headersEndOffset = headerEnd + 4;

          const statusLine = headersRaw.split('\r\n')[0];
          if (/\b30[12378]\b/.test(statusLine)) {
            const locMatch = headersRaw.match(/[Ll]ocation:\s*(.+)/);
            if (locMatch) {
              try {
                return done({ title: null, redirect: new URL(locMatch[1].trim(), current).href });
              } catch {
                return done({ title: null });
              }
            }
          }

          const metaIntMatch = headersLower.match(/icy-metaint\s*:\s*(\d+)/);
          if (!metaIntMatch) return done({ title: null });
          metaInt = parseInt(metaIntMatch[1]);
          if (!metaInt || metaInt <= 0) return done({ title: null });
        }

        const bodyStart = headersEndOffset;
        const bodyLen = buffer.length - bodyStart;
        if (bodyLen <= metaInt) return;
        const metaLen = buffer[bodyStart + metaInt] * 16;
        if (metaLen === 0) return done({ title: null });
        if (bodyLen < metaInt + 1 + metaLen) return;
        const metaStr = buffer.subarray(bodyStart + metaInt + 1, bodyStart + metaInt + 1 + metaLen).toString('utf-8');
        const match = metaStr.match(/StreamTitle='([^']*?)'/);
        done({ title: match ? match[1].trim() || null : null });
      });

      live.on('error', () => done({ title: null }));
      live.on('end', () => done({ title: null }));
    }

    function done(result: IcyResult) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already closed */ }
      resolve(result);
    }
  });
}
