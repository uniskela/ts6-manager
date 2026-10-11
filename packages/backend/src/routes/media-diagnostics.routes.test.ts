import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import type { MediaAdminDiagnosticReport } from '@ts6/common';
import { errorHandler } from '../middleware/error-handler.js';
import { settingsRoutes } from './settings.routes.js';

function appFor(role: 'admin' | 'viewer', diagnose?: () => Promise<MediaAdminDiagnosticReport>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { role: string } }).user = { role };
    next();
  });
  if (diagnose) app.locals.diagnoseMediaAdmin = diagnose;
  app.use('/api/settings', settingsRoutes);
  app.use(errorHandler);
  return app;
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('GET /api/settings/media-diagnostics', () => {
  it('redacts credentials before the response is sent', async () => {
    const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
    const app = appFor('admin', async () => ({
      checkedAt: '2026-01-01T00:00:00.000Z',
      overall: 'fail',
      checks: [{
        id: 'ffmpeg',
        label: 'FFmpeg',
        status: 'fail',
        message: `Authorization: Bearer ${jwt}`,
      }],
      sidecar: { mode: 'url', status: 'ok', message: 'cookie=netscape-secret-value' },
      encoders: { status: 'ok', message: 'ok', items: [] },
      warnings: ['password=hunter2'],
    }));
    const server = await listen(app);
    try {
      const res = await fetch(`${server.base}/api/settings/media-diagnostics`);
      const body = await res.text();
      assert.equal(res.status, 200);
      assert.equal(body.includes(jwt), false);
      assert.equal(body.includes('hunter2'), false);
      assert.equal(body.includes('netscape-secret-value'), false);
      assert.match(body, /\[redacted/);
    } finally {
      await server.close();
    }
  });

  it('rejects viewers before running any probes', async () => {
    let probes = 0;
    const app = appFor('viewer', async () => {
      probes += 1;
      throw new Error('must not run');
    });
    const server = await listen(app);
    try {
      const res = await fetch(`${server.base}/api/settings/media-diagnostics`);
      assert.equal(res.status, 403);
      const body = await res.json() as { error?: string };
      assert.match(body.error || '', /Admin/);
      assert.equal(probes, 0);
    } finally {
      await server.close();
    }
  });
});
