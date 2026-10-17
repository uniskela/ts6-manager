import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { MediaEgressProxy, parseAuthority, type MediaEgressProxyOptions } from './media-egress-proxy.js';

/** Local servers stand in for public media hosts; tests allow their address and port explicitly. */
const permitLocal: Pick<MediaEgressProxyOptions, 'permitAddress' | 'permitPort'> = {
  permitAddress: (address) => address === '127.0.0.1',
  permitPort: () => true,
};

function credentials(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  return `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
}

function proxyPort(proxyUrl: string): number {
  return Number(new URL(proxyUrl).port);
}

/** Send raw bytes to the proxy and collect the reply until `until` matches or the socket closes. */
async function raw(port: number, request: string, until = /\r\n\r\n/): Promise<{ text: string; socket: net.Socket }> {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(request);
  let text = '';
  await new Promise<void>((resolve) => {
    socket.on('data', (chunk) => { text += chunk.toString('latin1'); if (until.test(text)) resolve(); });
    socket.on('close', () => resolve());
    socket.on('error', () => resolve());
  });
  return { text, socket };
}

const statusOf = (text: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);

describe('media egress proxy', () => {
  let echo: net.Server;
  let echoPort: number;
  let web: http.Server;
  let webPort: number;
  let webHits: string[];

  before(async () => {
    echo = net.createServer((socket) => socket.pipe(socket));
    echo.listen(0, '127.0.0.1');
    await once(echo, 'listening');
    echoPort = (echo.address() as net.AddressInfo).port;
    webHits = [];
    web = http.createServer((req, res) => {
      webHits.push(`${req.method} ${req.url} host=${req.headers.host} auth=${req.headers['proxy-authorization'] ?? ''}`);
      if (req.url === '/redirect') res.writeHead(302, { Location: 'http://media.test/elsewhere' }).end();
      else res.writeHead(200, { 'Content-Type': 'text/plain' }).end('media bytes');
    });
    web.listen(0, '127.0.0.1');
    await once(web, 'listening');
    webPort = (web.address() as net.AddressInfo).port;
  });

  after(() => {
    echo.close();
    web.close();
  });

  it('requires a live job token', async () => {
    const proxy = new MediaEgressProxy({ ...permitLocal, log: () => {} });
    try {
      const job = await proxy.issue(60_000);
      const port = proxyPort(job.proxyUrl);
      const target = `127.0.0.1:${echoPort}`;

      const none = await raw(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      assert.equal(statusOf(none.text), 407);
      assert.match(none.text, /Proxy-Authenticate: Basic/, 'ffmpeg sends credentials only after a challenge');

      const wrong = await raw(port, `CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl.replace(/job:[0-9a-f]+@/, 'job:00@'))}\r\n\r\n`);
      assert.equal(statusOf(wrong.text), 407);

      const ok = await raw(port, `CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`);
      assert.equal(statusOf(ok.text), 200);
      ok.socket.destroy();

      job.release();
      const revoked = await raw(port, `CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`);
      assert.equal(statusOf(revoked.text), 407, 'a released token is refused');
      assert.equal(proxy.activeJobs, 0);
    } finally {
      await proxy.close();
    }
  });

  it('expires tokens and keeps jobs apart', async () => {
    const proxy = new MediaEgressProxy({ ...permitLocal, log: () => {} });
    try {
      const short = await proxy.issue(20);
      const other = await proxy.issue(60_000);
      assert.notEqual(new URL(short.proxyUrl).password, new URL(other.proxyUrl).password);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const port = proxyPort(short.proxyUrl);
      const target = `127.0.0.1:${echoPort}`;
      const expired = await raw(port, `CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: ${credentials(short.proxyUrl)}\r\n\r\n`);
      assert.equal(statusOf(expired.text), 407);
      // Releasing one job does not affect another.
      short.release();
      const live = await raw(port, `CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: ${credentials(other.proxyUrl)}\r\n\r\n`);
      assert.equal(statusOf(live.text), 200);
      live.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it('tunnels CONNECT to an approved destination and closes it on release', async () => {
    const proxy = new MediaEgressProxy({ ...permitLocal, log: () => {} });
    try {
      const job = await proxy.issue(60_000);
      const { text, socket } = await raw(
        proxyPort(job.proxyUrl),
        `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`,
      );
      assert.equal(statusOf(text), 200);
      socket.write('ping');
      const [reply] = await once(socket, 'data') as [Buffer];
      assert.equal(reply.toString(), 'ping');
      const closed = once(socket, 'close');
      job.release();
      await closed;
    } finally {
      await proxy.close();
    }
  });

  it('connects only to the answers the policy approves', async () => {
    const proxy = new MediaEgressProxy({
      ...permitLocal,
      resolve: async () => ['10.0.0.1', '127.0.0.1'],
      log: () => {},
    });
    try {
      const job = await proxy.issue(60_000);
      const { text, socket } = await raw(
        proxyPort(job.proxyUrl),
        `CONNECT media.test:${echoPort} HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`,
      );
      assert.equal(statusOf(text), 200, 'the private answer is dropped and the approved one used');
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it('refuses destinations the policy does not allow, and ports other than 80 and 443', async () => {
    const logs: string[] = [];
    const proxy = new MediaEgressProxy({ resolve: async () => ['192.168.1.20'], log: (m) => logs.push(m) });
    try {
      const job = await proxy.issue(60_000);
      const port = proxyPort(job.proxyUrl);
      const auth = `Proxy-Authorization: ${credentials(job.proxyUrl)}`;
      const lan = await raw(port, `CONNECT nas.test:443 HTTP/1.1\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(lan.text), 403);
      const portRefused = await raw(port, `CONNECT media.test:8443 HTTP/1.1\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(portRefused.text), 403);
      const literal = await raw(port, `GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(literal.text), 403);
      assert.ok(logs.some((line) => line.includes('nas.test') && line.includes('private address')));
      assert.ok(logs.every((line) => !line.includes(new URL(job.proxyUrl).password)), 'no token in logs');
    } finally {
      await proxy.close();
    }
  });

  it('forwards absolute-form http requests without following redirects', async () => {
    const proxy = new MediaEgressProxy({ ...permitLocal, resolve: async () => ['127.0.0.1'], log: () => {} });
    try {
      webHits = [];
      const job = await proxy.issue(60_000);
      const port = proxyPort(job.proxyUrl);
      const auth = `Proxy-Authorization: ${credentials(job.proxyUrl)}`;
      const ok = await raw(port, `GET http://media.test:${webPort}/track HTTP/1.1\r\nHost: media.test:${webPort}\r\n${auth}\r\n\r\n`, /media bytes/);
      assert.equal(statusOf(ok.text), 200);
      ok.socket.destroy();
      const redirect = await raw(port, `GET http://media.test:${webPort}/redirect HTTP/1.1\r\nHost: media.test:${webPort}\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(redirect.text), 302, 'the redirect goes back to the client');
      redirect.socket.destroy();
      assert.deepEqual(webHits, [`GET /track host=media.test:${webPort} auth=`, `GET /redirect host=media.test:${webPort} auth=`],
        'the job token is not forwarded, and the redirect target was not fetched');

      const relative = await raw(port, `GET /track HTTP/1.1\r\nHost: media.test\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(relative.text), 400);
      const https = await raw(port, `GET https://media.test/ HTTP/1.1\r\nHost: media.test\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(https.text), 400);
    } finally {
      await proxy.close();
    }
  });

  it('limits concurrent connections per job', async () => {
    const proxy = new MediaEgressProxy({ ...permitLocal, log: () => {}, limits: { concurrentPerJob: 1 } });
    try {
      const job = await proxy.issue(60_000);
      const port = proxyPort(job.proxyUrl);
      const request = `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`;
      const first = await raw(port, request);
      assert.equal(statusOf(first.text), 200);
      const second = await raw(port, request);
      assert.equal(statusOf(second.text), 429);
      first.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it('chains through an upstream proxy by approved address, not by name', async () => {
    const seen: string[] = [];
    const upstream = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        seen.push(chunk.toString('latin1').split('\r\n').filter((l) => /^(CONNECT|Proxy-Authorization)/.test(l)).join(' | '));
        const target = net.connect(echoPort, '127.0.0.1', () => {
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
          socket.pipe(target);
          target.pipe(socket);
        });
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const proxy = new MediaEgressProxy({
      upstream: { host: '127.0.0.1', port: (upstream.address() as net.AddressInfo).port, authorization: 'Basic dXA6c2VjcmV0' },
      resolve: async () => ['93.184.215.14'],
      log: () => {},
    });
    try {
      const job = await proxy.issue(60_000);
      const { text, socket } = await raw(
        proxyPort(job.proxyUrl),
        `CONNECT media.test:443 HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`,
      );
      assert.equal(statusOf(text), 200);
      socket.destroy();
      assert.deepEqual(seen, ['CONNECT 93.184.215.14:443 HTTP/1.1 | Proxy-Authorization: Basic dXA6c2VjcmV0']);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it('sends plain http through an upstream proxy as a tunnel to the approved address, keeping its Host', async () => {
    const seen: string[] = [];
    const upstream = net.createServer((socket) => {
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString('latin1');
        if (!seen.length && buffered.includes('\r\n\r\n')) {
          seen.push(buffered.split('\r\n')[0]);
          buffered = buffered.slice(buffered.indexOf('\r\n\r\n') + 4);
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        }
        if (seen.length === 1 && buffered.includes('\r\n\r\n')) {
          const lines = buffered.split('\r\n');
          seen.push(`${lines[0]} | ${lines.find((l) => /^host:/i.test(l))}`);
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
        }
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const proxy = new MediaEgressProxy({
      upstream: { host: '127.0.0.1', port: (upstream.address() as net.AddressInfo).port },
      resolve: async () => ['93.184.215.14'],
      log: () => {},
    });
    try {
      const job = await proxy.issue(60_000);
      const { text, socket } = await raw(
        proxyPort(job.proxyUrl),
        `GET http://media.test/track.mp3?x=1 HTTP/1.1\r\nHost: media.test\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`,
        /\r\n\r\nok$/,
      );
      assert.equal(statusOf(text), 200);
      assert.match(text, /\r\n\r\nok$/);
      socket.destroy();
      assert.deepEqual(seen, ['CONNECT 93.184.215.14:80 HTTP/1.1', 'GET /track.mp3?x=1 HTTP/1.1 | host: media.test']);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it('answers 502 instead of failing on an invalid upstream status, and cuts off truncated bodies', async () => {
    const origin = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        if (chunk.toString().startsWith('GET /bad-status')) socket.end('HTTP/1.1 099 Odd\r\nContent-Length: 0\r\n\r\n');
        else { socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial'); setTimeout(() => socket.destroy(), 20); }
      });
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const port = (origin.address() as net.AddressInfo).port;
    const proxy = new MediaEgressProxy({ ...permitLocal, resolve: async () => ['127.0.0.1'], log: () => {} });
    try {
      const job = await proxy.issue(60_000);
      const auth = `Proxy-Authorization: ${credentials(job.proxyUrl)}`;
      const bad = await raw(proxyPort(job.proxyUrl), `GET http://media.test:${port}/bad-status HTTP/1.1\r\nHost: media.test\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(bad.text), 502);
      bad.socket.destroy();
      const cut = await raw(proxyPort(job.proxyUrl), `GET http://media.test:${port}/cut HTTP/1.1\r\nHost: media.test\r\n${auth}\r\n\r\n`, /$^/);
      assert.equal(statusOf(cut.text), 200);
      assert.ok(cut.socket.destroyed || cut.socket.readableEnded, 'the client connection is closed, not left waiting');
      // The proxy still serves requests afterwards.
      const after = await raw(proxyPort(job.proxyUrl), `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(after.text), 200);
      after.socket.destroy();
    } finally {
      await proxy.close();
      origin.close();
    }
  });

  it('forwards only GET and HEAD without a body', async () => {
    const proxy = new MediaEgressProxy({ ...permitLocal, resolve: async () => ['127.0.0.1'], log: () => {} });
    try {
      const job = await proxy.issue(60_000);
      const auth = `Proxy-Authorization: ${credentials(job.proxyUrl)}`;
      const post = await raw(proxyPort(job.proxyUrl), `POST http://media.test:${webPort}/ HTTP/1.1\r\nHost: media.test\r\nContent-Length: 0\r\n${auth}\r\n\r\n`);
      assert.equal(statusOf(post.text), 405);
      const body = await raw(proxyPort(job.proxyUrl), `GET http://media.test:${webPort}/ HTTP/1.1\r\nHost: media.test\r\nContent-Length: 3\r\n${auth}\r\n\r\nabc`);
      assert.equal(statusOf(body.text), 400);
    } finally {
      await proxy.close();
    }
  });

  it('counts connections still being set up against the limits, and cancels them on release', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const proxy = new MediaEgressProxy({
      ...permitLocal,
      resolve: async () => { await blocked; return ['127.0.0.1']; },
      log: () => {},
      limits: { concurrentPerJob: 1, concurrentTotal: 2 },
    });
    try {
      const job = await proxy.issue(60_000);
      const port = proxyPort(job.proxyUrl);
      const request = `CONNECT media.test:${echoPort} HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`;
      const first = raw(port, request);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await raw(port, request);
      assert.equal(statusOf(second.text), 429, 'refused while the first is still resolving');
      // Another job is limited by the shared cap too.
      const other = await proxy.issue(60_000);
      const third = raw(port, `CONNECT media.test:${echoPort} HTTP/1.1\r\nProxy-Authorization: ${credentials(other.proxyUrl)}\r\n\r\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const yetAnother = await proxy.issue(60_000);
      const fourth = await raw(port, `CONNECT media.test:${echoPort} HTTP/1.1\r\nProxy-Authorization: ${credentials(yetAnother.proxyUrl)}\r\n\r\n`);
      assert.equal(statusOf(fourth.text), 429, 'the cap across jobs applies');
      job.release();
      unblock();
      const cancelled = await first;
      assert.notEqual(statusOf(cancelled.text), 200, 'a released job gets no tunnel');
      const allowed = await third;
      assert.equal(statusOf(allowed.text), 200);
      allowed.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it('frees a connection at once when its client leaves or its job ends during setup', async () => {
    // DNS that only finishes when cancelled.
    const hanging = (_host: string, signal: AbortSignal) => new Promise<string[]>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    const proxy = new MediaEgressProxy({ ...permitLocal, resolve: hanging, log: () => {} });
    const settle = async () => { for (let i = 0; i < 50 && proxy.activeConnections > 0; i++) await new Promise((r) => setTimeout(r, 5)); };
    try {
      const job = await proxy.issue(60_000);
      const port = proxyPort(job.proxyUrl);
      const auth = `Proxy-Authorization: ${credentials(job.proxyUrl)}`;
      for (const request of [`CONNECT media.test:443 HTTP/1.1\r\n${auth}\r\n\r\n`, `GET http://media.test/a HTTP/1.1\r\nHost: media.test\r\n${auth}\r\n\r\n`]) {
        const socket = net.connect(port, '127.0.0.1');
        await once(socket, 'connect');
        socket.write(request);
        for (let i = 0; i < 50 && proxy.activeConnections === 0; i++) await new Promise((r) => setTimeout(r, 5));
        assert.equal(proxy.activeConnections, 1);
        socket.destroy();
        await settle();
        assert.equal(proxy.activeConnections, 0, 'released when the client left');
      }
      const pending = raw(port, `CONNECT media.test:443 HTTP/1.1\r\n${auth}\r\n\r\n`);
      for (let i = 0; i < 50 && proxy.activeConnections === 0; i++) await new Promise((r) => setTimeout(r, 5));
      job.release();
      await settle();
      assert.equal(proxy.activeConnections, 0, 'released when the job ended');
      assert.notEqual(statusOf((await pending).text), 200);
    } finally {
      await proxy.close();
    }
  });

  it('stops waiting for an upstream proxy that never answers when the job ends', async () => {
    const silent = net.createServer(() => { /* accepts and never answers */ });
    silent.listen(0, '127.0.0.1');
    await once(silent, 'listening');
    const proxy = new MediaEgressProxy({
      upstream: { host: '127.0.0.1', port: (silent.address() as net.AddressInfo).port },
      resolve: async () => ['93.184.215.14'],
      log: () => {},
    });
    try {
      const job = await proxy.issue(60_000);
      const pending = raw(proxyPort(job.proxyUrl), `CONNECT media.test:443 HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(proxy.activeConnections, 1);
      job.release();
      for (let i = 0; i < 50 && proxy.activeConnections > 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(proxy.activeConnections, 0);
      assert.notEqual(statusOf((await pending).text), 200);
    } finally {
      await proxy.close();
      silent.close();
    }
  });

  it('answers 502 to an upstream protocol upgrade and frees the connection', async () => {
    const origin = net.createServer((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: other\r\nConnection: Upgrade\r\n\r\n'));
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const port = (origin.address() as net.AddressInfo).port;
    const proxy = new MediaEgressProxy({ ...permitLocal, resolve: async () => ['127.0.0.1'], log: () => {} });
    try {
      const job = await proxy.issue(60_000);
      const reply = await raw(proxyPort(job.proxyUrl), `GET http://media.test:${port}/ HTTP/1.1\r\nHost: media.test\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`);
      assert.equal(statusOf(reply.text), 502);
      reply.socket.destroy();
      for (let i = 0; i < 50 && proxy.activeConnections > 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(proxy.activeConnections, 0);
    } finally {
      await proxy.close();
      origin.close();
    }
  });

  it('forwards bytes a client sends before the tunnel is ready, in order, and refuses too many', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const proxy = new MediaEgressProxy({ ...permitLocal, resolve: async () => { await blocked; return ['127.0.0.1']; }, log: () => {} });
    try {
      const job = await proxy.issue(60_000);
      const port = proxyPort(job.proxyUrl);
      const auth = `Proxy-Authorization: ${credentials(job.proxyUrl)}`;
      const socket = net.connect(port, '127.0.0.1');
      await once(socket, 'connect');
      // The request and early data in several pieces, before the proxy has resolved anything.
      socket.write(`CONNECT media.test:${echoPort} HTTP/1.1\r\n${auth}\r\n\r\none-`);
      await new Promise((r) => setTimeout(r, 10));
      socket.write('two-');
      await new Promise((r) => setTimeout(r, 10));
      socket.write('three');
      let text = '';
      socket.on('data', (chunk) => { text += chunk.toString('latin1'); });
      unblock();
      for (let i = 0; i < 100 && !text.endsWith('one-two-three'); i++) await new Promise((r) => setTimeout(r, 5));
      assert.match(text, /^HTTP\/1\.1 200 [^\r]*\r\n\r\none-two-three$/);
      socket.destroy();

    } finally {
      await proxy.close();
    }
    // A resolver that never answers keeps the tunnel in setup while the client floods it.
    const stalled = new MediaEgressProxy({
      ...permitLocal,
      resolve: (_host, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))),
      log: () => {},
    });
    try {
      const job = await stalled.issue(60_000);
      const flood = net.connect(proxyPort(job.proxyUrl), '127.0.0.1');
      await once(flood, 'connect');
      flood.on('error', () => {});
      flood.write(`CONNECT slow.test:${echoPort} HTTP/1.1\r\nProxy-Authorization: ${credentials(job.proxyUrl)}\r\n\r\n`);
      flood.write(Buffer.alloc(70_000));
      const closed = await Promise.race([once(flood, 'close').then(() => true), new Promise((r) => setTimeout(() => r(false), 2_000))]);
      assert.equal(closed, true, 'more than 64 KiB before the tunnel closes the connection');
      for (let i = 0; i < 50 && stalled.activeConnections > 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(stalled.activeConnections, 0);
    } finally {
      await stalled.close();
    }
  });

  it('redacts the job token from text', async () => {
    const proxy = new MediaEgressProxy({ log: () => {} });
    try {
      const job = await proxy.issue(60_000);
      const token = new URL(job.proxyUrl).password;
      assert.equal(token.length, 64);
      assert.equal(job.redact(`ERROR: proxy ${job.proxyUrl} failed`).includes(token), false);
    } finally {
      await proxy.close();
    }
  });

  it('parses CONNECT targets', () => {
    assert.deepEqual(parseAuthority('media.test:443'), { host: 'media.test', port: 443 });
    assert.deepEqual(parseAuthority('[2001:db8::1]:443'), { host: '[2001:db8::1]', port: 443 });
    assert.equal(parseAuthority('media.test'), null);
    assert.equal(parseAuthority('media.test:0'), null);
    assert.equal(parseAuthority('http://media.test:443'), null);
  });
});
