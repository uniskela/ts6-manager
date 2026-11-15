/**
 * Shared helpers for real-proxy redirect integration tests.
 * Deterministic child lifecycle (L-1): never wait forever on an already-exited process.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mediaEgressRefusal, RADIO_EGRESS_PORTS } from './policy.mjs';

export function childExited(child) {
  return child != null && (child.exitCode != null || child.signalCode != null);
}

/** Resolve when the child has exited; no-op wait if already dead. */
export function waitForExit(child, ms = 5_000) {
  if (!child) return Promise.resolve({ code: null, signal: null });
  if (childExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      reject(new Error(`child exit timeout after ${ms}ms`));
    }, ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** SIGTERM (or given signal) then wait; safe if already exited. */
export async function stopChild(child, signal = 'SIGTERM') {
  if (!child || childExited(child)) return;
  try { child.kill(signal); } catch { /* race */ }
  await waitForExit(child);
}

export function pickBindIp(opts = {}) {
  const allowed = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      if (mediaEgressRefusal(a.address, opts) === null) allowed.push(a.address);
    }
  }
  if (!allowed.length) return null;
  if (opts.permitPrivate) {
    const priv = allowed.find((ip) => mediaEgressRefusal(ip) === 'private');
    if (priv) return priv;
  }
  return allowed[0];
}

export function requireBindIp(opts, label) {
  const ip = pickBindIp(opts);
  if (!ip) {
    throw new Error(
      `${label}: no non-loopback IPv4 passes mediaEgressRefusal(${JSON.stringify(opts)}). `
      + 'Required real-proxy redirect tests cannot run; failing the job.',
    );
  }
  return ip;
}

export function listenOnRadioPort(host, exclude = new Set()) {
  const candidates = [...RADIO_EGRESS_PORTS].filter((p) => p !== 443 && p !== 80 && !exclude.has(p));
  return new Promise((resolve, reject) => {
    const tryNext = (i) => {
      if (i >= candidates.length) {
        reject(new Error(`no free radio port on ${host}`));
        return;
      }
      const port = candidates[i];
      const server = http.createServer();
      server.once('error', () => {
        server.close();
        tryNext(i + 1);
      });
      server.listen(port, host, () => resolve({ server, port }));
    };
    tryNext(0);
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

export function waitReady(child, needle, ms = 8_000) {
  return new Promise((resolve, reject) => {
    if (childExited(child)) {
      reject(new Error(`proxy already exited before ready: code=${child.exitCode} signal=${child.signalCode}`));
      return;
    }
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${needle}: ${buf}`)), ms);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(needle)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(buf);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited before ready code=${code} signal=${signal}: ${buf}`));
    });
  });
}

export function proxyAuth(token) {
  return `Basic ${Buffer.from(`job:${token}`).toString('base64')}`;
}

export function requestThroughProxy(proxyPort, absoluteUrl, { method = 'GET', token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: absoluteUrl,
      method,
      headers: {
        Host: new URL(absoluteUrl).host,
        'Proxy-Authorization': proxyAuth(token),
        Connection: 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

export function connectThroughProxy(proxyPort, authority, token) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connect timeout'));
    }, 3_000);
    socket.on('data', (c) => {
      buf += c.toString();
      if (buf.includes('\r\n\r\n')) {
        clearTimeout(timer);
        const status = Number(/^HTTP\/1\.\d (\d+)/.exec(buf)?.[1] || 0);
        socket.destroy();
        resolve({ status, text: buf });
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nProxy-Authorization: ${proxyAuth(token)}\r\nConnection: close\r\n\r\n`,
    );
  });
}

export function ctl(sockPath, ctlToken, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      socketPath: sockPath,
      path: urlPath,
      method,
      headers: {
        authorization: `Bearer ${ctlToken}`,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Auth-injecting shim (like production job shim). Records absolute-form request
 * targets so FFmpeg tests can prove hops traversed the proxy (L-4).
 */
export function startAuthShim(proxyPort, jobToken) {
  const auth = proxyAuth(jobToken);
  const requests = [];
  const server = net.createServer((client) => {
    const up = net.connect(proxyPort, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let headed = false;
    client.on('data', (chunk) => {
      if (headed) { up.write(chunk); return; }
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.subarray(0, idx).toString();
      const rest = buf.subarray(idx + 4);
      headed = true;
      const line = head.split('\r\n')[0] || '';
      const target = line.split(' ')[1] || '';
      requests.push(target);
      up.write(`${head}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
      if (rest.length) up.write(rest);
    });
    up.on('data', (c) => { try { client.write(c); } catch { /* closed */ } });
    const die = () => { client.destroy(); up.destroy(); };
    client.on('error', die);
    up.on('error', die);
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

export function spawnProxy(here, { proxyPort, ctlPath, tokenFile, permitPrivate = false, maxJobs = 4 }) {
  const env = {
    ...process.env,
    PROXY_PORT: String(proxyPort),
    PROXY_CTL: ctlPath,
    PROXY_CTL_TOKEN_FILE: tokenFile,
    PROXY_MAX_JOBS: String(maxJobs),
  };
  if (permitPrivate) env.PROXY_PERMIT_PRIVATE = '1';
  else delete env.PROXY_PERMIT_PRIVATE;
  return spawn(process.execPath, [path.join(here, 'proxy.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function writeCtlToken(dir, token) {
  const tokenFile = path.join(dir, '.ctl-token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return tokenFile;
}
