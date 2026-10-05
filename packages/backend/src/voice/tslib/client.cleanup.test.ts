import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { Ts3Client } from './client.js';
import { generateIdentity } from './identity.js';

function connectedClient(): Ts3Client {
  const client = new Ts3Client();
  (client as any).state = 'connected';
  (client as any).clientId = 9;
  (client as any).currentChannelId = 20;
  (client as any).socket = { close() {} };
  return client;
}

test('cleanup is idempotent and emits disconnected only once', () => {
  const client = connectedClient();

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

test('forceClose clears client state and a later cleanup does not re-emit', () => {
  const client = connectedClient();

  let emissions = 0;
  client.on('disconnected', () => {
    emissions += 1;
  });

  client.forceClose();
  assert.equal(emissions, 1);
  assert.equal(client.getClientId(), 0);
  assert.equal(client.getCurrentChannelId(), 0);

  (client as any).cleanup();
  assert.equal(emissions, 1);
});

test('connect rejects without timers when forceClose runs during UDP buffer setup', async () => {
  const client = new Ts3Client();
  client.on('debug', () => client.forceClose());

  const sockProto = dgram.Socket.prototype as any;
  const origSend = sockProto.setSendBufferSize;
  const origRecv = sockProto.setRecvBufferSize;
  sockProto.setSendBufferSize = () => {
    throw new Error('buffer denied');
  };
  sockProto.setRecvBufferSize = () => {
    throw new Error('buffer denied');
  };

  let initSent = 0;
  const origSendInit = (client as any).sendInitPacket.bind(client);
  (client as any).sendInitPacket = (...args: unknown[]) => {
    initSent += 1;
    return origSendInit(...args);
  };

  try {
    await assert.rejects(
      () =>
        client.connect({
          host: '127.0.0.1',
          port: 9987,
          identity: generateIdentity(0),
          nickname: 'test-bot',
        }),
      /Connection closed/,
    );
    assert.equal((client as any).resendTimer, null);
    assert.equal((client as any).pingTimer, null);
    assert.equal(initSent, 0);
  } finally {
    sockProto.setSendBufferSize = origSend;
    sockProto.setRecvBufferSize = origRecv;
    client.forceClose();
  }
});
