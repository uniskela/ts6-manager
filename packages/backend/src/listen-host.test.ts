import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  isLoopbackListenHost,
  listenHttpServer,
  resolveListenHost,
} from './listen-host.js';

test('resolveListenHost: absent → undefined (all-interfaces default)', () => {
  assert.equal(resolveListenHost({}), undefined);
  assert.equal(resolveListenHost({ LISTEN_HOST: '', HOST: '' }), undefined);
  assert.equal(resolveListenHost({ LISTEN_HOST: '  ' }), undefined);
});

test('resolveListenHost: LISTEN_HOST wins over HOST', () => {
  assert.equal(resolveListenHost({ LISTEN_HOST: '127.0.0.1', HOST: '0.0.0.0' }), '127.0.0.1');
  assert.equal(resolveListenHost({ HOST: '127.0.0.1' }), '127.0.0.1');
});

test('isLoopbackListenHost', () => {
  assert.equal(isLoopbackListenHost(undefined), false);
  assert.equal(isLoopbackListenHost('0.0.0.0'), false);
  assert.equal(isLoopbackListenHost('127.0.0.1'), true);
  assert.equal(isLoopbackListenHost('::1'), true);
  assert.equal(isLoopbackListenHost('localhost'), true);
});

test('listenHttpServer: explicit localhost binds 127.0.0.1 only', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    listenHttpServer(server, 0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(addr.port > 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('listenHttpServer: omitted host preserves default listen(port) behaviour', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    listenHttpServer(server, 0, undefined, () => resolve());
    server.on('error', reject);
  });
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    // Node may report IPv6 wildcard (::) or IPv4 0.0.0.0 depending on dual-stack.
    assert.notEqual(addr.address, '127.0.0.1');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
