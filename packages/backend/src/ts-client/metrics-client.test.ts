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
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end('# placeholder — not a real beta13 dump\n');
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
});
