import { createHash, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { MEDIA_EGRESS_PORTS, mediaEgressRefusal } from './egress-policy.js';

/**
 * Loopback forward proxy that every media download goes through (yt-dlp, and
 * ffmpeg reading a URL yt-dlp resolved). It is the enforcement point for where
 * those processes may connect:
 *
 * - each job gets its own random token, sent as proxy credentials; requests
 *   without a live token are refused, so other local processes cannot use it;
 * - the proxy resolves the host itself, drops every answer the policy refuses
 *   and connects to an approved address, so a later DNS answer cannot swap it;
 * - it never follows redirects: the client does, through the proxy, so each
 *   hop is checked again;
 * - only CONNECT (https) and absolute-form http requests, to ports 80 and 443.
 *
 * It only governs traffic a client sends through it. See docs/public/security.md
 * for what that leaves to the deployment.
 */

export interface UpstreamProxy {
  host: string;
  port: number;
  /** Value for Proxy-Authorization, when the upstream needs credentials. */
  authorization?: string;
}

export interface MediaEgressProxyOptions {
  /** Outbound proxy the approved connections are chained through (by IP address). */
  upstream?: UpstreamProxy;
  /** DNS lookup; tests replace it. */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only: addresses to allow despite the policy (local test servers). */
  permitAddress?: (address: string) => boolean;
  /** Tests only: ports to allow besides 80 and 443. */
  permitPort?: (port: number) => boolean;
  log?: (message: string) => void;
  limits?: Partial<MediaEgressLimits>;
}

export interface MediaEgressLimits {
  /** Open connections one job may hold at once. */
  concurrentPerJob: number;
  /** Connections one job may open over its lifetime. */
  totalPerJob: number;
  /** A connection with no traffic for this long is closed. */
  idleMs: number;
  /** Time allowed to connect to the destination (or upstream proxy). */
  connectMs: number;
  /** Refusals logged per job; later ones are counted only. */
  logsPerJob: number;
  /** Open connections across all jobs. */
  concurrentTotal: number;
}

const DEFAULT_LIMITS: MediaEgressLimits = {
  concurrentPerJob: 32,
  totalPerJob: 5_000,
  idleMs: 300_000,
  connectMs: 10_000,
  logsPerJob: 5,
  concurrentTotal: 256,
};

/** One job's access to the proxy. */
export interface EgressJob {
  /** Proxy URL with this job's credentials, for yt-dlp `--proxy` and ffmpeg `http_proxy`. */
  readonly proxyUrl: string;
  /** Remove this job's credentials from text before it is logged or shown. */
  redact(text: string): string;
  /** Revoke the token and close the job's connections. Safe to call twice. */
  release(): void;
}

interface JobState {
  open: Set<net.Socket>;
  /** Connections being set up or open; reserved before any await. */
  active: number;
  opened: number;
  /** Aborted when the job is revoked, cancelling connections still being set up. */
  abort: AbortController;
  logged: number;
  expires: number;
  revoked: boolean;
  timer: NodeJS.Timeout;
}

/** Thrown when a refused request is answered; carries the HTTP status. */
class Refused extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

const HOP_HEADERS = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Resolve with c-ares rather than the system lookup, which runs on the libuv
 * threadpool and has no timeout: slow names must not hold up file and crypto
 * work elsewhere in the backend. IPv4 answers come first.
 */
async function systemResolve(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 4_000, tries: 2 });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const answers = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
  if (answers.length === 0) throw new Error('no answers');
  return answers;
}

/** Host name or address safe to print: no credentials, no paths, bounded length. */
function printableHost(host: string): string {
  return host.replace(/[^a-zA-Z0-9.:\-[\]]/g, '?').slice(0, 120);
}

export class MediaEgressProxy {
  private server?: http.Server;
  private listening?: Promise<number>;
  private readonly jobs = new Map<string, JobState>();
  /** Connections being set up or open, across all jobs. */
  private active = 0;
  private readonly limits: MediaEgressLimits;
  private readonly resolve: (host: string) => Promise<string[]>;
  private readonly log: (message: string) => void;

