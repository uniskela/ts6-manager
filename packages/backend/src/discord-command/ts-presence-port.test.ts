import assert from 'node:assert/strict';
import test from 'node:test';
import { createBindingScopedPresence } from './ts-presence-port.js';

test('presence port fail-closed when unbound or missing client', async () => {
  const port = createBindingScopedPresence({
    bindings: { async get() { return null; } },
    getClient() { return null; },
    virtualServerIdForBot() { return 1; },
  });
  assert.equal(await port.snapshot('g1'), null);
});

test('presence port maps WebQuery rows for a bound guild', async () => {
  const calls: string[] = [];
  const port = createBindingScopedPresence({
    bindings: {
      async get(guildId) {
        assert.equal(guildId, 'guild-1');
        return { instanceId: 'local', revoked: false, botId: 10, serverConfigId: 3 };
      },
    },
    getClient(serverConfigId) {
      assert.equal(serverConfigId, 3);
      return {
        async execute(sid, command) {
          calls.push(`${sid}:${command}`);
          if (command === 'serverinfo') return [{ virtualserver_name: 'Lab TS' }];
          if (command === 'channellist') return [{ channel_name: 'Lobby' }];
          if (command === 'clientlist') {
            return [
              { client_nickname: 'Pike', client_type: '0' },
              { client_nickname: 'serveradmin', client_type: '1' },
            ];
          }
          return [];
        },
      };
    },
    virtualServerIdForBot(botId) {
      assert.equal(botId, 10);
      return 1;
    },
  });
  const snap = await port.snapshot('guild-1');
  assert.deepEqual(snap, {
    connected: true,
    serverName: 'Lab TS',
    nicknames: ['Pike'],
    channels: [{ name: 'Lobby' }],
  });
  assert.deepEqual(calls, ['1:serverinfo', '1:channellist', '1:clientlist']);
});
