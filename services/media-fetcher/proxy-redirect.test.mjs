/**
 * Real-proxy redirect wiring + production-policy negatives.
 *
 * Wiring suite binds a non-loopback IPv4 that passes mediaEgressRefusal under
 * PROXY_PERMIT_PRIVATE=1 (private LAN on CI runners, or a public NIC locally).
 * Loopback stays in neverAllowed even with permitPrivate — do not use 127.0.0.1
 * as the origin bind address.
 *
 * Required suites fail the job if no suitable bind address exists (no silent skip).
 * Optional ffmpeg follow uses explicit t.skip() only when ffmpeg is missing.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { mediaEgressRefusal, RADIO_EGRESS_PORTS } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CTL_TOKEN = 'ts6-proxy-redirect-test-token';
const JOB_TOKEN = 'ts6-job-redirect-test-token';

/** Non-loopback IPv4 that pinMediaAddresses accepts under the given policy opts. */
function pickBindIp(opts = {}) {
  const allowed = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      if (mediaEgressRefusal(a.address, opts) === null) allowed.push(a.address);
    }
  }
  if (!allowed.length) return null;
  // Prefer private LAN when permitPrivate (matches GitHub Actions runners).
  if (opts.permitPrivate) {
    const priv = allowed.find((ip) => mediaEgressRefusal(ip) === 'private');
    if (priv) return priv;
  }
  return allowed[0];
}

function requireBindIp(opts, label) {
  const ip = pickBindIp(opts);
  if (!ip) {
    throw new Error(
      `${label}: no non-loopback IPv4 passes mediaEgressRefusal(${JSON.stringify(opts)}). `
      + 'Required real-proxy redirect tests cannot run; failing the job (M-1).',
    );
  }
  return ip;
}

