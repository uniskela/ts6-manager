import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOT_TEMPLATES } from '../../../frontend/src/data/bot-templates.ts';
import { REMINDER_DELAY_CAP_MS, parseDurationMs } from './delay-limit.ts';
import { normalizeFlowData } from './engine.ts';
import { FlowRunner } from './flow-runner.ts';
import { TSApiError } from '../middleware/error-handler.ts';

const prisma = {
  botExecution: {
    create: async () => ({ id: 1 }),
    update: async () => ({}),
  },
  botExecutionLog: { create: async () => ({}) },
  botVariable: {
    findMany: async () => [],
    create: async () => ({ id: 1 }),
  },
};

function templateFlow(id: string, config: Record<string, string>) {
  const found = BOT_TEMPLATES.find((item) => item.id === id);
  assert.ok(found);
  return normalizeFlowData(found.flowDataFactory(config));
}

function triggerId(flowData: ReturnType<typeof templateFlow>, triggerType: string) {
  const node = flowData.nodes.find((item) => item.type === 'trigger' && (item.data as { triggerType?: string }).triggerType === triggerType);
  assert.ok(node);
  return node.id;
}

async function run(id: string, config: Record<string, string>, triggerType: string, event: Record<string, string>, client: any, database = prisma) {
  const flowData = templateFlow(id, config);
  const waits: number[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: TimerHandler, ms?: number, ...args: unknown[]) => {
    waits.push(ms ?? 0);
    return original(cb as () => void, 0, ...(args as []));
  }) as typeof setTimeout;
  try {
    const runner = new FlowRunner(database as any, { getClient: () => client } as any, { clients: new Set() } as any);
    await runner.execute({
      id: 1,
      name: id,
      serverConfigId: 1,
      virtualServerId: 1,
      flowData,
    }, triggerId(flowData, triggerType), triggerType, event, 'UTC');
    return waits;
  } finally {
    globalThis.setTimeout = original;
  }
}

test('duration parsing accepts supported units and rejects invalid values', () => {
  assert.equal(parseDurationMs('10m'), 600_000);
  assert.equal(parseDurationMs('30s'), 30_000);
  assert.equal(parseDurationMs('2H'), 7_200_000);
  assert.equal(parseDurationMs('1d'), REMINDER_DELAY_CAP_MS);
  assert.equal(parseDurationMs('100ms'), 100);
  assert.equal(parseDurationMs('later'), null);
  assert.equal(parseDurationMs('0m'), null);
  assert.equal(parseDurationMs('-1m'), null);
  assert.equal(parseDurationMs('9007199254740992d'), null);
  const requested = parseDurationMs('3d');
  assert.ok(requested && requested > REMINDER_DELAY_CAP_MS);
});

test('support ticket import creates a tracked channel, moves the user, and pokes staff', async () => {
  const calls: Array<{ command: string; params?: Record<string, unknown> }> = [];
  const client = {
    execute: async () => [],
    executePost: async (_sid: number, command: string, params?: Record<string, unknown>) => {
      calls.push({ command, params });
      if (command === 'channelcreate') return [{ cid: '42' }];
      if (command === 'servergroupclientlist') return [{ cldbid: '7' }];
      if (command === 'clientlist') return [{ clid: '3', client_type: '0', client_database_id: '7' }];
      return [];
    },
  };
  await run('support-ticket', { parentChannelId: '19', staffGroupId: '6' }, 'command', {
    clid: '3',
    client_nickname: 'Ada',
    command_args: 'vpn help',
  }, client);
  assert.equal(calls[0].command, 'channelcreate');
  assert.equal(calls[0].params?.channel_name, 'Support: Ada');
  assert.equal(calls[0].params?.channel_topic, 'vpn help');
  assert.equal(calls[0].params?.cpid, '19');
  assert.equal(calls[0].params?.channel_flag_semi_permanent, '1');
  assert.match(String(calls[0].params?.channel_description), /TS6M-TEMP:/);
  assert.deepEqual(calls[1], { command: 'clientmove', params: { clid: '3', cid: '42' } });
  assert.equal(calls.at(-1)?.command, 'clientpoke');
  assert.match(String(calls.at(-1)?.params?.msg), /Ada/);
  assert.match(String(calls.at(-1)?.params?.msg), /vpn help/);
});

test('support ticket with no topic does not create a channel', async () => {
  const calls: string[] = [];
  await run('support-ticket', { parentChannelId: '19', staffGroupId: '6' }, 'command', {
    clid: '3',
    client_nickname: 'Ada',
    command_args: '',
  }, {
    execute: async () => [],
    executePost: async (_sid: number, command: string) => {
      calls.push(command);
      return [];
    },
  });
  assert.deepEqual(calls, []);
});

