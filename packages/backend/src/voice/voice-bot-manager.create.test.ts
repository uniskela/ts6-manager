import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceBotManager } from './voice-bot-manager.js';

test('createBot returns after DB insert without awaiting level-23 keygen', async () => {
  let upgradeScheduledFor: number | null = null;
  let upgradeResolve!: () => void;
  const upgradeGate = new Promise<void>((resolve) => {
    upgradeResolve = resolve;
  });

  const prisma = {
    appSetting: {
      findUnique: async () => ({ value: '10' }),
    },
    musicBot: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        assert.ok(typeof data.identityData === 'string' && data.identityData.length > 0,
          'create should persist a fast placeholder identity');
        return {
          id: 42,
          name: data.name,
          nickname: data.nickname,
          serverPassword: data.serverPassword ?? null,
          defaultChannel: data.defaultChannel ?? null,
          channelPassword: data.channelPassword ?? null,
          voicePort: data.voicePort,
          volume: data.volume,
          serverConfigId: data.serverConfigId,
        };
      },
      update: async () => {
        throw new Error('level-23 persist must not run before create returns');
      },
    },
    tsServerConfig: {
      findUnique: async () => ({ id: 1, host: '127.0.0.1' }),
    },
  };

  const manager = new VoiceBotManager(prisma as any, { clients: new Set() } as any);
  (manager as any).scheduleIdentityUpgrade = (botId: number) => {
    upgradeScheduledFor = botId;
    (manager as any).identityJobs.set(botId, upgradeGate);
  };

  const started = Date.now();
  const result = await manager.createBot({
    name: 'CoolBot1',
    serverConfigId: 1,
  });
  const elapsed = Date.now() - started;

  assert.deepEqual(result, { id: 42 });
  assert.equal(upgradeScheduledFor, 42);
  assert.ok(elapsed < 2000, `createBot should return quickly, took ${elapsed}ms`);

  upgradeResolve();
  await upgradeGate;
});
