import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'events';

/**
 * Session ownership: releasing flow must not disconnect when journal still owns the pair.
 * Lightweight unit test against EventBridge retain/release maps without SSH.
 */
test('retain/release keeps session while another owner remains', async () => {
  const { EventBridge } = await import('../bot-engine/event-bridge.js');
  const bridge = new EventBridge({} as any) as any;

  const disconnected: string[] = [];
  const connected: string[] = [];

  bridge.connectServer = async (configId: number, sid: number) => {
    connected.push(`${configId}:${sid}`);
    bridge.connections.set(`${configId}:${sid}`, { isConnected: true, destroy: async () => {} });
    return true;
  };
  bridge.disconnectServer = async (configId: number, sid: number) => {
    disconnected.push(`${configId}:${sid}`);
    bridge.connections.delete(`${configId}:${sid}`);
  };

  await bridge.retainSession('flow', 1, 1);
  await bridge.retainSession('journal', 1, 1);
  assert.deepEqual(bridge.getSessionOwners(1, 1).sort(), ['flow', 'journal']);

  await bridge.releaseSession('flow', 1, 1);
  assert.deepEqual(bridge.getSessionOwners(1, 1), ['journal']);
  assert.equal(disconnected.length, 0);

  await bridge.releaseSession('journal', 1, 1);
  assert.deepEqual(bridge.getSessionOwners(1, 1), []);
  assert.deepEqual(disconnected, ['1:1']);
});

test('BotEngine stop removes only its tsEvent listener', () => {
  const ee = new EventEmitter();
  const engineListener = () => {};
  const journalListener = () => {};
  ee.on('tsEvent', engineListener);
  ee.on('tsEvent', journalListener);
  assert.equal(ee.listenerCount('tsEvent'), 2);
  ee.off('tsEvent', engineListener);
  assert.equal(ee.listenerCount('tsEvent'), 1);
  assert.equal(ee.listeners('tsEvent')[0], journalListener);
});

test('enableFlow retains session for cron-only flows before scheduling', async () => {
  const { BotEngine } = await import('../bot-engine/engine.js');

  const prisma = {
    botFlow: {
      findUnique: async () => ({
        id: 42,
        name: 'cron-only',
        enabled: true,
        serverConfigId: 7,
        virtualServerId: 1,
        flowData: JSON.stringify({
          nodes: [{
            id: 't1',
            type: 'trigger',
            position: { x: 0, y: 0 },
            data: { triggerType: 'cron', cronExpression: '0 * * * *', label: 'hourly' },
          }],
          edges: [],
        }),
      }),
    },
  };

  const engine = new BotEngine(prisma as any, {} as any, { clients: new Set() } as any, {} as any) as any;
  const retained: string[] = [];
  let scheduled = false;

  engine.eventBridge.retainSession = async (owner: string, configId: number, sid: number) => {
    retained.push(`${owner}:${configId}:${sid}`);
    return true;
  };
  engine.eventBridge.releaseSession = async () => {};
  engine.eventBridge.getCommandListenerKeys = () => [];
  engine.setupCronJobsForFlow = () => {};
  engine.buildWebhookRegistryForFlow = () => {};
  engine.scheduleBotsWhenReady = () => { scheduled = true; };
  engine.syncCommandListenersForPair = () => {};

  await engine.enableFlow(42);

  assert.deepEqual(retained, ['flow:7:1']);
  assert.equal(engine.sshExpectedPairs.has('7:1'), true);
  assert.equal(engine.flowOwnedPairs.has('7:1'), true);
  assert.equal(scheduled, true);
});

test('enableFlow preserves sshExpectedPairs hold when retainSession throws', async () => {
  const { BotEngine } = await import('../bot-engine/engine.js');

  const prisma = {
    botFlow: {
      findUnique: async () => ({
        id: 43,
        name: 'cron-retain-fail',
        enabled: true,
        serverConfigId: 8,
        virtualServerId: 2,
        flowData: JSON.stringify({
          nodes: [{
            id: 't1',
            type: 'trigger',
            position: { x: 0, y: 0 },
            data: { triggerType: 'cron', cronExpression: '0 * * * *', label: 'hourly' },
          }],
          edges: [],
        }),
      }),
    },
  };

  const engine = new BotEngine(prisma as any, {} as any, { clients: new Set() } as any, {} as any) as any;
  let scheduled = false;

  engine.eventBridge.retainSession = async () => {
    throw new Error('SSH connect blew up');
  };
  engine.eventBridge.releaseSession = async () => {};
  engine.eventBridge.getCommandListenerKeys = () => [];
  engine.eventBridge.isRegistered = () => false;
  engine.eventBridge.isConnected = () => false;
  engine.eventBridge.getSshReconnectPauseSeconds = () => 0;
  engine.setupCronJobsForFlow = () => {};
  engine.buildWebhookRegistryForFlow = () => {};
  engine.scheduleBotsWhenReady = () => { scheduled = true; };
  engine.syncCommandListenersForPair = () => {};

  await engine.enableFlow(43);

  assert.equal(engine.flowOwnedPairs.has('8:2'), false);
  // Failed retain must still gate cron/animations (not WebQuery-only).
  assert.equal(engine.sshExpectedPairs.has('8:2'), true);
  assert.equal(engine.isPairReadyForBotTraffic(8, 2), false);
  assert.equal(scheduled, true);
});
