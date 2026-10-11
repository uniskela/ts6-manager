import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlowRunner } from './flow-runner.js';

function context(sid = 1) {
  return { configId: 1, sid, eventData: {}, getTemp: () => undefined, resolveTemplate: async (value: string) => value };
}

test('overlapping flow announcements serialize move, send, and restore', async () => {
  const runner = new FlowRunner({} as any, {} as any, { clients: new Set() } as any) as any;
  const signal = new AbortController().signal;
  let channel = '2';
  const delivered: Array<[string, string]> = [];
  let releaseFirst!: () => void;
  const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let entered!: () => void;
  const moved = new Promise<void>((resolve) => { entered = resolve; });
  const client = {
    execute: async () => [{ client_id: '1', client_channel_id: channel }],
    executePost: async (_sid: number, command: string, params: any) => {
      if (command === 'clientmove') {
        channel = params.cid;
        if (channel === '12') { entered(); await held; }
      }
      if (command === 'sendtextmessage') delivered.push([channel, params.msg]);
    },
  };
  const first = runner.executeMessage({ targetMode: 2, target: '12', message: 'A' }, context(), client, signal);
  await moved;
  const second = runner.executeMessage({ targetMode: 2, target: '13', message: 'B' }, context(), client, signal);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(channel, '12');
  } finally {
    releaseFirst();
  }
  await Promise.all([first, second]);
  assert.deepEqual(delivered, [['12', 'A'], ['13', 'B']]);
  assert.equal(channel, '2');
});

test('failed channel sends restore the helper and release the next announcement', async () => {
  const runner = new FlowRunner({} as any, {} as any, { clients: new Set() } as any) as any;
  const signal = new AbortController().signal;
  let channel = '2';
  const delivered: string[] = [];
  const client = {
    execute: async () => [{ client_id: '1', client_channel_id: channel }],
    executePost: async (_sid: number, command: string, params: any) => {
      if (command === 'clientmove') channel = params.cid;
      if (command === 'sendtextmessage') {
        if (params.msg === 'A') throw new Error('send denied');
        delivered.push(channel);
      }
    },
  };
  await assert.rejects(runner.executeMessage({ targetMode: 2, target: '12', message: 'A' }, context(), client, signal), /send denied/);
  assert.equal(channel, '2');
  await runner.executeMessage({ targetMode: 2, target: '13', message: 'B' }, context(), client, signal);
  assert.deepEqual(delivered, ['13']);
  assert.equal(channel, '2');
});

test('a rejected announcement queue drops its abort listener and stays usable', async () => {
  const runner = new FlowRunner({} as any, {} as any, { clients: new Set() } as any) as any;
  const failed = Promise.reject(new Error('queue broken'));
  await assert.rejects(failed);
  runner.channelMessageChains.set('1:1', failed);
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: any, options?: any) => {
    if (type === 'abort') added++;
    return add(type, listener, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: any, options?: any) => {
    if (type === 'abort') removed++;
    return remove(type, listener, options);
  }) as typeof signal.removeEventListener;
  const posted: string[] = [];
  const client = {
    execute: async () => [{ client_id: '1', client_channel_id: '2' }],
    executePost: async (_sid: number, command: string, params: any) => {
      if (command === 'sendtextmessage') posted.push(params.msg);
    },
  };
  await assert.rejects(runner.executeMessage(
    { targetMode: 2, target: '12', message: 'A' }, context(), client, signal,
  ), /queue broken/);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.equal(runner.channelMessageChains.has('1:1'), false);
  await runner.executeMessage({ targetMode: 2, target: '13', message: 'B' }, context(), client, new AbortController().signal);
  assert.deepEqual(posted, ['B']);
});

test('an unidentified query client cannot fall back to posting in the wrong channel', async () => {
  const runner = new FlowRunner({} as any, {} as any, { clients: new Set() } as any) as any;
  const posted: string[] = [];
  await assert.rejects(runner.executeMessage({ targetMode: 2, target: '12', message: 'A' }, context(), {
    execute: async () => [],
    executePost: async (_sid: number, command: string) => { posted.push(command); },
  }, new AbortController().signal), /requires the query client/);
  assert.deepEqual(posted, []);
});

for (const cancelDuring of ['whoami', 'clientmove']) {
  test(`cancellation during ${cancelDuring} skips the send and restores any move`, async () => {
    const runner = new FlowRunner({} as any, {} as any, { clients: new Set() } as any) as any;
    const controller = new AbortController();
    const calls: string[] = [];
    const client = {
      execute: async () => {
        if (cancelDuring === 'whoami') controller.abort();
        return [{ client_id: '1', client_channel_id: '2' }];
      },
      executePost: async (_sid: number, command: string, params: any) => {
        calls.push(`${command}:${params.cid}`);
        if (cancelDuring === command) controller.abort();
      },
    };
    await assert.rejects(runner.executeMessage({ targetMode: 2, target: '12', message: 'A' },
      context(), client, controller.signal), { name: 'AbortError' });
    assert.deepEqual(calls, cancelDuring === 'whoami' ? [] : ['clientmove:12', 'clientmove:2']);
  });
}
