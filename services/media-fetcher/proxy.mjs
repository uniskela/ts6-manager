/** Checked media-egress proxy. Media TCP on :8080 (ts6_fetch only). Control is unix. */
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {
  constrainRadioPorts,
  parseConnectAuthority,
  parseJobId,
  pinMediaAddresses,
} from './policy.mjs';
import { buildClientResponseHeaders } from './response-headers.mjs';
import { assertPrivateTokenMode, tokensEqual } from './token.mjs';

const listenPort = Number(process.env.PROXY_PORT || 8080);
const ctlPath = process.env.PROXY_CTL || '/ctl/proxy.sock';
const ctlTokenFile = process.env.PROXY_CTL_TOKEN_FILE || '/ctl/.ctl-token';
const permitPrivate = process.env.PROXY_PERMIT_PRIVATE === '1';
const maxJobs = Number(process.env.PROXY_MAX_JOBS || 8);
const jobs = new Map(); // tokenHash -> state

function readCtlToken() {
  assertPrivateTokenMode(fs.statSync(ctlTokenFile).mode);
  const token = fs.readFileSync(ctlTokenFile, 'utf8').replace(/\s+/g, '');
  if (token.length < 16) throw new Error('ctl token too short');
  return token;
}

let ctlToken;
try {
  ctlToken = readCtlToken();
} catch (err) {
  process.stdout.write(`PROXY error ${err.message}\n`);
  process.exit(1);
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function ctlAuthorized(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  return tokensEqual(m[1], ctlToken);
}

function jobFor(req) {
  const header = req.headers['proxy-authorization'] || '';
  const m = /^Basic (.+)$/.exec(header);
  if (!m) return null;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString(); } catch { return null; }
  if (!decoded.startsWith('job:')) return null;
  return jobs.get(tokenHash(decoded.slice(4))) || null;
}

function allowedHost(job, host) {
  return job.hosts.size === 0 || job.hosts.has(host.toLowerCase());
}

function allowedPort(job, port) {
  return job.ports.has(Number(port));
}

/**
 * Rebuild an HTTP path from printable ASCII only so upstream requests cannot
 * carry CR/LF or other control bytes from the client URL.
 */
function sanitizeProxyPath(pathname, search) {
  const raw = `${pathname || '/'}${search || ''}`;
  if (!raw.startsWith('/')) return null;
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.codePointAt(i);
    if (code === undefined || code < 0x20 || code > 0x7e) return null;
    out += raw[i];
  }
  return out;
}

function pinnedHttpRequest(opts, onResponse) {
  const { destinationIp, port, requestPath, method, hostHeader, signal } = opts;
  if (!net.isIP(destinationIp)) throw new Error('destination must be an IP');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/')) throw new Error('bad path');
  return http.request({
    host: destinationIp,
    port,
    path: requestPath,
    method,
    headers: { host: hostHeader, connection: 'close' },
    setHost: false,
    signal,
  }, onResponse);
}

async function resolveHost(host, signal) {
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) return pinMediaAddresses([literal], { permitPrivate });
  const resolver = new Resolver({ timeout: 4_000, tries: 2 });
  const cancel = () => resolver.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(literal), resolver.resolve6(literal)])
    .finally(() => signal?.removeEventListener('abort', cancel));
  const answers = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
  return pinMediaAddresses(answers, { permitPrivate });
}

function track(job, socket) {
  job.sockets.add(socket);
  socket.on('close', () => job.sockets.delete(socket));
}

function destroyJob(job) {
  job.abort.abort();
  for (const socket of [...job.sockets]) socket.destroy();
  job.sockets.clear();
}

function snapshot() {
  let open = 0;
  for (const job of jobs.values()) open += job.sockets.size;
  return { open, jobs: [...jobs.values()].map((j) => ({ id: j.id, open: j.sockets.size })) };
}

const server = http.createServer(async (req, res) => {
  const job = jobFor(req);
  if (!job) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic', Connection: 'close' }).end();
    return;
  }
  let url;
  try { url = new URL(req.url); } catch {
    res.writeHead(400, { Connection: 'close' }).end();
    return;
  }
  const port = Number(url.port || 80);
  if (url.protocol !== 'http:' || !allowedHost(job, url.hostname) || !allowedPort(job, port)) {
    res.writeHead(403, { Connection: 'close' }).end('refused');
    return;
  }
  track(job, req.socket);
  let pinned;
  try {
    pinned = await resolveHost(url.hostname, job.abort.signal);
    if (!pinned.addresses.length) throw new Error(pinned.reason);
  } catch {
    res.writeHead(403, { Connection: 'close' }).end('refused');
    return;
  }
  // Request only the DNS-pinned allowlisted address (not the raw user hostname).
  const destinationIp = pinned.addresses[0];
  const requestPath = sanitizeProxyPath(url.pathname, url.search);
  if (!net.isIP(destinationIp) || !requestPath) {
    res.writeHead(403, { Connection: 'close' }).end('refused');
    return;
  }
  let up;
  try {
    up = pinnedHttpRequest({
      destinationIp,
      port,
      requestPath,
      method: req.method,
      hostHeader: url.host,
      signal: job.abort.signal,
    }, (upRes) => {
      if (upRes.socket) track(job, upRes.socket);
      if (!res.headersSent) {
        // Forward status + allowlisted headers only. Location is rebuilt in
        // buildClientResponseHeaders; this proxy never follows redirects —
        // the client re-requests through the same auth/DNS/port checks.
        const status = Number(upRes.statusCode) || 502;
        const headers = buildClientResponseHeaders(upRes);
        res.writeHead(status, headers);
      }
      upRes.pipe(res);
      upRes.on('end', () => {
        res.end();
        req.socket.destroy();
        upRes.socket?.destroy();
      });
    });
  } catch {
    res.writeHead(403, { Connection: 'close' }).end('refused');
    return;
  }
  up.on('socket', (s) => track(job, s));
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { Connection: 'close' }).end();
    else res.destroy();
    req.socket.destroy();
  });
  req.pipe(up);
});
server.keepAliveTimeout = 0;
server.maxRequestsPerSocket = 1;
server.requestTimeout = 30_000;

