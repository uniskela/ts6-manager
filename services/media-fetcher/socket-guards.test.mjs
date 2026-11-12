/**
 * Regression: backend /stop destroys the Job API socket while PCM is flowing.
 * Without an immediate `error` listener the fetcher dies on ECONNRESET.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { describe, it } from 'node:test';
import {
  attachClientSocketLifecycle,
  EXPECTED_CLIENT_DISCONNECT_CODES,
  formatClientSocketError,
  isExpectedClientDisconnect,
} from './socket-guards.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mirrors fetcher.mjs finish() idempotency for concurrent cancel/close/exit. */
function makeFinish(jobs) {
  return async function finish(job) {
    if (!job || job.done) return;
    job.done = true;
    if (job.child?.pid) {
      try { process.kill(job.child.pid, 0); job.killed = true; } catch { /* gone */ }
    }
    job.proxyRevoked = true;
    jobs.delete(job.id);
  };
}

describe('isExpectedClientDisconnect', () => {
  it('accepts known teardown codes only', () => {
    for (const code of EXPECTED_CLIENT_DISCONNECT_CODES) {
      assert.equal(isExpectedClientDisconnect({ code }), true);
    }
    assert.equal(isExpectedClientDisconnect({ code: 'ECONNRESET' }), true);
    assert.equal(isExpectedClientDisconnect({ code: 'ENOENT' }), false);
    assert.equal(isExpectedClientDisconnect(new Error('boom')), false);
    assert.equal(isExpectedClientDisconnect(null), false);
  });
});

describe('attachClientSocketLifecycle', () => {
  it('prevents uncaught ECONNRESET when the peer destroys mid-write ( /stop )', async () => {
    const uncaught = [];
    const onUnc = (err) => { uncaught.push(err.code || err.message); };
    process.on('uncaughtException', onUnc);

    const logs = [];
    const teardowns = [];
    const server = net.createServer((socket) => {
      attachClientSocketLifecycle(socket, {
        onTeardown: (reason) => { teardowns.push(reason); },
        log: (line) => { logs.push(line); },
      });
      socket.on('data', () => {});
      // Production pumps ffmpeg stdout → socket.write; try/catch alone is not enough.
      const iv = setInterval(() => {
        try { socket.write(Buffer.alloc(64 * 1024, 1)); } catch { /* closed */ }
      }, 1);
      socket.on('close', () => clearInterval(iv));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const client = net.connect({ host: '127.0.0.1', port });
    await once(client, 'connect');
    await sleep(40);
    client.destroy();
    await sleep(150);
    server.close();
    process.off('uncaughtException', onUnc);

    assert.equal(uncaught.length, 0, `uncaught: ${uncaught}`);
    assert.ok(teardowns.length >= 1);
    assert.equal(teardowns.length, 1, 'teardown must run once');
    assert.match(logs.join('\n'), /FETCHER client disconnect ECONNRESET|EPIPE/);
  });

  it('crashes without a guard (documents the live failure mode)', async () => {
    const { spawnSync } = await import('node:child_process');
    const script = `
      import net from 'node:net';
      import { once } from 'node:events';
      const server = net.createServer((socket) => {
        socket.on('data', () => {});
        const iv = setInterval(() => { socket.write(Buffer.alloc(64 * 1024, 2)); }, 1);
        socket.on('close', () => clearInterval(iv));
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const client = net.connect({ host: '127.0.0.1', port: server.address().port });
      await once(client, 'connect');
      await new Promise((r) => setTimeout(r, 40));
      client.destroy();
      await new Promise((r) => setTimeout(r, 200));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0, 'unguarded peer destroy must kill the process');
    assert.match(`${result.stderr}\n${result.stdout}`, /ECONNRESET/);
  });

  it('runs teardown once across concurrent error + close', async () => {
    const reasons = [];
    const { EventEmitter } = await import('node:events');
    const socket = new EventEmitter();
    socket.on = EventEmitter.prototype.on.bind(socket);
    const life = attachClientSocketLifecycle(socket, {
      onTeardown: (r) => { reasons.push(r); },
      log: () => {},
    });
    socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    socket.emit('close');
    socket.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.deepEqual(reasons, ['error']);
    assert.equal(life.done, true);
    assert.equal(life.teardown('manual'), false);
  });

  it('logs unexpected failures without treating them as disconnect', async () => {
    const logs = [];
    const reasons = [];
    const { EventEmitter } = await import('node:events');
    const socket = new EventEmitter();
    attachClientSocketLifecycle(socket, {
      onTeardown: (r) => { reasons.push(r); },
      log: (line) => { logs.push(line); },
    });
    socket.emit('error', Object.assign(
      new Error('connect EACCES https://secret.example/token=abc'),
      { code: 'EACCES', errno: -13 },
    ));
    assert.deepEqual(reasons, ['error']);
    assert.equal(logs[0], formatClientSocketError({ code: 'EACCES', errno: -13 }));
    assert.match(logs[0], /FETCHER client-socket error EACCES errno=-13/);
    assert.doesNotMatch(logs.join('\n'), /token|secret\.example|https?:\/\//i);
  });
});

describe('formatClientSocketError', () => {
  it('never includes err.message', () => {
    const line = formatClientSocketError({
      code: 'EPROTO',
      errno: -71,
      message: 'write https://user:pass@host/path?token=xyz failed',
    });
    assert.equal(line, 'FETCHER client-socket error EPROTO errno=-71');
    assert.doesNotMatch(line, /user:pass|token=|https?:\/\//i);
  });
});

describe('stop / cancel / exit cleanup (finish idempotency)', () => {
  it('normal stop: destroy + cancel + child close leave no job', async () => {
    const jobs = new Map();
    const finish = makeFinish(jobs);
    const job = { id: 'stop1', child: { pid: process.pid }, done: false };
    jobs.set(job.id, job);

    // Order mirrors media-fetcher-client kill(): destroy peer, then cancel RPC.
    await finish(job); // cancel path
    await finish(job); // socket close/error path
    await finish(job); // ffmpeg exit path
    assert.equal(jobs.size, 0);
    assert.equal(job.done, true);
    assert.equal(job.proxyRevoked, true);
  });

  it('abrupt disconnect during stream cleans job and allows a new one', async () => {
    const jobs = new Map();
    const finish = makeFinish(jobs);
    const first = { id: 'stream1', child: { pid: process.pid }, done: false };
    jobs.set(first.id, first);

    const logs = [];
    const { EventEmitter } = await import('node:events');
    const socket = new EventEmitter();
    attachClientSocketLifecycle(socket, {
      onTeardown: () => { void finish(first); },
      log: (line) => { logs.push(line); },
    });
    socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await sleep(0);
    assert.equal(jobs.has('stream1'), false);
    assert.match(logs[0], /client disconnect ECONNRESET/);

    const second = { id: 'stream2', child: { pid: process.pid }, done: false };
    jobs.set(second.id, second);
    assert.equal(jobs.size, 1);
    await finish(second);
    assert.equal(jobs.size, 0);
  });

  it('concurrent cancel, close, and ffmpeg exit do not revive a finished job', async () => {
    const jobs = new Map();
    const finish = makeFinish(jobs);
    const job = { id: 'race1', child: { pid: process.pid }, done: false };
    jobs.set(job.id, job);
    await Promise.all([finish(job), finish(job), finish(job)]);
    assert.equal(jobs.size, 0);
    assert.equal(job.done, true);
  });
});