  constructor(private readonly options: MediaEgressProxyOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.resolve = options.resolve ?? systemResolve;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** Start listening on an ephemeral loopback port; resolves to that port. */
  start(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer();
      server.headersTimeout = 30_000;
      server.requestTimeout = 0; // downloads are long; idle sockets time out instead
      server.on('request', (req, res) => { void this.forward(req, res); });
      // The 'connect' socket is always a net.Socket for a TCP server.
      server.on('connect', (req, socket, head) => { void this.tunnel(req, socket as net.Socket, head); });
      server.on('clientError', (_err, socket) => socket.destroy());
      server.once('error', (err) => {
        // Let the next job try again rather than failing every download until a restart.
        this.listening = undefined;
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        server.removeAllListeners('error');
        server.on('error', (err) => this.log(`[MediaEgress] Proxy error: ${err.message}`));
        // Open connections keep the process running; an idle proxy does not.
        server.unref();
        this.server = server;
        resolve((server.address() as net.AddressInfo).port);
      });
    });
    return this.listening;
  }

  /** Issue a token for one job. Fails when the proxy cannot listen (fail closed). */
  async issue(ttlMs: number): Promise<EgressJob> {
    const port = await this.start();
    const token = randomBytes(32).toString('hex');
    const key = tokenKey(token);
    const state: JobState = {
      open: new Set(), active: 0, opened: 0, abort: new AbortController(), logged: 0, expires: Date.now() + ttlMs, revoked: false,
      timer: setTimeout(() => this.revoke(key), ttlMs),
    };
    state.timer.unref();
    this.jobs.set(key, state);
    return {
      proxyUrl: `http://job:${token}@127.0.0.1:${port}`,
      redact: (text) => text.split(token).join('***'),
      release: () => this.revoke(key),
    };
  }

  /** Jobs that currently hold a token (for tests and diagnostics). */
  get activeJobs(): number {
    return this.jobs.size;
  }

  async close(): Promise<void> {
    for (const key of [...this.jobs.keys()]) this.revoke(key);
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private revoke(key: string): void {
    const state = this.jobs.get(key);
    if (!state) return;
    this.jobs.delete(key);
    state.revoked = true;
    state.abort.abort();
    clearTimeout(state.timer);
    for (const stream of state.open) stream.destroy();
    state.open.clear();
  }

  /** The job a request's Proxy-Authorization belongs to, or undefined. */
  private authenticate(req: http.IncomingMessage): JobState | undefined {
    const header = req.headers['proxy-authorization'];
    if (typeof header !== 'string' || !/^basic /i.test(header)) return undefined;
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0 || decoded.slice(0, sep) !== 'job') return undefined;
    // Looked up by digest, so the comparison does not depend on how much of the token matched.
    const state = this.jobs.get(tokenKey(decoded.slice(sep + 1)));
    if (!state || Date.now() >= state.expires) return undefined;
    return state;
  }

  /**
   * Reserve a connection for the job, synchronously, or refuse it. The returned
   * function releases the reservation; it is safe to call more than once.
   */
  private admit(state: JobState): () => void {
    if (state.active >= this.limits.concurrentPerJob || state.opened >= this.limits.totalPerJob
      || this.active >= this.limits.concurrentTotal) {
      throw new Refused(429, 'connection limit');
    }
    state.active++;
    state.opened++;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active--;
      this.active--;
    };
  }

  /**
   * Register a connection's sockets so revoking the job closes them. `linked`
   * sockets end together: when one closes, the others are closed too.
   */
  private track(state: JobState, release: () => void, linked: net.Socket[], others: net.Socket[] = []): void {
    const all = [...linked, ...others];
    if (state.revoked) {
      for (const stream of all) stream.destroy();
      release();
      return;
    }
    for (const stream of all) {
      state.open.add(stream);
      stream.setTimeout(this.limits.idleMs, () => stream.destroy());
      stream.once('close', () => state.open.delete(stream));
    }
    for (const stream of linked) {
      stream.once('close', () => {
        release();
        for (const other of linked) other.destroy();
      });
    }
  }

  private refuse(state: JobState | undefined, host: string, reason: string): void {
    if (state) {
      state.logged++;
      if (state.logged > this.limits.logsPerJob) return;
    }
    this.log(`[MediaEgress] Refused a media connection to ${printableHost(host)} (${reason})`);
  }

  /** Resolve the host and keep only the addresses the policy allows. */
  private async approvedAddresses(host: string): Promise<string[]> {
    const literal = host.replace(/^\[|\]$/g, '');
    let answers: string[];
    if (net.isIP(literal)) {
      answers = [literal];
    } else {
      try {
        answers = await this.resolve(literal);
      } catch {
        throw new Refused(502, 'did not resolve');
      }
    }
    const approved: string[] = [];
    let reason = 'did not resolve';
    for (const address of answers) {
      const refusal = this.options.permitAddress?.(address) ? null : mediaEgressRefusal(address);
      if (refusal) reason = `${refusal} address`;
      else approved.push(address);
    }
    if (approved.length === 0) throw new Refused(403, reason);
    return approved;
  }

  private checkPort(port: number): void {
    if (!MEDIA_EGRESS_PORTS.has(port) && !this.options.permitPort?.(port)) {
      throw new Refused(403, `port ${port} not allowed`);
    }
  }

  /** Open a TCP connection to host:port; abandoned when the job is revoked. */
  private dial(host: string, port: number, signal: AbortSignal): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Refused(410, 'job ended'));
        return;
      }
      const s = net.connect({ host, port });
      const finish = (err?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (err) {
          s.destroy();
          reject(err);
        } else {
          resolve(s);
        }
      };
      const onAbort = () => finish(new Refused(410, 'job ended'));
      const timer = setTimeout(() => finish(new Refused(504, 'connect timed out')), this.limits.connectMs);
      signal.addEventListener('abort', onAbort, { once: true });
      s.once('connect', () => finish());
      s.once('error', (err) => finish(err));
    });
  }

  /** Open a TCP stream to address:port, directly or as a CONNECT tunnel through the upstream proxy. */
  private async connect(address: string, port: number, signal: AbortSignal): Promise<{ socket: net.Socket; head: Buffer }> {
    const upstream = this.options.upstream;
    const socket = upstream ? await this.dial(upstream.host, upstream.port, signal) : await this.dial(address, port, signal);
    if (!upstream) return { socket, head: Buffer.alloc(0) };
    // Ask the upstream for the approved address, never the host name, so it cannot resolve it differently.
    const authority = net.isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`;
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
      (upstream.authorization ? `Proxy-Authorization: ${upstream.authorization}\r\n` : '') + '\r\n',
    );
    try {
      return { socket, head: await readConnectResponse(socket, this.limits.connectMs) };
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  /** Try each approved address in turn. */
  private async connectAny(addresses: string[], port: number, signal: AbortSignal): Promise<{ socket: net.Socket; head: Buffer }> {
    let lastErr: unknown;
    for (const address of addresses) {
      if (signal.aborted) break;
      try {
        return await this.connect(address, port, signal);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Refused ? lastErr : new Refused(502, 'could not connect');
  }

  /** CONNECT host:port (https). */
  private async tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    const state = this.authenticate(req);
    if (!state) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="media"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = parseAuthority(req.url ?? '');
    let release = () => {};
    try {
      if (!target) throw new Refused(400, 'malformed target');
      this.checkPort(target.port);
      release = this.admit(state);
      const addresses = await this.approvedAddresses(target.host);
      const { socket, head: early } = await this.connectAny(addresses, target.port, state.abort.signal);
      if (state.revoked || client.destroyed) {
        socket.destroy();
        client.destroy();
        release();
        return;
      }
      this.track(state, release, [client, socket]);
      socket.on('error', () => socket.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (early.length) client.write(early);
      if (head.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    } catch (err) {
      release();
      const refused = err instanceof Refused ? err : new Refused(502, 'could not connect');
      this.refuse(state, target?.host ?? '?', refused.reason);
      client.end(`HTTP/1.1 ${refused.status} ${http.STATUS_CODES[refused.status] ?? 'Error'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    }
  }

  /** Absolute-form http:// request, sent on as origin-form to the approved address. */
  private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const state = this.authenticate(req);
    if (!state) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="media"', Connection: 'close' }).end();
      return;
    }
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? '');
    } catch { /* refused below */ }
    let release = () => {};
    try {
      if (!url || url.protocol !== 'http:' || !url.hostname || url.username || url.password) {
        throw new Refused(400, 'only absolute http:// URLs and CONNECT are forwarded');
      }
      // Media downloads only read. A body without framing the upstream request keeps would be sent raw.
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Refused(405, 'only GET and HEAD are forwarded');
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) {
        throw new Refused(400, 'request body not allowed');
      }
      const port = url.port ? Number(url.port) : 80;
      this.checkPort(port);
      release = this.admit(state);
      const addresses = await this.approvedAddresses(url.hostname);
      // Directly, or through an upstream proxy as a tunnel to the approved address, so the
      // request keeps its own Host for name-based hosting.
      const { socket, head } = await this.connectAny(addresses, port, state.abort.signal);
      if (head.length) socket.unshift(head);
      const headers: http.OutgoingHttpHeaders = {};
      const listed = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map((h) => h.trim()));
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.has(name) && !listed.has(name) && value !== undefined) headers[name] = value;
      }
      headers.host = url.host;
      headers.connection = 'close';
      // Revoking the job closes both sides; the upstream connection is used for this request only.
      this.track(state, release, [socket], [req.socket]);
      const out = http.request({
        createConnection: () => socket,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false,
      });
      const fail = () => {
        if (!res.headersSent) res.writeHead(502, { Connection: 'close' }).end();
        else res.destroy();
      };
      out.on('response', (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 0;
        if (status < 200 || status > 599) {
          upstreamRes.destroy();
          fail();
          return;
        }
        const back: http.OutgoingHttpHeaders = { connection: 'close' };
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_HEADERS.has(name) && value !== undefined) back[name] = value;
        }
        try {
          res.writeHead(status, back);
        } catch {
          upstreamRes.destroy();
          res.destroy();
          return;
        }
        // A response cut off upstream is cut off here too, not left hanging.
        upstreamRes.on('error', () => res.destroy());
        upstreamRes.on('close', () => { if (!upstreamRes.complete) res.destroy(); });
        upstreamRes.pipe(res);
      });
      out.on('error', fail);
      res.on('close', () => out.destroy());
      req.pipe(out);
    } catch (err) {
      release();
      const refused = err instanceof Refused ? err : new Refused(502, 'could not connect');
      this.refuse(state, url?.hostname ?? '?', refused.reason);
      if (!res.headersSent) res.writeHead(refused.status, { Connection: 'close' });
      res.end();
    }
  }
}

/** Parse a CONNECT target (`host:port`, `[v6]:port`). */
export function parseAuthority(value: string): { host: string; port: number } | null {
  const match = value.match(/^(\[[0-9a-fA-F:.]+\]|[^:[\]/\s]+):(\d{1,5})$/);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

/** Read an upstream proxy's CONNECT response; returns bytes received after it. */
function readConnectResponse(socket: net.Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Refused(504, 'upstream proxy timed out')), timeoutMs);
    const finish = (err?: Error, rest?: Buffer) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (err) reject(err);
      else resolve(rest ?? Buffer.alloc(0));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffered.length > 8192) finish(new Refused(502, 'upstream proxy response too large'));
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString('latin1'));
      if (status?.[1] !== '200') finish(new Refused(502, `upstream proxy answered ${status?.[1] ?? 'invalid'}`));
      else finish(undefined, buffered.subarray(end + 4));
    };
    const onError = () => finish(new Refused(502, 'upstream proxy failed'));
    const onClose = () => finish(new Refused(502, 'upstream proxy closed'));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}
