/**
 * Integration: media-fetcher proxy forwards sanitized Location without
 * following redirects; subsequent hops re-run auth/DNS/port checks.
 *
 * Origin binds a host IPv4 that passes mediaEgressRefusal (not loopback /
 * TEST-NET / private). Without that, every hop is 403 before Location matters.
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

function pickPublicBindIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      if (mediaEgressRefusal(a.address) === null) return a.address;
    }
  }
  return null;
}

const ORIGIN_IP = pickPublicBindIp();

function listenOnRadioPort(host) {
  const candidates = [...RADIO_EGRESS_PORTS].filter((p) => p !== 443 && p !== 80);
  return new Promise((resolve, reject) => {
    const tryNext = (i) => {
      if (i >= candidates.length) {
        reject(new Error('no free radio port for origin fixture'));
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

function originBase(port) {
  return `http://${ORIGIN_IP}:${port}`;
}

describe('proxy redirect Location forwarding', { skip: !ORIGIN_IP }, () => {
  let dir;
  let origin;
  let originPort;
  let altOrigin;
  let altPort;
  let proxyPort;
  let proxy;
  let hits;
  let ctlPath;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-proxy-redir-'));
    ctlPath = path.join(dir, 'proxy.sock');
    fs.writeFileSync(path.join(dir, '.ctl-token'), CTL_TOKEN, { mode: 0o600 });
    hits = [];

    const bound = await listenOnRadioPort(ORIGIN_IP);
    origin = bound.server;
    originPort = bound.port;
    origin.on('request', (req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/direct') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Set-Cookie': 'secret=1' });
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
        res.writeHead(302, { Location: `http://${ORIGIN_IP}:22/ssh` });
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
      res.writeHead(404).end();
    });

    // Second radio port on same public IP (allowed non-default port hop).
    const altCandidates = [...RADIO_EGRESS_PORTS].filter(
      (p) => p !== 443 && p !== 80 && p !== originPort,
    );
    altPort = null;
    for (const port of altCandidates) {
      try {
        altOrigin = await new Promise((resolve, reject) => {
          const server = http.createServer((req, res) => {
            hits.push(`alt ${req.method} ${req.url}`);
            if (req.url === '/direct') {
              res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
              res.end('ALT');
              return;
            }
            res.writeHead(404).end();
          });
          server.once('error', reject);
          server.listen(port, ORIGIN_IP, () => resolve(server));
        });
        altPort = port;
        break;
      } catch {
        altOrigin = null;
      }
    }

    proxyPort = await freePort();
    proxy = spawn(process.execPath, [path.join(here, 'proxy.mjs')], {
      env: {
        ...process.env,
        PROXY_PORT: String(proxyPort),
        PROXY_CTL: ctlPath,
        PROXY_CTL_TOKEN_FILE: path.join(dir, '.ctl-token'),
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

  it('forwards a direct non-redirect stream without leaking other headers', async () => {
    hits.length = 0;
    const res = await requestThroughProxy(proxyPort, `${originBase(originPort)}/direct`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'PCM');
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers.location, undefined);
    assert.deepEqual(hits, ['GET /direct']);
  });

  it('returns same-host absolute redirect without following', async () => {
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

  it('lets the client complete a redirect hop through the same checked proxy', async () => {
    hits.length = 0;
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-abs`);
    assert.equal(first.status, 302);
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(second.status, 200);
    assert.equal(second.body, 'PCM');
    assert.deepEqual(hits, ['GET /same-abs', 'GET /direct']);
  });

  it('allows a redirect to another permitted radio port on the same host', async () => {
    if (!altPort) return;
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
    assert.equal(first.headers.location, `http://${ORIGIN_IP}:22/ssh`);
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(second.status, 403);
    assert.match(second.body, /refused/);
  });

  it('refuses a subsequent hop to loopback even when Location was forwarded', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/loopback-hop`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, 'http://127.0.0.1/metadata');
    const second = await requestThroughProxy(proxyPort, first.headers.location);
    assert.equal(second.status, 403);
  });

  it('forwards HTTPS Location but refuses CONNECT for HTTP-start jobs', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/https-hop`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, 'https://example.com/live');
    const hop = await connectThroughProxy(proxyPort, 'example.com:443');
    assert.equal(hop.status, 403, 'HTTP-start jobs keep connect:false');
  });

  it('omits oversized or malformed Location values', async () => {
    const oversize = await requestThroughProxy(proxyPort, `${originBase(originPort)}/oversize`);
    assert.equal(oversize.status, 302);
    assert.equal(oversize.headers.location, undefined);
    const malformed = await requestThroughProxy(proxyPort, `${originBase(originPort)}/malformed`);
    assert.equal(malformed.status, 302);
    assert.equal(malformed.headers.location, undefined);
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

  it('rejects subsequent hops after job revoke (aborted grant)', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-abs`);
    assert.equal(first.status, 302);
    const revoked = await ctl(ctlPath, 'POST', '/jobs/redir1/revoke');
    assert.equal(revoked.status, 200);
    // revoke aborts the job but leaves the token mapped; follow-up must fail
    // (502/403), not stream the target. DELETE is what drops auth → 407.
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

/** Test-only: inject Proxy-Authorization like the production job shim (no pid gate). */
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

describe('ffmpeg follows absolute http redirect via proxy (optional)', { skip: !ORIGIN_IP }, () => {
  it('opens both hops when Location is forwarded (skips if ffmpeg missing)', async () => {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const version = spawn(ffmpeg, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = await new Promise((resolve) => {
      version.on('error', () => resolve(false));
      version.on('exit', (code) => resolve(code === 0));
    });
    if (!ok) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-ff-redir-'));
    const ctlPath = path.join(dir, 'proxy.sock');
    const tokenFile = path.join(dir, '.ctl-token');
    fs.writeFileSync(tokenFile, CTL_TOKEN, { mode: 0o600 });
    const hits = [];
    const bound = await listenOnRadioPort(ORIGIN_IP);
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
        res.writeHead(302, { Location: `${originBase(originPort)}/tone` });
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
        '-i', `${originBase(originPort)}/go`,
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
