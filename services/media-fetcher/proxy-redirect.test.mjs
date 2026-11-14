/**
 * Real-proxy redirect wiring + production-policy negatives.
 *
 * Wiring suite: PROXY_PERMIT_PRIVATE=1 + non-loopback bind (prefer private LAN).
 * Required suites fail if no bind IP. FFmpeg redirect is required when
 * REQUIRE_FFMPEG_REDIRECT=1 or CI=true (after apt install in PR validation).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { mediaEgressRefusal, RADIO_EGRESS_PORTS } from './policy.mjs';
import {
  childExited,
  connectThroughProxy,
  ctl,
  freePort,
  listenOnRadioPort,
  pickBindIp,
  requestThroughProxy,
  requireBindIp,
  spawnProxy,
  startAuthShim,
  stopChild,
  waitForExit,
  waitReady,
  writeCtlToken,
} from './proxy-redirect-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CTL_TOKEN = 'ts6-proxy-redirect-test-token';
const JOB_TOKEN = 'ts6-job-redirect-test-token';

function requireFfmpegInCi() {
  return process.env.REQUIRE_FFMPEG_REDIRECT === '1' || process.env.CI === 'true';
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
  let tokenFile;

  function originBase(port) {
    return `http://${originIp}:${port}`;
  }

  before(async () => {
    originIp = requireBindIp({ permitPrivate: true }, 'proxy-redirect wiring');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-proxy-redir-'));
    ctlPath = path.join(dir, 'proxy.sock');
    tokenFile = writeCtlToken(dir, CTL_TOKEN);
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
      if (req.url === '/https-loc') {
        // Absolute https Location for header-forward check only (CONNECT tested separately).
        res.writeHead(302, { Location: `https://${originIp}/live` });
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
    proxy = spawnProxy(here, {
      proxyPort,
      ctlPath,
      tokenFile,
      permitPrivate: true,
    });
    await waitReady(proxy, 'PROXY ready');

    const reg = await ctl(ctlPath, CTL_TOKEN, 'POST', '/jobs', {
      id: 'redir1',
      token: JOB_TOKEN,
      ports: [...RADIO_EGRESS_PORTS],
      connect: false,
      hosts: [],
    });
    assert.equal(reg.status, 201, reg.body);
  });

  after(async () => {
    await stopChild(proxy);
    if (origin) await new Promise((r) => origin.close(r));
    if (altOrigin) await new Promise((r) => altOrigin.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts the real proxy and forwards a direct stream without leaking headers', async () => {
    hits.length = 0;
    const res = await requestThroughProxy(proxyPort, `${originBase(originPort)}/direct`, { token: JOB_TOKEN });
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
    const res = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-abs`, { token: JOB_TOKEN });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `${originBase(originPort)}/direct`);
    assert.deepEqual(hits, ['GET /same-abs'], 'proxy must not fetch the Location target');
  });

  it('returns same-host relative redirect without following', async () => {
    hits.length = 0;
    const res = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-rel`, { token: JOB_TOKEN });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/direct');
    assert.deepEqual(hits, ['GET /same-rel']);
  });

  it('re-authenticates the next hop through the same checked proxy', async () => {
    hits.length = 0;
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-abs`, { token: JOB_TOKEN });
    assert.equal(first.status, 302);
    const second = await requestThroughProxy(proxyPort, first.headers.location, { token: JOB_TOKEN });
    assert.equal(second.status, 200);
    assert.equal(second.body, 'PCM');
    assert.deepEqual(hits, ['GET /same-abs', 'GET /direct']);
  });

  it('allows a redirect to another permitted radio port on the same host', async () => {
    hits.length = 0;
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/cross-port`, { token: JOB_TOKEN });
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, `${originBase(altPort)}/direct`);
    const second = await requestThroughProxy(proxyPort, first.headers.location, { token: JOB_TOKEN });
    assert.equal(second.status, 200);
    assert.equal(second.body, 'ALT');
  });

  it('refuses a subsequent hop to a forbidden port', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/bad-port`, { token: JOB_TOKEN });
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, `http://${originIp}:22/ssh`);
    const second = await requestThroughProxy(proxyPort, first.headers.location, { token: JOB_TOKEN });
    assert.equal(second.status, 403);
    assert.match(second.body, /refused/);
  });

  it('forwards HTTPS Location and refuses CONNECT to fixture host when connect:false (L-2)', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/https-loc`, { token: JOB_TOKEN });
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, `https://${originIp}/live`);
    // CONNECT target is the fixture IP + allowed radio port — no public DNS.
    const hop = await connectThroughProxy(proxyPort, `${originIp}:${originPort}`, JOB_TOKEN);
    assert.equal(hop.status, 403, 'HTTP-start jobs keep connect:false');
  });

  it('refuses a follow-up hop to loopback even when Location was forwarded', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/loopback-hop`, { token: JOB_TOKEN });
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, 'http://127.0.0.1/metadata');
    const second = await requestThroughProxy(proxyPort, first.headers.location, { token: JOB_TOKEN });
    assert.equal(second.status, 403);
  });

  it('refuses a follow-up hop to link-local metadata even when Location was forwarded', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/metadata-hop`, { token: JOB_TOKEN });
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, 'http://169.254.169.254/latest/meta-data/');
    const second = await requestThroughProxy(proxyPort, first.headers.location, { token: JOB_TOKEN });
    assert.equal(second.status, 403);
  });

  it('omits oversized and malformed Location values', async () => {
    const oversize = await requestThroughProxy(proxyPort, `${originBase(originPort)}/oversize`, { token: JOB_TOKEN });
    assert.equal(oversize.status, 302);
    assert.equal(oversize.headers.location, undefined);
    const malformed = await requestThroughProxy(proxyPort, `${originBase(originPort)}/malformed`, { token: JOB_TOKEN });
    assert.equal(malformed.status, 302);
    assert.equal(malformed.headers.location, undefined);
  });

  it('does not auto-walk redirect loops', async () => {
    hits.length = 0;
    const a = await requestThroughProxy(proxyPort, `${originBase(originPort)}/loop-a`, { token: JOB_TOKEN });
    assert.equal(a.status, 302);
    assert.equal(a.headers.location, `${originBase(originPort)}/loop-b`);
    assert.deepEqual(hits, ['GET /loop-a']);
    const b = await requestThroughProxy(proxyPort, a.headers.location, { token: JOB_TOKEN });
    assert.equal(b.status, 302);
    assert.deepEqual(hits, ['GET /loop-a', 'GET /loop-b']);
  });

  it('rejects subsequent hops after job revoke and after delete', async () => {
    const first = await requestThroughProxy(proxyPort, `${originBase(originPort)}/same-abs`, { token: JOB_TOKEN });
    assert.equal(first.status, 302);
    const revoked = await ctl(ctlPath, CTL_TOKEN, 'POST', '/jobs/redir1/revoke');
    assert.equal(revoked.status, 200);
    const second = await requestThroughProxy(proxyPort, first.headers.location, { token: JOB_TOKEN });
    assert.notEqual(second.status, 200);
    assert.ok([403, 502].includes(second.status), `unexpected ${second.status}`);
    const deleted = await ctl(ctlPath, CTL_TOKEN, 'DELETE', '/jobs/redir1');
    assert.equal(deleted.status, 200);
    const afterDelete = await requestThroughProxy(proxyPort, first.headers.location, { token: JOB_TOKEN });
    assert.equal(afterDelete.status, 407);
  });

  it('rejects wrong job credentials on a redirect follow-up', async () => {
    const reg = await ctl(ctlPath, CTL_TOKEN, 'POST', '/jobs', {
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

describe('CONNECT denial is specifically connect:false (L-2 mutation)', () => {
  let dir;
  let originIp;
  let origin;
  let originPort;
  let proxyPort;
  let proxy;
  let ctlPath;
  let tokenFile;

  before(async () => {
    originIp = requireBindIp({ permitPrivate: true }, 'CONNECT mutation');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-proxy-conn-'));
    ctlPath = path.join(dir, 'proxy.sock');
    tokenFile = writeCtlToken(dir, CTL_TOKEN);
    const bound = await listenOnRadioPort(originIp);
    origin = bound.server;
    originPort = bound.port;
    origin.on('request', (_req, res) => res.writeHead(200).end('x'));
    proxyPort = await freePort();
    proxy = spawnProxy(here, { proxyPort, ctlPath, tokenFile, permitPrivate: true });
    await waitReady(proxy, 'PROXY ready');
  });

  after(async () => {
    await stopChild(proxy);
    if (origin) await new Promise((r) => origin.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses CONNECT when connect:false and allows when connect:true on the same fixture', async () => {
    const denied = await ctl(ctlPath, CTL_TOKEN, 'POST', '/jobs', {
      id: 'conn-deny',
      token: `${JOB_TOKEN}-deny`,
      ports: [...RADIO_EGRESS_PORTS],
      connect: false,
    });
    assert.equal(denied.status, 201, denied.body);
    const refuse = await connectThroughProxy(proxyPort, `${originIp}:${originPort}`, `${JOB_TOKEN}-deny`);
    assert.equal(refuse.status, 403);

    const allowed = await ctl(ctlPath, CTL_TOKEN, 'POST', '/jobs', {
      id: 'conn-allow',
      token: `${JOB_TOKEN}-allow`,
      ports: [...RADIO_EGRESS_PORTS],
      connect: true,
    });
    assert.equal(allowed.status, 201, allowed.body);
    const ok = await connectThroughProxy(proxyPort, `${originIp}:${originPort}`, `${JOB_TOKEN}-allow`);
    assert.equal(ok.status, 200, 'connect:true must establish tunnel to fixture (proves L-2 is not a DNS false positive)');
  });
});

describe('proxy crash fails promptly and cleanup does not hang (L-1)', () => {
  it('waitReady rejects when the proxy process exits early', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-proxy-crash-'));
    const ctlPath = path.join(dir, 'proxy.sock');
    // Missing ctl token file → proxy.mjs exits immediately.
    const proxyPort = await freePort();
    const proxy = spawn(process.execPath, [path.join(here, 'proxy.mjs')], {
      env: {
        ...process.env,
        PROXY_PORT: String(proxyPort),
        PROXY_CTL: ctlPath,
        PROXY_CTL_TOKEN_FILE: path.join(dir, 'missing-token'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await assert.rejects(() => waitReady(proxy, 'PROXY ready', 3_000), /exited/);
    assert.equal(childExited(proxy), true);
    const t0 = Date.now();
    await stopChild(proxy);
    assert.ok(Date.now() - t0 < 500, 'cleanup after crash must not hang');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('proxy default policy rejects private/loopback destinations', () => {
  let dir;
  let proxyPort;
  let proxy;
  let ctlPath;
  let privateLanIp;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-proxy-pol-'));
    ctlPath = path.join(dir, 'proxy.sock');
    const tokenFile = writeCtlToken(dir, CTL_TOKEN);
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
    proxy = spawnProxy(here, { proxyPort, ctlPath, tokenFile, permitPrivate: false });
    await waitReady(proxy, 'PROXY ready');
    const reg = await ctl(ctlPath, CTL_TOKEN, 'POST', '/jobs', {
      id: 'pol1',
      token: JOB_TOKEN,
      ports: [...RADIO_EGRESS_PORTS],
      connect: false,
    });
    assert.equal(reg.status, 201, reg.body);
  });

  after(async () => {
    await stopChild(proxy);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a direct request to loopback under default policy', async () => {
    const res = await requestThroughProxy(proxyPort, 'http://127.0.0.1/stream', { token: JOB_TOKEN });
    assert.equal(res.status, 403);
  });

  it('refuses a direct request to link-local metadata under default policy', async () => {
    const res = await requestThroughProxy(proxyPort, 'http://169.254.169.254/latest/meta-data/', { token: JOB_TOKEN });
    assert.equal(res.status, 403);
  });

  it('refuses a private LAN address when PROXY_PERMIT_PRIVATE is unset', async (t) => {
    if (!privateLanIp || mediaEgressRefusal(privateLanIp) === null) {
      t.skip('no private LAN IPv4 on this host (policy.test.mjs still covers private refusal)');
      return;
    }
    const res = await requestThroughProxy(proxyPort, `http://${privateLanIp}:8000/stream`, { token: JOB_TOKEN });
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

describe('ffmpeg follows absolute http redirect via authenticated proxy (L-4)', () => {
  it('both hops traverse the auth shim (required in CI)', async (t) => {
    const originIp = pickBindIp({ permitPrivate: true });
    if (!originIp) {
      assert.fail('no bind IP for ffmpeg redirect check');
    }
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const version = spawn(ffmpeg, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = await new Promise((resolve) => {
      version.on('error', () => resolve(false));
      version.on('exit', (code) => resolve(code === 0));
    });
    if (!ok) {
      if (requireFfmpegInCi()) {
        assert.fail('ffmpeg required in CI (REQUIRE_FFMPEG_REDIRECT/CI) but binary missing');
      }
      t.skip('ffmpeg binary not available (local only; CI installs ffmpeg)');
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-ff-redir-'));
    const ctlPath = path.join(dir, 'proxy.sock');
    const tokenFile = writeCtlToken(dir, CTL_TOKEN);
    const originHits = [];
    const bound = await listenOnRadioPort(originIp);
    const originPort = bound.port;
    const origin = bound.server;
    origin.on('request', (req, res) => {
      originHits.push(req.url);
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
    const proxy = spawnProxy(here, { proxyPort, ctlPath, tokenFile, permitPrivate: true });
    let shim;
    let ff;
    try {
      await waitReady(proxy, 'PROXY ready');
      const reg = await ctl(ctlPath, CTL_TOKEN, 'POST', '/jobs', {
        id: 'ff1',
        token: JOB_TOKEN,
        ports: [...RADIO_EGRESS_PORTS],
        connect: false,
      });
      assert.equal(reg.status, 201, reg.body);
      shim = await startAuthShim(proxyPort, JOB_TOKEN);
      const proxyUrl = `http://127.0.0.1:${shim.port}`;
      ff = spawn(ffmpeg, [
        '-hide_banner', '-nostdin', '-v', 'error',
        '-protocol_whitelist', 'http,https,tls,tcp,httpproxy,crypto',
        '-i', `http://${originIp}:${originPort}/go`,
        '-f', 'null', '-',
      ], {
        env: {
          ...process.env,
          http_proxy: proxyUrl,
          HTTP_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          no_proxy: '',
          NO_PROXY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const errChunks = [];
      ff.stderr.on('data', (c) => errChunks.push(c));
      await waitForExit(ff, 15_000);
      const shimPaths = shim.requests.join('\n');
      assert.ok(
        shim.requests.some((u) => u.includes('/go')),
        `first hop missing from proxy shim; shim=${shimPaths} origin=${originHits} ff=${Buffer.concat(errChunks).toString()}`,
      );
      assert.ok(
        shim.requests.some((u) => u.includes('/tone')),
        `redirect hop missing from proxy shim (direct access would hit origin only); shim=${shimPaths} origin=${originHits}`,
      );
      assert.ok(originHits.includes('/go'));
      assert.ok(originHits.includes('/tone'));
    } finally {
      if (shim) await shim.close();
      await stopChild(ff);
      await stopChild(proxy);
      await new Promise((r) => origin.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
