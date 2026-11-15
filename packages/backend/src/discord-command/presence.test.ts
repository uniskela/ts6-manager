import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { presenceFromQueryRows } from './presence.js';

describe('TeamSpeak presence mapping', () => {
  it('keeps human nicknames and channel names only', () => {
    const snapshot = presenceFromQueryRows({
      serverinfo: { virtualserver_name: 'Lab TS' },
      channels: [{ channel_name: 'Lobby' }, { channel_name: 'Music' }],
      clients: [
        { client_nickname: 'alice', client_type: '0' },
        { client_nickname: 'query', client_type: '1' },
        { client_nickname: 'bob', client_type: 0 },
      ],
    });
    assert.deepEqual(snapshot, {
      connected: true,
      serverName: 'Lab TS',
      nicknames: ['alice', 'bob'],
      channels: [{ name: 'Lobby' }, { name: 'Music' }],
    });
  });

  it('marks empty query rows as disconnected without leaking host fields', () => {
    const snapshot = presenceFromQueryRows({});
    assert.equal(snapshot.connected, false);
    assert.equal(snapshot.serverName, null);
    assert.equal(JSON.stringify(snapshot).includes('host'), false);
  });
});