test('reminder waits the requested duration and messages the remaining text', async () => {
  const calls: Array<{ command: string; params?: Record<string, unknown> }> = [];
  const waits = await run('timed-reminder', {}, 'command', {
    clid: '8',
    command_args: '10m check the kettle',
  }, {
    execute: async () => [{ client_unique_identifier: 'requester-uid' }],
    executePost: async (_sid: number, command: string, params?: Record<string, unknown>) => {
      calls.push({ command, params });
      return [];
    },
  });
  assert.deepEqual(waits, [600_000]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'sendtextmessage');
  assert.equal(calls[0].params?.targetmode, 1);
  assert.equal(calls[0].params?.target, '8');
  assert.equal(calls[0].params?.msg, 'check the kettle');
});

test('reminder delays longer than a day are capped and invalid delays send nothing', async () => {
  const calls: string[] = [];
  const client = {
    execute: async () => [{ client_unique_identifier: 'requester-uid' }],
    executePost: async (_sid: number, command: string) => {
      calls.push(command);
      return [];
    },
  };
  const waits = await run('timed-reminder', {}, 'command', { clid: '8', command_args: '3d standup' }, client);
  assert.deepEqual(waits, [REMINDER_DELAY_CAP_MS]);
  assert.deepEqual(calls, ['sendtextmessage']);

  calls.length = 0;
  const invalidWaits = await run('timed-reminder', {}, 'command', { clid: '8', command_args: 'later standup' }, client);
  assert.deepEqual(invalidWaits, []);
  assert.deepEqual(calls, []);
});

test('reminder accepts repeated whitespace and preserves the reminder text', async () => {
  const messages: unknown[] = [];
  const waits = await run('timed-reminder', {}, 'command', {
    clid: '8', command_args: '10m  check   the\tkettle',
  }, {
    execute: async () => [{ client_unique_identifier: 'requester-uid' }],
    executePost: async (_sid: number, _command: string, params?: Record<string, unknown>) => {
      messages.push(params?.msg);
      return [];
    },
  });
  assert.deepEqual(waits, [600_000]);
  assert.deepEqual(messages, ['check   the\tkettle']);
});

test('reminder without text never waits or sends a message', async () => {
  for (const command_args of ['', '10m', '10m   ', '10m\t']) {
    const calls: string[] = [];
    const waits = await run('timed-reminder', {}, 'command', { clid: '8', command_args }, {
      execute: async () => [],
      executePost: async (_sid: number, command: string) => { calls.push(command); return []; },
    });
    assert.deepEqual(waits, [], command_args);
    assert.deepEqual(calls, [], command_args);
  }
});

test('reminder skips a known reused client id or an offline requester', async () => {
  for (const connectedUid of ['another-uid', null]) {
    const calls: string[] = [];
    const waits = await run('timed-reminder', {}, 'command', {
      clid: '8', command_args: '10m private note', client_unique_identifier: 'requester-uid',
    }, {
      execute: async () => connectedUid ? [{ client_unique_identifier: connectedUid }] : [],
      executePost: async (_sid: number, command: string) => { calls.push(command); return []; },
    });
    assert.deepEqual(waits, [600_000]);
    assert.deepEqual(calls, []);
  }
});

test('reminder with no stable requester identity never waits or sends a message', async () => {
  const calls: string[] = [];
  const waits = await run('timed-reminder', {}, 'command', { clid: '8', command_args: '10m private note' }, {
    execute: async () => [],
    executePost: async (_sid: number, command: string) => { calls.push(command); return []; },
  });
  assert.deepEqual(waits, []);
  assert.deepEqual(calls, []);
});

test('disconnected-client query errors skip reminders while permission errors fail the run', async () => {
  for (const [eventUid, error, expectedStatus] of [
    ['', new TSApiError(512, 'invalid clientID'), 'completed'],
    ['requester-uid', new TSApiError(512, 'invalid clientID'), 'completed'],
    ['requester-uid', new TSApiError(2568, 'insufficient client permissions'), 'failed'],
  ] as const) {
    const statuses: string[] = [];
    const sent: string[] = [];
    await run('timed-reminder', {}, 'command', {
      clid: '8', command_args: '10m note', client_unique_identifier: eventUid,
    }, {
      execute: async () => { throw error; },
      executePost: async (_sid: number, command: string) => { sent.push(command); return []; },
    }, {
      ...prisma,
      botExecution: {
        ...prisma.botExecution,
        update: async ({ data }: any) => { statuses.push(data.status); return {}; },
      },
    } as any);
    assert.deepEqual(sent, []);
    assert.deepEqual(statuses, [expectedStatus]);
  }
});

