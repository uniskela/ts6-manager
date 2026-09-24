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
      const diagnostic = await client.diagnoseConnection();
      assert.equal(diagnostic.success, true);
      assert.equal(diagnostic.overall, 'ok');
      assert.equal(diagnostic.version, 'Demo mode');
      assert.equal(diagnostic.stages.length, 4);
      assert.ok(diagnostic.stages.every((stage) => stage.status === 'ok'));
    } finally {
      client.destroy();
    }
  });

  it('pages logview with begin_pos without inventing cursors from text length', async () => {
    const client = new DemoWebQueryClient();
    try {
      const newest = await client.execute(1, 'logview', { lines: 2, reverse: 1, instance: 0 });
      assert.equal(newest.length, 2);
      assert.equal(newest[0].last_pos, '500');
      assert.equal(newest[1].last_pos, '400');

      const older = await client.execute(1, 'logview', {
        lines: 2,
        reverse: 1,
        instance: 0,
        begin_pos: '400',
      });
      assert.equal(older.length, 2);
      assert.equal(older[0].last_pos, '350');
      assert.ok(!older.some((row: any) => row.last_pos === '500' || row.last_pos === '400'));

      const instance = await client.execute(1, 'logview', { lines: 10, reverse: 1, instance: 1 });
      assert.ok(instance.every((row: any) => String(row.l).includes('TeamSpeak instance') || String(row.l).includes('License') || String(row.l).includes('WebQuery')));
      assert.ok(!instance.some((row: any) => String(row.l).includes('VirtualServer |1')));
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
