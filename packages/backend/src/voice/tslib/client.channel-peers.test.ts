import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ts3Client } from './client.js';

function feed(client: Ts3Client, cmdStr: string) {
  (client as any).processCommand(Buffer.from(cmdStr, 'utf-8'));
}

test('notifyclientmoved does not wipe peers already seeded after optimistic move', () => {
  const client = new Ts3Client();
  (client as any).clientId = 9;
  (client as any).currentChannelId = 10;
  // Optimistic move (as moveToChannel does)
  (client as any).currentChannelId = 20;
  (client as any).channelMembers.clear();
  // Occupants arrive before move confirmation
  feed(client, 'notifycliententerview clid=3 ctid=20 client_type=0');
  feed(client, 'notifycliententerview clid=4 ctid=20 client_type=0');
  assert.equal(client.getChannelUserCount(), 2);
  // Server confirms our move to the same cid — must keep peers
  feed(client, 'notifyclientmoved clid=9 cfid=10 ctid=20');
  assert.equal(client.getCurrentChannelId(), 20);
  assert.equal(client.getChannelUserCount(), 2);
});

test('clientlist seeds human peers for current channel', () => {
  const client = new Ts3Client();
  (client as any).clientId = 9;
  (client as any).currentChannelId = 20;
  feed(
    client,
    'clientlist clid=9 cid=20 client_type=0|clid=3 cid=20 client_type=0|clid=4 cid=20 client_type=1|clid=5 cid=99 client_type=0',
  );
  assert.equal(client.getChannelUserCount(), 1);
});

test('moveToChannel requests clientlist after move', () => {
  const client = new Ts3Client();
  (client as any).clientId = 9;
  (client as any).currentChannelId = 10;
  (client as any).opts = { channelPassword: '' };
  const sent: string[] = [];
  (client as any).sendCommand = (cmd: string) => {
    sent.push(cmd);
  };
  client.moveToChannel(20);
  assert.ok(sent.some((c) => c.startsWith('clientmove')));
  assert.ok(sent.some((c) => c === 'clientlist' || c.startsWith('clientlist')));
});