test('reminder rechecks identity immediately before delivery after message preparation', async () => {
  let queries = 0;
  const sent: string[] = [];
  await run('timed-reminder', {}, 'command', {
    clid: '8', command_args: '10m note', client_unique_identifier: 'requester-uid',
  }, {
    execute: async () => [{ client_unique_identifier: ++queries === 1 ? 'requester-uid' : 'other-uid' }],
    executePost: async (_sid: number, command: string) => { sent.push(command); return []; },
  });
  assert.equal(queries, 2);
  assert.deepEqual(sent, []);
});

test('one requester can hold only three reminder slots and cancellation releases them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flowData = templateFlow('timed-reminder', {});
  const warnings: string[] = [];
  let started = 0;
  const runner = new FlowRunner({
    ...prisma,
    botExecutionLog: { create: async ({ data }: any) => {
      if (data.message.startsWith('Delaying')) started++;
      if (data.level === 'warn') warnings.push(data.message);
      return {};
    } },
  } as any, { getClient: () => ({ execute: async () => [], executePost: async () => [] }) } as any, { clients: new Set() } as any);
  const begin = (uid: string) => runner.execute({
    id: 1, name: 'Reminder', serverConfigId: 1, virtualServerId: 1, flowData,
  }, triggerId(flowData, 'command'), 'command', {
    clid: '8', command_args: '1d note', client_unique_identifier: uid,
  });
  const pending = [begin('ada'), begin('ada'), begin('ada')];
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, 3);
    await begin('ada');
    assert.equal(started, 3);
    assert.match(warnings.at(-1) ?? '', /3 pending reminders/);
    pending.push(begin('bob'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, 4);
    runner.cancelFlow(1);
    await Promise.all(pending);
    pending.push(begin('ada'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, 5);
  } finally {
    runner.cancelAll();
    await Promise.all(pending);
  }
});

test('cancelling a flow clears its pending reminder and records cancellation', { timeout: 5000 }, async () => {
  const calls: string[] = [];
  const statuses: unknown[] = [];
  const flowData = templateFlow('timed-reminder', {});
  const runner = new FlowRunner({
    ...prisma,
    botExecution: {
      create: async () => ({ id: 1 }),
      update: async ({ data }: any) => { statuses.push(data.status); return {}; },
    },
  } as any, { getClient: () => ({
    execute: async () => [{ client_unique_identifier: 'requester-uid' }],
    executePost: async (_sid: number, command: string) => { calls.push(command); return []; },
  }) } as any, { clients: new Set() } as any);
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    const timer = original(cb, ms);
    started();
    return timer;
  }) as typeof setTimeout;
  try {
    const execution = runner.execute({
      id: 1, name: 'Reminder', serverConfigId: 1, virtualServerId: 1, flowData,
    }, triggerId(flowData, 'command'), 'command', {
      clid: '8', command_args: '1d private note', client_unique_identifier: 'requester-uid',
    });
    await waiting;
    runner.cancelFlow(1);
    await execution;
    assert.deepEqual(calls, []);
    assert.deepEqual(statuses, ['cancelled']);
  } finally {
    runner.cancelAll();
    globalThis.setTimeout = original;
  }
});

test('scheduled announcement posts the dated message to the server or one channel', async () => {
  const calls: Array<{ command: string; params?: Record<string, unknown> }> = [];
  const client = {
    execute: async (_sid: number, command: string) => {
      calls.push({ command });
      if (command === 'whoami') return [{ client_id: '1', client_channel_id: '2' }];
      return [];
    },
    executePost: async (_sid: number, command: string, params?: Record<string, unknown>) => {
      calls.push({ command, params });
      return [];
    },
  };
  await run('scheduled-announcement', {
    message: 'Announcement {{time.date}}',
    cron: '0 9 * * *',
    timezone: 'UTC',
    audience: 'server',
  }, 'cron', {}, client);
  assert.equal(calls[0].command, 'sendtextmessage');
  assert.equal(calls[0].params?.targetmode, 3);
  assert.match(String(calls[0].params?.msg), /^Announcement \d{2}\.\d{2}\.\d{4}$/);

  calls.length = 0;
  await run('scheduled-announcement', {
    message: 'Room {{time.date}}',
    cron: '0 * * * *',
    audience: 'channel',
    channelId: '12',
  }, 'cron', {}, client);
  assert.equal(calls[0].command, 'whoami');
  assert.equal(calls[1].command, 'clientmove');
  assert.equal(calls[1].params?.cid, '12');
  assert.equal(calls[2].params?.targetmode, 2);
  assert.match(String(calls[2].params?.msg), /^Room \d{2}\.\d{2}\.\d{4}$/);
});
