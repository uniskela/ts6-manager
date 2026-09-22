import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBridge } from './event-bridge.js';

function makeBridgeWithCmdListener(opts: {
  whoami?: string;
  failMove?: boolean;
}) {
  const executed: string[] = [];
  const client = {
    isConnected: true,
    executeCommand: async (cmd: string) => {
      executed.push(cmd);
      if (cmd.startsWith('use ')) return '';
      if (cmd === 'whoami') {
        if (opts.whoami === '') return '';
        return opts.whoami ?? 'clid=7 client_nickname=Cmd';
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
  bridge.commandListeners.set('9:1:cmd:20', client);
  return { bridge: bridge as EventBridge, executed };
}

test('sendChannelText returns false when whoami has no clid', async () => {
  const { bridge, executed } = makeBridgeWithCmdListener({ whoami: 'client_nickname=Cmd' });
  const ok = await bridge.sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, false);
  assert.ok(executed.some((c) => c.startsWith('use ')));
  assert.ok(!executed.some((c) => c.startsWith('sendtextmessage')));
});

test('sendChannelText returns false when clientmove fails', async () => {
  const { bridge, executed } = makeBridgeWithCmdListener({ failMove: true });
  const ok = await bridge.sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, false);
  assert.ok(!executed.some((c) => c.startsWith('sendtextmessage')));
});

test('sendChannelText treats clientmove 770 as already-in-channel and still sends', async () => {
  const executed: string[] = [];
  const client = {
    isConnected: true,
    executeCommand: async (cmd: string) => {
      executed.push(cmd);
      if (cmd.startsWith('use ')) return '';
      if (cmd === 'whoami') return 'clid=7 cid=20 client_nickname=Cmd';
      if (cmd.startsWith('clientmove')) {
        throw new Error('TS error 770: already member of channel');
      }
      if (cmd.startsWith('sendtextmessage')) return '';
      return '';
    },
  };
  // whoami already reports cid=20 — send path should skip clientmove entirely.
  const bridge = new EventBridge({} as any) as any;
  bridge.commandListeners.set('9:1:cmd:20', client);
  const ok = await (bridge as EventBridge).sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, true);
  assert.ok(!executed.some((c) => c.startsWith('clientmove')));
  assert.ok(executed.some((c) => c.startsWith('sendtextmessage')));
});

test('sendChannelText continues after clientmove 770 when whoami cid differs', async () => {
  // Simulate SshQueryClient treating 770 as resolve (already member) — executeCommand succeeds.
  const executed: string[] = [];
  const client = {
    isConnected: true,
    executeCommand: async (cmd: string) => {
      executed.push(cmd);
      if (cmd === 'whoami') return 'clid=7 cid=1 client_nickname=Cmd';
      return '';
    },
  };
  const bridge = new EventBridge({} as any) as any;
  bridge.commandListeners.set('9:1:cmd:20', client);
  const ok = await (bridge as EventBridge).sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, true);
  assert.ok(executed.some((c) => c === 'clientmove clid=7 cid=20'));
  assert.ok(executed.some((c) => c.startsWith('sendtextmessage')));
});

test('sendChannelText remounts with clientid fallbacks then sends', async () => {
  const { bridge, executed } = makeBridgeWithCmdListener({
    whoami: 'clientid=42 virtualserver_status=online',
  });
  const ok = await bridge.sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, true);
  assert.ok(executed.some((c) => c === 'clientmove clid=42 cid=20'));
  assert.ok(executed.some((c) => c.startsWith('sendtextmessage')));
});

test('sendChannelText sets unique helper nickname then restores cmd nick', async () => {
  const { bridge, executed } = makeBridgeWithCmdListener({
    whoami: 'clid=7 client_nickname=TS6-WebUI-Cmd-20-ab12',
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
    (c) => c.startsWith('clientupdate') && c.includes('TS6-WebUI-Cmd-20-ab12'),
  );
  assert.ok(helperIdx >= 0, 'unique helper nick per channel');
  assert.ok(msgIdx > helperIdx, 'message after helper rename');
  assert.ok(restoreIdx > msgIdx, 'restore unique cmd nick after send');
});

test('sendChannelText helper nicks differ by channel id', async () => {
  const executedA: string[] = [];
  const executedB: string[] = [];
  const makeClient = (executed: string[], nick: string) => ({
    isConnected: true,
    executeCommand: async (cmd: string) => {
      executed.push(cmd);
      if (cmd === 'whoami') return `clid=7 client_nickname=${nick}`;
      return '';
    },
  });
  const bridge = new EventBridge({} as any) as any;
  bridge.commandListeners.set('9:1:cmd:20', makeClient(executedA, 'TS6-WebUI-Cmd-20-aa'));
  bridge.commandListeners.set('9:1:cmd:30', makeClient(executedB, 'TS6-WebUI-Cmd-30-bb'));
  await (bridge as EventBridge).sendChannelText(9, 1, 20, 'a', { helperNickname: 'TS6 Helper' });
  await (bridge as EventBridge).sendChannelText(9, 1, 30, 'b', { helperNickname: 'TS6 Helper' });
  assert.ok(executedA.some((c) => c.includes('TS6\\sHelper-20')));
  assert.ok(executedB.some((c) => c.includes('TS6\\sHelper-30')));
  assert.ok(!executedA.some((c) => c.includes('TS6\\sHelper-30')));
  assert.ok(!executedB.some((c) => c.includes('TS6\\sHelper-20')));
});