server.on('connect', async (req, socket) => {
  const job = jobFor(req);
  socket.on('error', () => socket.destroy());
  if (!job) {
    socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  track(job, socket);
  const parsed = parseConnectAuthority(req.url || '');
  if (!parsed) {
    socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const { host, port } = parsed;
  if (!job.connect || !allowedHost(job, host) || !allowedPort(job, port)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  try {
    const pinned = await resolveHost(host, job.abort.signal);
    if (!pinned.addresses.length) throw new Error(pinned.reason);
    const up = net.connect(port, pinned.addresses[0], () => {
      track(job, up);
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => {
      if (!socket.writableEnded) {
        try { socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); } catch { /* gone */ }
      }
      socket.destroy();
    });
    socket.on('close', () => up.destroy());
    job.abort.signal.addEventListener('abort', () => { up.destroy(); socket.destroy(); }, { once: true });
  } catch {
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  }
});

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        req.destroy();
        reject(new Error('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function control(req, res) {
  try {
    if (!ctlAuthorized(req)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/jobs') {
      if (jobs.size >= maxJobs) {
        res.writeHead(429).end();
        return;
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.token || typeof body.token !== 'string' || body.token.length < 16) {
        res.writeHead(400).end();
        return;
      }
      const id = parseJobId(body.id);
      if (!id) {
        res.writeHead(400).end();
        return;
      }
      for (const job of jobs.values()) {
        if (job.id === id) {
          res.writeHead(409).end();
          return;
        }
      }
      const ports = constrainRadioPorts(body.ports);
      if (!ports) {
        res.writeHead(400).end();
        return;
      }
      jobs.set(tokenHash(body.token), {
        id,
        hosts: new Set((body.hosts || []).map((h) => String(h).toLowerCase())),
        ports: new Set(ports),
        connect: body.connect === true,
        sockets: new Set(),
        abort: new AbortController(),
      });
      res.writeHead(201).end(JSON.stringify({ id }));
      return;
    }
    const revoke = /^\/jobs\/([^/]+)\/revoke$/.exec(req.url || '');
    if (req.method === 'POST' && revoke) {
      const jobId = parseJobId(revoke[1]);
      if (!jobId) {
        res.writeHead(400).end();
        return;
      }
      for (const job of jobs.values()) {
        if (job.id === jobId) {
          destroyJob(job);
          res.writeHead(200).end(JSON.stringify({ revoked: job.id, open: job.sockets.size }));
          return;
        }
      }
      res.writeHead(404).end();
      return;
    }
    const del = /^\/jobs\/([^/]+)$/.exec(req.url || '');
    if (req.method === 'DELETE' && del) {
      const jobId = parseJobId(del[1]);
      if (!jobId) {
        res.writeHead(400).end();
        return;
      }
      for (const [hash, job] of jobs) {
        if (job.id === jobId) {
          destroyJob(job);
          jobs.delete(hash);
          res.writeHead(200).end(JSON.stringify({ deleted: jobId, ...snapshot() }));
          return;
        }
      }
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
      res.writeHead(200).end(JSON.stringify(snapshot()));
      return;
    }
    res.writeHead(404).end();
  } catch {
    res.writeHead(400).end();
  }
}

try { fs.unlinkSync(ctlPath); } catch { /* first run */ }
const ctl = http.createServer(control);
ctl.listen(ctlPath, () => {
  try { fs.chmodSync(ctlPath, 0o660); } catch { /* volume fs */ }
});
server.listen(listenPort, '0.0.0.0', () => {
  process.stdout.write(`PROXY ready :${listenPort} ctl=unix\n`);
});

function shutdown() {
  for (const [hash, job] of jobs) {
    destroyJob(job);
    jobs.delete(hash);
  }
  server.close();
  ctl.close();
  try { fs.unlinkSync(ctlPath); } catch { /* gone */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
