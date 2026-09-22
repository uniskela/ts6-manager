import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBridge } from './event-bridge.js';

function makeBridgeWithMainSsh(opts: {
  whoami?: string;
  failMove?: boolean;
  connected?: boolean;
}) {
  const executed: string[] = [];
  const client = {
    isConnected: opts.connected !== false,
    executeCommand: async (cmd: string) => {
      executed.push(cmd);
      if (cmd.startsWith('use ')) return '';
      if (cmd === 'whoami') {
        if (opts.whoami === '') return '';
        return opts.whoami ?? 'clid=7 client_nickname=MainBot cid=1';
      }
      if (cmd.startsWith('clientmove')) {
        if (opts.failMove) throw new Error('move denied');
        return '';
      }
      if (cmd.startsWith('sendtextmessage')) return '';
      return '';
    },
  };
  const bridge = new EventBridge({} as any) as any;
  bridge.connections.set('9:1', client);
  return { bridge: bridge as EventBridge, executed, client };
}

test('sendChannelText returns false when whoami has no clid', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({ whoami: 'client_nickname=Cmd' });
  const ok = await bridge.sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, false);
  assert.ok(executed.some((c) => c.startsWith('use ')));
  assert.ok(!executed.some((c) => c.startsWith('sendtextmessage')));
});

test('sendChannelText returns false when clientmove fails', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({ failMove: true });
  const ok = await bridge.sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, false);
  assert.ok(!executed.some((c) => c.startsWith('sendtextmessage')));
});

test('sendChannelText skips clientmove when already in target channel', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({
    whoami: 'clid=7 cid=20 client_nickname=Cmd',
  });
  const ok = await bridge.sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, true);
  assert.ok(!executed.some((c) => c.startsWith('clientmove')));
  assert.ok(executed.some((c) => c.startsWith('sendtextmessage')));
});

test('sendChannelText remounts via main SSH then sends', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({
    whoami: 'clientid=42 cid=1 virtualserver_status=online',
  });
  const ok = await bridge.sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, true);
  assert.ok(executed.some((c) => c === 'clientmove clid=42 cid=20'));
  assert.ok(executed.some((c) => c.startsWith('sendtextmessage')));
  assert.equal(bridge.getMainHelperChannelId(9, 1), 20);
});

test('sendChannelText sets unique helper nickname then restores', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({
    whoami: 'clid=7 cid=1 client_nickname=TS6-WebUI-Bot-1-ab12',
  });
  const ok = await bridge.sendChannelText(9, 1, 20, 'help text', {
    helperNickname: 'TS6 Helper',
  });
  assert.equal(ok, true);
  const helperIdx = executed.findIndex(
    (c) => c.startsWith('clientupdate') && c.includes('TS6\\sHelper-20'),
  );
  const msgIdx = executed.findIndex((c) => c.startsWith('sendtextmessage'));
  const restoreIdx = executed.findIndex(
    (c) => c.startsWith('clientupdate') && c.includes('TS6-WebUI-Bot-1-ab12'),
  );
  assert.ok(helperIdx >= 0, 'unique helper nick per channel');
  assert.ok(msgIdx > helperIdx, 'message after helper rename');
  assert.ok(restoreIdx > msgIdx, 'restore nick after send');
});

test('ensureHelperInChannel parks main SSH without a second login', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({
    whoami: 'clid=7 cid=1 client_nickname=Main',
  });
  const ok = await bridge.ensureHelperInChannel(9, 1, 34);
  assert.equal(ok, true);
  assert.ok(executed.some((c) => c === 'clientmove clid=7 cid=34'));
  assert.equal(bridge.getMainHelperChannelId(9, 1), 34);
});
