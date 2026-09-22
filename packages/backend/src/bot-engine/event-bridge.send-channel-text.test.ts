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

test('ensureHelperInChannel skips remount when cache matches and still connected', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({
    whoami: 'clid=7 cid=34 client_nickname=Main',
  });
  assert.equal(await bridge.ensureHelperInChannel(9, 1, 34), true);
  const movesAfterPark = executed.filter((c) => c.startsWith('clientmove')).length;
  assert.equal(movesAfterPark, 0, 'already in cid per whoami — no move on first park');
  executed.length = 0;
  assert.equal(await bridge.ensureHelperInChannel(9, 1, 34), true);
  assert.equal(
    executed.filter((c) => c.startsWith('clientmove')).length,
    0,
    'cache hit skips second whoami/clientmove',
  );
  assert.equal(executed.length, 0);
});

test('disconnectServer clears mainHelperChannel cache', async () => {
  const { bridge, client } = makeBridgeWithMainSsh({
    whoami: 'clid=7 cid=1 client_nickname=Main',
  });
  (client as any).destroy = async () => undefined;
  assert.equal(await bridge.ensureHelperInChannel(9, 1, 34), true);
  assert.equal(bridge.getMainHelperChannelId(9, 1), 34);
  await bridge.disconnectServer(9, 1);
  assert.equal(bridge.getMainHelperChannelId(9, 1), 0);
  assert.equal(
    (bridge as any).mainHelperRemountAfterReconnect.get('9:1'),
    34,
    'retain remount target for reconnect',
  );
});

test('ensureHelperInChannel remounts after reconnect clears helper cache', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({
    whoami: 'clid=7 cid=1 client_nickname=Main',
  });
  assert.equal(await bridge.ensureHelperInChannel(9, 1, 34), true);
  assert.ok(executed.some((c) => c === 'clientmove clid=7 cid=34'));
  // Simulate SSH close/reconnect: Query is back in default channel but without
  // clearing cache, ensureHelper would skip remount (Bugbot stale-helper finding).
  (bridge as any).forgetMainHelperLocation('9:1');
  assert.equal(bridge.getMainHelperChannelId(9, 1), 0);
  executed.length = 0;
  assert.equal(await bridge.ensureHelperInChannel(9, 1, 34), true);
  assert.ok(
    executed.some((c) => c === 'clientmove clid=7 cid=34'),
    'must clientmove again after cache clear',
  );
  assert.equal(bridge.getMainHelperChannelId(9, 1), 34);
});

test('remountMainHelperAfterReconnect parks helper after registerEvents', async () => {
  const { bridge, executed } = makeBridgeWithMainSsh({
    whoami: 'clid=7 cid=1 client_nickname=Main',
  });
  assert.equal(await bridge.ensureHelperInChannel(9, 1, 34), true);
  (bridge as any).forgetMainHelperLocation('9:1');
  executed.length = 0;
  await (bridge as any).remountMainHelperAfterReconnect(9, 1);
  assert.ok(executed.some((c) => c === 'clientmove clid=7 cid=34'));
  assert.equal(bridge.getMainHelperChannelId(9, 1), 34);
  assert.equal((bridge as any).mainHelperRemountAfterReconnect.get('9:1'), undefined);
});
