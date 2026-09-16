import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reloadEnabledServerFlows } from './server-connection-refresh.js';

describe('reloadEnabledServerFlows', () => {
  it('reloads only enabled flows bound to the refreshed server config', async () => {
    const queries: any[] = [];
    const reloaded: number[] = [];
    const prisma = {
      botFlow: {
        findMany: async (query: any) => {
          queries.push(query);
          return [{ id: 3 }, { id: 7 }];
        },
      },
    };
    const botEngine = {
      reloadFlow: async (flowId: number) => {
        reloaded.push(flowId);
      },
    };

    await reloadEnabledServerFlows(prisma as any, botEngine as any, 42);

    assert.deepEqual(queries, [{
      where: { serverConfigId: 42, enabled: true },
      select: { id: true },
    }]);
    assert.deepEqual(reloaded, [3, 7]);
  });
});
