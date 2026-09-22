import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { serverRoutes } from './servers.routes.js';
import { errorHandler, TeamSpeakFloodError } from '../middleware/error-handler.js';
import type { ConnectionDiagnosticReport } from '../ts-client/connection-diagnostics.js';

function buildApp(options: {
  role?: 'admin' | 'moderator' | 'viewer';
  locals?: Record<string, unknown>;
}): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: 1,
      role: options.role ?? 'admin',
      username: 'tester',
    };
    Object.assign(req.app.locals, options.locals ?? {});
    next();
  });
  app.use('/api/servers', serverRoutes);
  app.use(errorHandler);
  return app;
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('servers staged WebQuery diagnostics routes', () => {
  it('demo persisted test short-circuits to full-stage success without a client', async () => {
    const prisma = {
      tsServerConfig: {
        findUnique: async () => ({
          id: 7,
          isDemo: true,
          host: '127.0.0.1',
          webqueryPort: 10080,
          apiKey: 'encrypted-should-not-leak',
          useHttps: false,
        }),
      },
    };
    const app = buildApp({
      locals: {
        prisma,
        connectionPool: {
          getClient: () => {
            throw new Error('pool should not be consulted for demo');
          },
        },
      },
    });
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/servers/7/test`, { method: 'POST' });
      assert.equal(response.status, 200);
      const body = await response.json() as ConnectionDiagnosticReport;
      assert.equal(body.success, true);
      assert.equal(body.partial, false);
      assert.equal(body.overall, 'ok');
      assert.equal(body.version, 'Demo mode');
      assert.equal(body.stages.length, 4);
      assert.ok(body.stages.every((s) => s.status === 'ok'));
      assert.ok(!JSON.stringify(body).includes('encrypted-should-not-leak'));
    } finally {
      await close();
    }
  });

  it('shared flood cooldown returns staged flood report with HTTP 200', async () => {
    const prisma = {
      tsServerConfig: {
        findUnique: async () => ({
          id: 3,
          isDemo: false,
          host: '127.0.0.1',
          webqueryPort: 10080,
          apiKey: 'encrypted-should-not-leak',
          useHttps: false,
        }),
      },
    };
    const app = buildApp({
      locals: {
        prisma,
        connectionPool: {
          getClient: () => ({
            getFloodCooldownRemainingMs: () => 45_000,
          }),
        },
      },
    });
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/servers/3/test`, { method: 'POST' });
      assert.equal(response.status, 200);
      const body = await response.json() as ConnectionDiagnosticReport;
      assert.equal(body.success, false);
      assert.equal(body.stages[0].code, 'flood');
      assert.equal(body.stages[0].status, 'fail');
      assert.ok(body.stages.slice(1).every((s) => s.status === 'skipped'));
      assert.ok(!JSON.stringify(body).includes('encrypted-should-not-leak'));
      // Ensure we did not fall through to TeamSpeakFloodError HTTP 429 path.
      assert.notEqual(response.status, 429);
      void TeamSpeakFloodError;
    } finally {
      await close();
    }
  });

  it('rejects non-admin draft webquery tests', async () => {
    const app = buildApp({ role: 'viewer' });
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/servers/test-webquery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: '127.0.0.1',
          webqueryPort: 10080,
          apiKey: 'secret-key-should-not-echo',
        }),
      });
      assert.equal(response.status, 403);
      const body = await response.json() as { error?: string };
      assert.ok(body.error);
      assert.ok(!JSON.stringify(body).includes('secret-key-should-not-echo'));
    } finally {
      await close();
    }
  });

  it('draft test-webquery requires host and api key', async () => {
    const app = buildApp({});
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/servers/test-webquery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1' }),
      });
      assert.equal(response.status, 400);
      const body = await response.json() as { error?: string };
      assert.match(String(body.error), /api key/i);
    } finally {
      await close();
    }
  });
});
