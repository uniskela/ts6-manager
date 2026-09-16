import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionPool } from './connection-pool.js';

describe('ConnectionPool startup validation', () => {
  it('tests each persisted WebQuery client once during initialize', async () => {
    let testCalls = 0;
    const fakeClient = {
      testConnection: async () => {
        testCalls++;
        return { ok: false as const, error: 'invalid apikey' };
      },
      destroy: () => undefined,
    };

    const prisma = {
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
    };

    const pool = new ConnectionPool(prisma as any);
    (pool as any).addClient = (id: number) => {
      (pool as any).clients.set(id, fakeClient);
    };

    await pool.initialize();

    assert.equal(testCalls, 1);
  });
});
