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
