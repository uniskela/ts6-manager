import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ts3Client } from './client.js';

test('cleanup is idempotent and emits disconnected only once', () => {
  const client = new Ts3Client();
  (client as any).state = 'connected';
  (client as any).clientId = 9;
  (client as any).socket = { close() {} };

  let emissions = 0;
  client.on('disconnected', () => {
    emissions += 1;
  });

  (client as any).cleanup();
  assert.equal(emissions, 1);
  assert.equal((client as any).state, 'disconnected');
  assert.equal(client.getClientId(), 0);

  (client as any).cleanup();
  assert.equal(emissions, 1);
});
