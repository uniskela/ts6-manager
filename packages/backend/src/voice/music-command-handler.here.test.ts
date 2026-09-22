import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MusicCommandHandler } from './music-command-handler.js';
import { isReservedChatCommandName, BUILTIN_COMMAND_HELP } from './chat-commands.js';

function makeBot(id: number, opts: { status?: string; channelId?: number; name?: string } = {}) {
  let channelId = opts.channelId ?? 10;
  const joins: number[] = [];
  return {
    currentConfig: { id, serverConfigId: 9, name: opts.name ?? `Bot ${id}` },
    ts3ClientId: 100 + id,
    status: opts.status ?? 'connected',
    getCurrentChannelId: () => channelId,
    joinChannel: (cid: number) => {
      joins.push(cid);
      channelId = cid;
    },
    sendChannelMessage: () => {},
    _joins: joins,
  };
}

function fixture(bots: ReturnType<typeof makeBot>[]) {
  const replies: string[] = [];
  const dbRows = bots.map((b) => ({
    id: b.currentConfig.id,
    name: b.currentConfig.name,
    nickname: b.currentConfig.name,
    virtualServerId: 1,
  }));
  const prisma = {
    musicBot: {
      findMany: async () => dbRows,
      findUnique: async ({ where }: any) =>
        dbRows.find((r) => r.id === where.id)
          ? { id: where.id, serverConfigId: 9, commandChannelIds: '[]', defaultChannel: '10', virtualServerId: 1 }
          : null,
    },
  } as any;

  const voiceBotManager = {
    getBot: (id: number) => bots.find((b) => b.currentConfig.id === id),
  } as any;

  const handler = new MusicCommandHandler(prisma, voiceBotManager) as any;
  handler.reply = (_bot: unknown, _clid: number, message: string) => replies.push(message);
  handler.refreshBotChannels = async () => {};
  for (const b of bots) {
    handler.botChannelConfig.set(b.currentConfig.id, {
      serverConfigId: 9,
      virtualServerId: 1,
      defaultChannel: '10',
      commandChannelIds: ['20'],
    });
  }

  const command = (botId: number, msg: string, replyCid = 20) => {
    const bot = bots.find((b) => b.currentConfig.id === botId)!;
    return handler.onTextMessage(botId, bot, { invokerid: '2', msg }, replyCid);
  };

  return { handler, bots, replies, command };
}

test('here/come are reserved and documented', () => {
  assert.ok(isReservedChatCommandName('here'));
  assert.ok(isReservedChatCommandName('COME'));
  assert.ok(BUILTIN_COMMAND_HELP.some((h) => h.name === 'here'));
  assert.ok(BUILTIN_COMMAND_HELP.some((h) => h.name === 'come'));
});

test('!here joins when only one bot is available', async () => {
  const bot = makeBot(1, { channelId: 10 });
  const f = fixture([bot]);
  await f.command(1, '!here', 20);
  assert.deepEqual(bot._joins, [20]);
  assert.match(f.replies.at(-1)!, /joining/i);
});

test('!here lists bots when more than one is available', async () => {
  const a = makeBot(1, { name: 'Alpha' });
  const b = makeBot(2, { name: 'Beta' });
  const f = fixture([a, b]);
  await f.command(1, '!here', 20);
  assert.equal(a._joins.length, 0);
  assert.match(f.replies.at(-1)!, /\[1\] Alpha/);
  assert.match(f.replies.at(-1)!, /\[2\] Beta/);
  assert.match(f.replies.at(-1)!, /!here <id>/);
});

test('!here <id> summons the requested bot', async () => {
  const a = makeBot(1, { name: 'Alpha', channelId: 10 });
  const b = makeBot(2, { name: 'Beta', channelId: 11 });
  const f = fixture([a, b]);
  await f.command(1, '!here 2', 20);
  assert.equal(a._joins.length, 0);
  assert.deepEqual(b._joins, [20]);
  assert.match(f.replies.at(-1)!, /Beta \[#2\].*joining/i);
});

test('!here <id> reports already here', async () => {
  const a = makeBot(1, { channelId: 20 });
  const f = fixture([a]);
  await f.command(1, '!here 1', 20);
  assert.equal(a._joins.length, 0);
  assert.match(f.replies.at(-1)!, /already here/i);
});

test('!here <id> rejects unknown or stopped bots', async () => {
  const a = makeBot(1, { name: 'Alpha' });
  const b = makeBot(2, { name: 'Beta', status: 'stopped' });
  const f = fixture([a, b]);
  await f.command(1, '!here 2', 20);
  assert.match(f.replies.at(-1)!, /not available/);
  await f.command(1, '!here 99', 20);
  assert.match(f.replies.at(-1)!, /not available/);
});

test('!come is an alias for !here', async () => {
  const bot = makeBot(1, { channelId: 5 });
  const f = fixture([bot]);
  await f.command(1, '!come', 30);
  assert.deepEqual(bot._joins, [30]);
});
