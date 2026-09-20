import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DemoWebQueryClient } from './demo-webquery-client.js';

describe('DemoWebQueryClient', () => {
  it('returns deterministic generic server, channel, and client fixtures', async () => {
    const client = new DemoWebQueryClient();
    try {
      const serverInfo = await client.execute(1, 'serverinfo');
      const channels = await client.execute(1, 'channellist');
      const clients = await client.execute(1, 'clientlist');

      assert.equal(serverInfo[0].virtualserver_name, 'Demo TeamSpeak Server');
      assert.ok(channels.some((channel: any) => channel.channel_name === 'Lobby'));
      assert.ok(clients.some((entry: any) => entry.client_nickname === 'Sample User'));
      assert.ok(clients.some((entry: any) => entry.client_nickname.includes('Long Nickname')));
    } finally {
      client.destroy();
    }
  });

  it('reports demo health without attempting a real WebQuery connection', async () => {
    const client = new DemoWebQueryClient();
    try {
      assert.deepEqual(await client.testConnection(), { ok: true, version: 'Demo mode' });
    } finally {
      client.destroy();
    }
  });

  it('simulates mutation responses without changing the fixture source', async () => {
    const client = new DemoWebQueryClient();
    try {
      const before = await client.execute(1, 'channellist');
      const result = await client.execute(1, 'channeldelete', { cid: '2' });
      const after = await client.execute(1, 'channellist');

      assert.equal(result[0].success, '1');
      assert.deepEqual(after, before);
    } finally {
      client.destroy();
    }
  });
});
