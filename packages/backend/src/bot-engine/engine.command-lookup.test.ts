import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BotEngine } from './engine.js';

function fixture(channelId?: string, commandName = 'roll extra', commandPrefix = '!') {
  const engine = new BotEngine({} as any, {} as any, { clients: new Set() } as any, {} as any) as any;
  const trigger = {
    id: 'command', type: 'trigger', position: { x: 0, y: 0 },
    data: { triggerType: 'command', commandPrefix, commandName, channelId },
  };
  engine.flows.set(1, {
    id: 1, serverConfigId: 9, virtualServerId: 2,
    triggerNodes: [trigger], flowData: { nodes: [trigger], edges: [] },
  });
  const executions: unknown[] = [];
  engine.executeFlow = (...args: unknown[]) => executions.push(args);
  return { engine, executions };
}

const cases = [
  { name: 'base trigger accepts base event', match: true },
  { name: 'base trigger rejects dedicated listener', source: '5', match: false },
  { name: 'channel trigger accepts its listener', channel: '5', source: '5', match: true },
  { name: 'channel trigger rejects another listener', channel: '5', source: '6', match: false },
  { name: 'channel trigger rejects base event even with matching target', channel: '5', match: false },
  { name: 'multiword command accepts arguments', message: '!roll extra 20', match: true },
  { name: 'multiword command requires the full name', message: '!roll', match: false },
  { name: 'multiword command requires a space boundary', message: '!roll extraordinary', match: false },
  { name: 'tab after command does not match dispatch', message: '!roll extra\t20', match: false },
  { name: 'uppercase input does not match lowercase command', message: '!ROLL extra', match: false },
  { name: 'uppercase command matches its exact case', command: 'ROLL extra', message: '!ROLL extra', match: true },
  { name: 'leading whitespace does not match dispatch', message: ' !roll extra', match: false },
  { name: 'another server does not match', configId: 10, match: false },
  { name: 'another virtual server does not match', sid: 3, match: false },
] satisfies Array<{
  name: string; channel?: string; source?: string; message?: string;
  command?: string; configId?: number; sid?: number; match: boolean;
}>;

for (const c of cases) {
  test(`flow lookup agrees with dispatch: ${c.name}`, () => {
    const { engine, executions } = fixture(c.channel, c.command);
    const message = c.message ?? '!roll extra';
    const configId = c.configId ?? 9;
    const sid = c.sid ?? 2;
    assert.equal(engine.hasCommandFlow(configId, sid, message, c.source), c.match);
    engine.onTsEvent(configId, sid, 'notifytextmessage', {
      msg: message, target: '5', invokerid: '7',
      ...(c.source ? { __cmd_listener_channel_id: c.source } : {}),
    });
    assert.equal(executions.length, c.match ? 1 : 0);
  });
}

test('music handler lookup preserves listener provenance', () => {
  const { engine } = fixture('5');
  let lookup: (...args: any[]) => boolean = () => false;
  engine.setMusicCommandHandler({ setFlowCommandLookup: (value: typeof lookup) => { lookup = value; } });
  assert.equal(lookup(9, 2, '!roll extra', '5'), true);
  assert.equal(lookup(9, 2, '!roll extra', '6'), false);
  assert.equal(lookup(9, 2, '!roll extra'), false);
});

test('music lookup ignores commands with another prefix', () => {
  const { engine } = fixture(undefined, 'roll extra', '/');
  assert.equal(engine.hasCommandFlow(9, 2, '!roll extra'), false);
});

test('command dispatch includes the native chat sender identity for flow templates', () => {
  const { engine, executions } = fixture(undefined, 'support');
  engine.onTsEvent(9, 2, 'notifytextmessage', {
    msg: '!support vpn help', invokerid: '7', invokername: 'Ada', invokeruid: 'ada-uid',
  });
  assert.equal(executions.length, 1);
  const event = (executions[0] as any[])[3];
  assert.equal(event.clid, '7');
  assert.equal(event.client_nickname, 'Ada');
  assert.equal(event.client_unique_identifier, 'ada-uid');
  assert.equal(event.command_args, 'vpn help');
});

test('an old execution cannot release slots belonging to a reloaded flow', async () => {
  const { engine } = fixture();
  let finishOld!: () => void;
  let finishNew!: () => void;
  const pending = [
    new Promise<void>((resolve) => { finishOld = resolve; }),
    new Promise<void>((resolve) => { finishNew = resolve; }),
  ];
  engine.flowRunner.execute = () => pending.shift();
  const flow = engine.flows.get(1);
  // fixture replaces executeFlow to observe dispatch; use the real method here.
  const execute = (BotEngine.prototype as any).executeFlow.bind(engine);
  execute(flow, 'command', 'command', {});
  engine.cleanupUnusedSshConnections = async () => {};
  let cancelled = false;
  engine.flowRunner.cancelFlow = (id: number) => { assert.equal(id, 1); cancelled = true; };
  await engine.disableFlow(1);
  assert.ok(cancelled);
  execute(flow, 'command', 'command', {});
  const replacement = engine.executionCounts.get(1);
  finishOld();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacement.active, 1);
  finishNew();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacement.active, 0);
});

test('support cooldown follows requester UID across reconnects and permits other requesters', async (t) => {
  const { engine } = fixture(undefined, 'support');
  const flow = engine.flows.get(1);
  flow.triggerNodes[0].data.cooldownSeconds = 60;
  const executed: string[] = [];
  engine.flowRunner.execute = async (_flow: unknown, _node: unknown, _type: unknown, event: any) => {
    executed.push(event.client_unique_identifier);
  };
  const execute = (BotEngine.prototype as any).executeFlow.bind(engine);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  execute(flow, 'command', 'command', { clid: '7', client_unique_identifier: 'ada' });
  execute(flow, 'command', 'command', { clid: '8', client_unique_identifier: 'ada' });
  execute(flow, 'command', 'command', { clid: '9', client_unique_identifier: 'bob' });
  execute(flow, 'command', 'command', { clid: '10' });
  assert.deepEqual(executed, ['ada', 'bob']);
  t.mock.timers.setTime(61_000);
  execute(flow, 'command', 'command', { clid: '8', client_unique_identifier: 'ada' });
  assert.deepEqual(executed, ['ada', 'bob', 'ada']);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('a concurrency-rejected command can retry without consuming its cooldown', async () => {
  const { engine } = fixture(undefined, 'support');
  const flow = engine.flows.get(1);
  flow.triggerNodes[0].data.cooldownSeconds = 60;
  const counts = { active: 20 };
  engine.executionCounts.set(1, counts);
  let executions = 0;
  engine.flowRunner.execute = async () => { executions++; };
  const execute = (BotEngine.prototype as any).executeFlow.bind(engine);
  const event = { clid: '7', client_unique_identifier: 'ada' };
  execute(flow, 'command', 'command', event);
  assert.equal(executions, 0);
  counts.active--;
  execute(flow, 'command', 'command', event);
  assert.equal(executions, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(counts.active, 19);
});
