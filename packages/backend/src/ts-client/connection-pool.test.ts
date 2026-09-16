import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionPool } from './connection-pool.js';

describe('ConnectionPool startup validation', () => {
  const createPrisma = () => ({
    tsServerConfig: {
      findMany: async () => ([{
        id: 1,
        host: '127.0.0.1',
        webqueryPort: 10080,
        apiKey: 'saved-key',
        useHttps: false,
        enabled: true,
      }]),
    },
  });

  it('tests each persisted WebQuery client once during initialize', async () => {
    let testCalls = 0;
    const fakeClient = {
      testConnection: async () => {
        testCalls++;
        return { ok: false as const, error: 'invalid apikey' };
      },
      destroy: () => undefined,
    };

    const pool = new ConnectionPool(createPrisma() as any);
    (pool as any).addClient = (id: number) => {
      (pool as any).clients.set(id, fakeClient);
    };

    await pool.initialize();

    assert.equal(testCalls, 1);
  });

  it('does not block initialization while credential validation is pending', async () => {
    let testCalls = 0;
    const fakeClient = {
      testConnection: async () => {
        testCalls++;
        return await new Promise<never>(() => undefined);
      },
      destroy: () => undefined,
    };

    const pool = new ConnectionPool(createPrisma() as any);
    (pool as any).addClient = (id: number) => {
      (pool as any).clients.set(id, fakeClient);
    };

    const result = await Promise.race([
      pool.initialize().then(() => 'initialized'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 25)),
    ]);

    assert.equal(testCalls, 1);
    assert.equal(result, 'initialized');
  });
});