function listenOnRadioPort(host, exclude = new Set()) {
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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function waitReady(child, needle, ms = 8_000) {
  return new Promise((resolve, reject) => {
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
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited ${code}: ${buf}`));
    });
  });
}

function proxyAuth(token = JOB_TOKEN) {
  return `Basic ${Buffer.from(`job:${token}`).toString('base64')}`;
}

function requestThroughProxy(proxyPort, absoluteUrl, { method = 'GET', token = JOB_TOKEN } = {}) {
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

function connectThroughProxy(proxyPort, authority, token = JOB_TOKEN) {
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

function ctl(sockPath, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      socketPath: sockPath,
      path: urlPath,
      method,
      headers: {
        authorization: `Bearer ${CTL_TOKEN}`,
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

function startAuthShim(proxyPort, jobToken) {
  const auth = `Basic ${Buffer.from(`job:${jobToken}`).toString('base64')}`;
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('proxy redirect Location forwarding (wiring)', () => {
  let dir;
  let originIp;
  let origin;
  let originPort;
  let altOrigin;
  let altPort;
  let proxyPort;
  let proxy;
  let hits;
  let ctlPath;

  function originBase(port) {
    return `http://${originIp}:${port}`;
  }

  before(async () => {
    // Disposable test env only — production default leaves PROXY_PERMIT_PRIVATE unset.
    originIp = requireBindIp({ permitPrivate: true }, 'proxy-redirect wiring');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-proxy-redir-'));
    ctlPath = path.join(dir, 'proxy.sock');
    fs.writeFileSync(path.join(dir, '.ctl-token'), CTL_TOKEN, { mode: 0o600 });
    hits = [];

    const bound = await listenOnRadioPort(originIp);
    origin = bound.server;
    originPort = bound.port;
    origin.on('request', (req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/direct') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Set-Cookie': 'secret=1', Server: 'icecast' });
        res.end('PCM');
        return;
      }
      if (req.url === '/same-abs') {
        res.writeHead(302, { Location: `${originBase(originPort)}/direct` });
        res.end();
        return;
      }
      if (req.url === '/same-rel') {
        res.writeHead(302, { Location: '/direct' });
        res.end();
        return;
      }
      if (req.url === '/cross-port') {
        res.writeHead(302, { Location: `${originBase(altPort)}/direct` });
        res.end();
        return;
      }
      if (req.url === '/bad-port') {
        res.writeHead(302, { Location: `http://${originIp}:22/ssh` });
        res.end();
        return;
      }
      if (req.url === '/https-hop') {
        res.writeHead(302, { Location: 'https://example.com/live' });
        res.end();
        return;
      }
      if (req.url === '/loop-a') {
        res.writeHead(302, { Location: `${originBase(originPort)}/loop-b` });
        res.end();
        return;
      }
      if (req.url === '/loop-b') {
        res.writeHead(302, { Location: `${originBase(originPort)}/loop-a` });
        res.end();
        return;
      }
      if (req.url === '/oversize') {
        res.writeHead(302, { Location: `${originBase(originPort)}/${'x'.repeat(3000)}` });
        res.end();
        return;
      }
      if (req.url === '/malformed') {
        res.writeHead(302, { Location: 'file:///etc/passwd' });
        res.end();
        return;
      }
      if (req.url === '/loopback-hop') {
        res.writeHead(302, { Location: 'http://127.0.0.1/metadata' });
        res.end();
        return;
      }
      if (req.url === '/metadata-hop') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(404).end();
    });

    const altBound = await listenOnRadioPort(originIp, new Set([originPort]));
    altOrigin = altBound.server;
    altPort = altBound.port;
    altOrigin.on('request', (req, res) => {
      hits.push(`alt ${req.method} ${req.url}`);
      if (req.url === '/direct') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end('ALT');
        return;
      }
      res.writeHead(404).end();
    });

    proxyPort = await freePort();
    proxy = spawn(process.execPath, [path.join(here, 'proxy.mjs')], {
      env: {
        ...process.env,
        PROXY_PORT: String(proxyPort),
        PROXY_CTL: ctlPath,
        PROXY_CTL_TOKEN_FILE: path.join(dir, '.ctl-token'),
        PROXY_PERMIT_PRIVATE: '1',
        PROXY_MAX_JOBS: '4',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitReady(proxy, 'PROXY ready');

    const reg = await ctl(ctlPath, 'POST', '/jobs', {
      id: 'redir1',
      token: JOB_TOKEN,
      ports: [...RADIO_EGRESS_PORTS],
      connect: false,
      hosts: [],
    });
    assert.equal(reg.status, 201, reg.body);
  });

  after(async () => {
    if (proxy && !proxy.killed) {
      proxy.kill('SIGTERM');
      await new Promise((r) => proxy.once('exit', r));
    }
    if (origin) await new Promise((r) => origin.close(r));
    if (altOrigin) await new Promise((r) => altOrigin.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts the real proxy and forwards a direct stream without leaking headers', async () => {
    hits.length = 0;
    const res = await requestThroughProxy(proxyPort, `${originBase(originPort)}/direct`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'PCM');
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers.server, undefined);
    assert.equal(res.headers.location, undefined);
    assert.deepEqual(hits, ['GET /direct']);
  });

  it('returns same-host absolute redirect Location without following', async () => {
    hits.length = 0;
    const res = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-abs`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `${originBase(originPort)}/direct`);
    assert.deepEqual(hits, ['GET /same-abs'], 'proxy must not fetch the Location target');
  });

  it('returns same-host relative redirect without following', async () => {
    hits.length = 0;
    const res = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-rel`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/direct');
    assert.deepEqual(hits, ['GET /same-rel']);
  });

  it('re-authenticates the next hop through the same checked proxy', async () => {
    hits.length = 0;
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-abs`);
    assert.equal(first.status, 302);
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(second.status, 200);
    assert.equal(second.body, 'PCM');
    assert.deepEqual(hits, ['GET /same-abs', 'GET /direct']);
  });

  it('allows a redirect to another permitted radio port on the same host', async () => {
    hits.length = 0;
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/cross-port`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, `${originBase(altPort)}/direct`);
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(second.status, 200);
    assert.equal(second.body, 'ALT');
  });

  it('refuses a subsequent hop to a forbidden port', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/bad-port`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, `http://${originIp}:22/ssh`);
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(second.status, 403);
    assert.match(second.body, /refused/);
  });

  it('forwards HTTPS Location but refuses CONNECT for HTTP-start jobs', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/https-hop`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, 'https://example.com/live');
    const hop = await connectThroughProxy(proxyPort, 'example.com:443');
    assert.equal(hop.status, 403, 'HTTP-start jobs keep connect:false');
  });

  it('refuses a follow-up hop to loopback even when Location was forwarded', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/loopback-hop`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, 'http://127.0.0.1/metadata');
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(second.status, 403);
  });

  it('refuses a follow-up hop to link-local metadata even when Location was forwarded', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/metadata-hop`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, 'http://169.254.169.254/latest/meta-data/');
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(second.status, 403);
  });

  it('omits oversized and malformed Location values', async () => {
    const oversize = await requestThroughProxy(proxyPort, `${originBase(originPort)}/oversize`);
    assert.equal(oversize.status, 302);
    assert.equal(oversize.headers.location, undefined);
    const malformed = await requestThroughProxy(proxyPort, `${originBase(originPort)}/malformed`);
    assert.equal(malformed.status, 302);
    assert.equal(malformed.headers.location, undefined);
    // CRLF / header-injection Locations are covered in response-headers.test.mjs
    // (Node's writeHead refuses to emit them from a fixture origin).
  });

  it('does not auto-walk redirect loops', async () => {
    hits.length = 0;
    const a = await requestThroughProxy(proxyPort, `${originBase(originPort)}/loop-a`);
    assert.equal(a.status, 302);
    assert.equal(a.headers.location, `${originBase(originPort)}/loop-b`);
    assert.deepEqual(hits, ['GET /loop-a']);
    const b = await requestThroughProxy(proxyPort, a.headers.location);
    assert.equal(b.status, 302);
    assert.deepEqual(hits, ['GET /loop-a', 'GET /loop-b']);
  });

  it('rejects subsequent hops after job revoke and after delete', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-abs`);
    assert.equal(first.status, 302);
    const revoked = await ctl(ctlPath, 'POST', '/jobs/redir1/revoke');
    assert.equal(revoked.status, 200);
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.notEqual(second.status, 200);
    assert.ok([403, 502].includes(second.status), `unexpected ${second.status}`);
    const deleted = await ctl(ctlPath, 'DELETE', '/jobs/redir1');
    assert.equal(deleted.status, 200);
    const afterDelete = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(afterDelete.status, 407);
  });

  it('rejects wrong job credentials on a redirect follow-up', async () => {
    const reg = await ctl(ctlPath, 'POST', '/jobs', {
      id: 'redir2',
      token: `${JOB_TOKEN}-2`,
      ports: [...RADIO_EGRESS_PORTS],
      connect: false,
      hosts: [],
    });
    assert.equal(reg.status, 201, reg.body);
    const first = await requestThroughProxy(
      proxyPort,
      `${originBase(originPort)}/same-abs`,
      { token: `${JOB_TOKEN}-2` },
    );
    assert.equal(first.status, 302);
    const bad = await requestThroughProxy(proxyPort, first.headers.location, { token: 'not-a-real-job-token!' });
    assert.equal(bad.status, 407);
  });
});

