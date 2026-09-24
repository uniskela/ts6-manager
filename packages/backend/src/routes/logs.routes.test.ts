import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import express, { type Express } from 'express';
import { logRoutes, resetLogviewInflightForTests } from './logs.routes.js';
import { errorHandler, TSApiError } from '../middleware/error-handler.js';

function buildApp(options: {
  role?: 'admin' | 'moderator' | 'viewer';
  execute?: (sid: number, command: string, params?: Record<string, unknown>) => Promise<unknown>;
}): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: 1,
      role: options.role ?? 'admin',
      username: 'tester',
    };
    req.app.locals.connectionPool = {
      getClient: () => ({
        execute: options.execute ?? (async () => ([
          { last_pos: '50', file_size: '80', l: '2026-01-01 00:00:00.000000|INFO    |VirtualServer |1  |ok' },
        ])),
      }),
    };
    next();
  });
  app.use('/api/servers/:configId/vs/:sid/logs', logRoutes);
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

describe('logs routes', () => {
  beforeEach(() => {
    resetLogviewInflightForTests();
  });

  it('requires admin role', async () => {
    const app = buildApp({ role: 'viewer' });
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/servers/1/vs/1/logs`);
      assert.equal(response.status, 403);
    } finally {
      await close();
    }
  });

  it('rejects oversized and malformed query params', async () => {
    const app = buildApp({});
    const { base, close } = await listen(app);
    try {
      const oversized = await fetch(`${base}/api/servers/1/vs/1/logs?lines=500`);
      assert.equal(oversized.status, 400);
      const badCursor = await fetch(`${base}/api/servers/1/vs/1/logs?begin_pos=nope`);
      assert.equal(badCursor.status, 400);
    } finally {
      await close();
    }
  });

  it('returns a typed page envelope and forwards verified params', async () => {
    const calls: Array<{ sid: number; command: string; params?: Record<string, unknown> }> = [];
    const app = buildApp({
      execute: async (sid, command, params) => {
        calls.push({ sid, command, params });
        return [
          { last_pos: '40', file_size: '90', l: 'line-a' },
          { last_pos: '10', file_size: '90', l: 'line-b' },
        ];
      },
    });
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/servers/7/vs/3/logs?lines=50&reverse=1&instance=1&begin_pos=40`);
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.context.configId, 7);
      assert.equal(body.context.sid, 3);
      assert.equal(body.context.instance, true);
      assert.equal(body.context.lines, 50);
      assert.equal(body.context.beginPos, '40');
      assert.equal(body.nextBeginPos, '10');
      assert.equal(body.fileSize, '90');
      assert.equal(body.entries.length, 2);
      assert.equal(body.entries[0].sourceText, 'line-a');
      assert.equal(body.total, undefined);
      assert.deepEqual(calls[0], {
        sid: 0,
        command: 'logview',
        params: { lines: 50, reverse: 1, instance: 1, begin_pos: '40' },
      });
    } finally {
      await close();
    }
  });

  it('forwards virtual-server logview on the selected sid when instance=0', async () => {
    const calls: Array<{ sid: number; command: string; params?: Record<string, unknown> }> = [];
    const app = buildApp({
      execute: async (sid, command, params) => {
        calls.push({ sid, command, params });
        return [{ last_pos: '10', file_size: '10', l: 'vs-line' }];
      },
    });
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/servers/2/vs/5/logs?lines=50&instance=0`);
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.context.sid, 5);
      assert.equal(body.context.instance, false);
      assert.deepEqual(calls[0], {
        sid: 5,
        command: 'logview',
        params: { lines: 50, reverse: 1, instance: 0 },
      });
    } finally {
      await close();
    }
  });

  it('maps TeamSpeak logview I/O error 2052 to a clear reason (not generic API Error)', async () => {
    const app = buildApp({
      execute: async () => {
        throw new TSApiError(2052, 'file input/output error');
      },
    });
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/servers/1/vs/1/logs?lines=100&reverse=1&instance=0`);
      assert.equal(response.status, 502);
      const body = await response.json() as any;
      assert.equal(body.reason, 'ts_logview_io');
      assert.equal(body.code, 2052);
      assert.equal(body.error, 'TeamSpeak log file unavailable');
      assert.match(String(body.details), /logfile|permission|lock|rotation/i);
      assert.notEqual(body.error, 'TeamSpeak API Error');
    } finally {
      await close();
    }
  });

  it('coalesces overlapping identical logview requests into one TeamSpeak call', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = buildApp({
      execute: async () => {
        started += 1;
        await gate;
        return [{ last_pos: '10', file_size: '10', l: 'shared' }];
      },
    });
    const { base, close } = await listen(app);
    try {
      const url = `${base}/api/servers/1/vs/1/logs?lines=100&reverse=1&instance=0`;
      const pending = Promise.all([fetch(url), fetch(url), fetch(url)]);
      // Let both requests enter the route and hit coalesce before releasing TS.
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(started, 1);
      release();
      const responses = await pending;
      assert.deepEqual(responses.map((r) => r.status), [200, 200, 200]);
      assert.equal(started, 1);
    } finally {
      await close();
    }
  });
});
