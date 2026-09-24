import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionPool } from './connection-pool.js';

describe('ConnectionPool metrics lifecycle', () => {
  it('does not create a metrics client when metricsEnabled is false', async () => {
    const prisma = {
      tsServerConfig: {
        findMany: async () => ([{
          id: 1,
          host: '127.0.0.1',
          webqueryPort: 10080,
          apiKey: 'saved-key',
          useHttps: false,
          enabled: true,
          isDemo: false,
          metricsEnabled: false,
          metricsPort: 9187,
          metricsHost: null,
        }]),
      },
    };

    const pool = new ConnectionPool(prisma as any);
    (pool as any).addClient = (id: number) => {
      (pool as any).clients.set(id, {
        testConnection: async () => ({ ok: true as const }),
        destroy: () => undefined,
      });
    };

    await pool.initialize();
    assert.equal(pool.getMetricsClient(1), null);
  });

  it('creates a metrics client when metricsEnabled is true', async () => {
    const prisma = {
      tsServerConfig: {
        findMany: async () => ([{
          id: 2,
          host: '127.0.0.1',
          webqueryPort: 10080,
          apiKey: 'saved-key',
          useHttps: false,
          enabled: true,
          isDemo: false,
          metricsEnabled: true,
          metricsPort: 9187,
          metricsHost: null,
        }]),
      },
    };

    const pool = new ConnectionPool(prisma as any);
    (pool as any).addClient = (id: number) => {
      (pool as any).clients.set(id, {
        testConnection: async () => ({ ok: true as const }),
        destroy: () => undefined,
      });
    };

    await pool.initialize();
    const metrics = pool.getMetricsClient(2);
    assert.ok(metrics);
    metrics!.destroy();
  });

  it('never attaches metrics for demo connections', () => {
    const pool = new ConnectionPool({} as any);
    pool.addDemoClient(9);
    pool.syncMetricsClient({
      id: 9,
      host: 'demo.invalid',
      isDemo: true,
      metricsEnabled: true,
      metricsPort: 9187,
    });
    assert.equal(pool.getMetricsClient(9), null);
  });
});