describe('proxy default policy rejects private/loopback destinations', () => {
  /** Live proxy with production default (PROXY_PERMIT_PRIVATE unset). No origin bind required. */
  let dir;
  let proxyPort;
  let proxy;
  let ctlPath;
  let privateLanIp;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-proxy-pol-'));
    ctlPath = path.join(dir, 'proxy.sock');
    fs.writeFileSync(path.join(dir, '.ctl-token'), CTL_TOKEN, { mode: 0o600 });
    // Prefer an address that is private under production policy but allowed with permitPrivate.
    privateLanIp = null;
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        const v4 = a.family === 'IPv4' || a.family === 4;
        if (!v4 || a.internal) continue;
        if (
          mediaEgressRefusal(a.address, { permitPrivate: true }) === null
          && mediaEgressRefusal(a.address, {}) === 'private'
        ) {
          privateLanIp = a.address;
          break;
        }
      }
      if (privateLanIp) break;
    }
    proxyPort = await freePort();
    proxy = spawn(process.execPath, [path.join(here, 'proxy.mjs')], {
      env: {
        ...process.env,
        PROXY_PORT: String(proxyPort),
        PROXY_CTL: ctlPath,
        PROXY_CTL_TOKEN_FILE: path.join(dir, '.ctl-token'),
        // deliberately omit PROXY_PERMIT_PRIVATE — production default
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitReady(proxy, 'PROXY ready');
    const reg = await ctl(ctlPath, 'POST', '/jobs', {
      id: 'pol1',
      token: JOB_TOKEN,
      ports: [...RADIO_EGRESS_PORTS],
      connect: false,
    });
    assert.equal(reg.status, 201, reg.body);
  });

  after(async () => {
    if (proxy && !proxy.killed) {
      proxy.kill('SIGTERM');
      await new Promise((r) => proxy.once('exit', r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a direct request to loopback under default policy', async () => {
    const res = await requestThroughProxy(proxyPort, 'http://127.0.0.1/stream');
    assert.equal(res.status, 403);
  });

  it('refuses a direct request to link-local metadata under default policy', async () => {
    const res = await requestThroughProxy(proxyPort, 'http://169.254.169.254/latest/meta-data/');
    assert.equal(res.status, 403);
  });

  it('refuses a private LAN address when PROXY_PERMIT_PRIVATE is unset', async (t) => {
    if (!privateLanIp || mediaEgressRefusal(privateLanIp) === null) {
      t.skip('no private LAN IPv4 on this host (policy.test.mjs still covers private refusal)');
      return;
    }
    const res = await requestThroughProxy(proxyPort, `http://${privateLanIp}:8000/stream`);
    assert.equal(res.status, 403);
  });
});

describe('proxy wiring still denies neverAllowed destinations with PROXY_PERMIT_PRIVATE=1', () => {
  it('documents loopback/metadata stay refused (covered in wiring suite hops)', () => {
    assert.equal(mediaEgressRefusal('127.0.0.1', { permitPrivate: true }), 'reserved');
    assert.equal(mediaEgressRefusal('169.254.169.254', { permitPrivate: true }), 'reserved');
    assert.equal(mediaEgressRefusal('10.0.0.1', { permitPrivate: true }), null);
    assert.equal(mediaEgressRefusal('10.0.0.1', {}), 'private');
  });
});

describe('ffmpeg follows absolute http redirect via proxy (optional)', () => {
  it('opens both hops when Location is forwarded', async (t) => {
    const originIp = pickBindIp({ permitPrivate: true });
    if (!originIp) {
      t.skip('no bind IP for optional ffmpeg redirect check');
      return;
    }
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const version = spawn(ffmpeg, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = await new Promise((resolve) => {
      version.on('error', () => resolve(false));
      version.on('exit', (code) => resolve(code === 0));
    });
    if (!ok) {
      t.skip('ffmpeg binary not available');
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-ff-redir-'));
    const ctlPath = path.join(dir, 'proxy.sock');
    const tokenFile = path.join(dir, '.ctl-token');
    fs.writeFileSync(tokenFile, CTL_TOKEN, { mode: 0o600 });
    const hits = [];
    const bound = await listenOnRadioPort(originIp);
    const originPort = bound.port;
    const origin = bound.server;
    origin.on('request', (req, res) => {
      hits.push(req.url);
      if (req.url === '/tone') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(Buffer.alloc(1024, 0xff));
        return;
      }
      if (req.url === '/go') {
        res.writeHead(302, { Location: `http://${originIp}:${originPort}/tone` });
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
    const proxyPort = await freePort();
    const proxy = spawn(process.execPath, [path.join(here, 'proxy.mjs')], {
      env: {
        ...process.env,
        PROXY_PORT: String(proxyPort),
        PROXY_CTL: ctlPath,
        PROXY_CTL_TOKEN_FILE: tokenFile,
        PROXY_PERMIT_PRIVATE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let shim;
    try {
      await waitReady(proxy, 'PROXY ready');
      const reg = await ctl(ctlPath, 'POST', '/jobs', {
        id: 'ff1',
        token: JOB_TOKEN,
        ports: [...RADIO_EGRESS_PORTS],
        connect: false,
      });
      assert.equal(reg.status, 201, reg.body);
      shim = await startAuthShim(proxyPort, JOB_TOKEN);
      const proxyUrl = `http://127.0.0.1:${shim.port}`;
      const ff = spawn(ffmpeg, [
        '-hide_banner', '-nostdin', '-v', 'error',
        '-protocol_whitelist', 'http,https,tls,tcp,httpproxy,crypto',
        '-i', `http://${originIp}:${originPort}/go`,
        '-f', 'null', '-',
      ], {
        env: { ...process.env, http_proxy: proxyUrl, HTTP_PROXY: proxyUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const errChunks = [];
      ff.stderr.on('data', (c) => errChunks.push(c));
      await new Promise((resolve) => ff.on('exit', resolve));
      assert.ok(hits.includes('/go'), `hits=${hits} ff=${Buffer.concat(errChunks).toString()}`);
      assert.ok(
        hits.includes('/tone'),
        `ffmpeg did not follow Location through proxy; hits=${hits} stderr=${Buffer.concat(errChunks).toString()}`,
      );
    } finally {
      if (shim) await shim.close();
      proxy.kill('SIGTERM');
      await new Promise((r) => proxy.once('exit', r));
      await new Promise((r) => origin.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
