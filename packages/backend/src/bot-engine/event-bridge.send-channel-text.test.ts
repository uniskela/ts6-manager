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

test('sendChannelText remounts with clientid fallbacks then sends', async () => {
  const { bridge, executed } = makeBridgeWithCmdListener({
    whoami: 'clientid=42 virtualserver_status=online',
  });
  const ok = await bridge.sendChannelText(9, 1, 20, 'hello');
  assert.equal(ok, true);
  assert.ok(executed.some((c) => c === 'clientmove clid=42 cid=20'));
  assert.ok(executed.some((c) => c.startsWith('sendtextmessage')));
});
