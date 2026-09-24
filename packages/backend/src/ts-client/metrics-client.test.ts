import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  createMetricsClient,
  METRICS_MAX_BYTES,
  METRICS_PATH,
} from './metrics-client.js';

describe('MetricsClient', () => {
  it('scrapes /metrics over HTTP without auth headers', async () => {
    let sawAuth = false;
    let method = '';
    let path = '';
    const server = createServer((req, res) => {
      method = req.method || '';
      path = req.url || '';
      if (req.headers['x-api-key'] || req.headers.authorization) sawAuth = true;
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end('# placeholder body for transport test\nexample 1\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const client = createMetricsClient('127.0.0.1', address.port);
    try {
      const result = await client.scrape();
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.match(result.body, /placeholder/);
        assert.match(result.contentType, /text\/plain/);
      }
      assert.equal(method, 'GET');
      assert.equal(path, METRICS_PATH);
      assert.equal(sawAuth, false);
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('rejects non-text/plain content types', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"no":"metrics"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const client = createMetricsClient('127.0.0.1', address.port);
    try {
      const result = await client.scrape();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'invalid');
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('rejects redirects', async () => {
    const server = createServer((req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1/evil' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const client = createMetricsClient('127.0.0.1', address.port);
    try {
      const result = await client.scrape();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'invalid');
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('reports unreachable for refused connections', async () => {
    const client = createMetricsClient('127.0.0.1', 9);
    try {
      const result = await client.scrape();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'unreachable');
    } finally {
      client.destroy();
    }
  });

  it('rejects blocked metadata hosts at construction', () => {
    assert.throws(() => createMetricsClient('169.254.169.254', 9187));
  });

  it('rejects oversized responses', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('x'.repeat(METRICS_MAX_BYTES + 64));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const client = createMetricsClient('127.0.0.1', address.port);
    try {
      const result = await client.scrape();
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.reason === 'invalid' || result.reason === 'unreachable');
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('honours AbortSignal cancellation without waiting for a hanging scrape', async () => {
    const server = createServer((_req, _res) => {
      // Never respond — scrape must be abortable.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const client = createMetricsClient('127.0.0.1', address.port);
    const ac = new AbortController();
    try {
      const scrapePromise = client.scrape(ac.signal);
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      const result = await scrapePromise;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'timeout');
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('cancelPending aborts in-flight scrapes', async () => {
    const server = createServer((_req, _res) => {
      // hang
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const client = createMetricsClient('127.0.0.1', address.port);
    try {
      const scrapePromise = client.scrape();
      await new Promise((r) => setTimeout(r, 50));
      client.cancelPending();
      const result = await scrapePromise;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'timeout');
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
