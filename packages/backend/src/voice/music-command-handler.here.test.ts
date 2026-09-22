import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MusicCommandHandler, resetHereDedupForTests } from './music-command-handler.js';
import { isReservedChatCommandName, BUILTIN_COMMAND_HELP } from './chat-commands.js';

function makeBot(
  id: number,
  opts: {
    status?: string;
    channelId?: number;
    name?: string;
    ts3ClientId?: number;
    peers?: number;
    peerClids?: number[];
  } = {},
) {
  let channelId = opts.channelId ?? 10;
  const joins: number[] = [];
  const channelMessages: string[] = [];
  const peerClids = opts.peerClids ?? [];
  return {
    currentConfig: { id, serverConfigId: 9, name: opts.name ?? `Bot ${id}` },
    ts3ClientId: opts.ts3ClientId ?? 100 + id,
    status: opts.status ?? 'connected',
    getCurrentChannelId: () => channelId,
    getHumanChannelPeerCount: () => opts.peers ?? peerClids.length,
    getHumanChannelPeerClids: () => {
      if (peerClids.length > 0) return peerClids.slice();
      const n = opts.peers ?? 0;
      // Synthetic human clids when tests only set peers=N (must not collide with bot clids).
      return Array.from({ length: n }, (_, i) => 9000 + id * 10 + i);
    },
    joinChannel: (cid: number) => {
      joins.push(cid);
      channelId = cid;
    },
    sendChannelMessage: (msg: string) => {
      channelMessages.push(msg);
    },
    _joins: joins,
    _channelMessages: channelMessages,
  };
}

function fixture(bots: ReturnType<typeof makeBot>[]) {
  resetHereDedupForTests();
  const replies: string[] = [];
  const replyOrder: string[] = [];
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
    chatCommand: {
      findMany: async () => [],
    },
  } as any;

  const voiceBotManager = {
    getBot: (id: number) => bots.find((b) => b.currentConfig.id === id),
  } as any;

  const handler = new MusicCommandHandler(prisma, voiceBotManager) as any;
  handler.reply = async (_bot: unknown, _clid: number, message: string) => {
    replyOrder.push('reply');
    replies.push(message);
  };
  handler.refreshBotChannels = async () => {
    replyOrder.push('refresh');
  };
  for (const b of bots) {
    const origJoin = b.joinChannel.bind(b);
    b.joinChannel = (cid: number) => {
      replyOrder.push('join');
      origJoin(cid);
    };
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

  return { handler, bots, replies, replyOrder, command };
}

test('here/come are reserved and documented', () => {
  assert.ok(isReservedChatCommandName('here'));
  assert.ok(isReservedChatCommandName('COME'));
  const hereHelp = BUILTIN_COMMAND_HELP.find((h) => h.name === 'here');
  assert.ok(hereHelp);
  assert.match(hereHelp!.blurb, /idle/i);
  assert.ok(BUILTIN_COMMAND_HELP.some((h) => h.name === 'come'));
});

test('!here joins when only one bot is available', async () => {
  const bot = makeBot(1, { channelId: 10 });
  const f = fixture([bot]);
  await f.command(1, '!here', 20);
  assert.deepEqual(bot._joins, [20]);
  assert.match(f.replies.at(-1)!, /joining/i);
});

test('!here announces before join so cross-channel reply is not lost', async () => {
  const bot = makeBot(1, { channelId: 10 });
  const f = fixture([bot]);
  await f.command(1, '!here', 20);
  assert.deepEqual(
    f.replyOrder.filter((e) => e === 'reply' || e === 'join' || e === 'refresh'),
    ['reply', 'join', 'refresh'],
  );
});

test('cross-channel !here announces before move and refresh', async () => {
  const bot = makeBot(1, { channelId: 10 });
  const f = fixture([bot]);
  await f.handler.handleHereCrossChannel(9, 1, 20, { invokerid: '2', msg: '!here' }, '');
  assert.deepEqual(bot._joins, [20]);
  assert.match(f.replies.at(-1)!, /joining/i);
  assert.deepEqual(
    f.replyOrder.filter((e) => e === 'reply' || e === 'join' || e === 'refresh'),
    ['reply', 'join', 'refresh'],
  );
});

test('cross-channel !here reports when no bots are summonable', async () => {
  const bot = makeBot(1, { status: 'stopped' });
  const f = fixture([bot]);
  const sent: string[] = [];
  f.handler.eventBridge = {
    sendChannelText: async (_c: number, _s: number, _cid: number, msg: string) => {
      sent.push(msg);
      return true;
    },
  };
  await f.handler.handleHereCrossChannel(9, 1, 20, { invokerid: '2', msg: '!here' }, '');
  assert.equal(bot._joins.length, 0);
  assert.match(sent.at(-1)!, /No music bots are available/i);
});

test('!here refuses to summon a bot without a TS client id', async () => {
  const bot = makeBot(1, { channelId: 10, ts3ClientId: 0 });
  const f = fixture([bot]);
  await f.command(1, '!here', 20);
  assert.equal(bot._joins.length, 0);
  assert.match(f.replies.at(-1)!, /not fully connected/i);
});

test('!here prefers a bot already in the requester channel', async () => {
  // Sole summonable bot already here → confirm presence.
  const here = makeBot(1, { name: 'Here', channelId: 20, peers: 1 });
  const f = fixture([here]);
  await f.command(1, '!here', 20);
  assert.equal(here._joins.length, 0);
  assert.match(f.replies.at(-1)!, /already here/i);
});

test('!here lists when one bot is already here and another is idle elsewhere', async () => {
  const here = makeBot(1, { name: 'Here', channelId: 20, peers: 1 });
  const elsewhere = makeBot(2, { name: 'Away', channelId: 10, peers: 0 });
  const f = fixture([here, elsewhere]);
  await f.command(1, '!here', 20);
  assert.equal(here._joins.length, 0);
  assert.equal(elsewhere._joins.length, 0);
  assert.match(f.replies.at(-1)!, /Available bots/i);
  assert.match(f.replies.at(-1)!, /\[1\] Here \(already here\)/);
  assert.match(f.replies.at(-1)!, /\[2\] Away/);
  assert.doesNotMatch(f.replies.at(-1)!, /Here \[#1\] is already here\./);
});

test('!here prefers an idle bot over one occupied by other humans', async () => {
  const busy = makeBot(1, { name: 'Busy', channelId: 10, peers: 2 });
  const idle = makeBot(2, { name: 'Idle', channelId: 11, peers: 0 });
  const f = fixture([busy, idle]);
  await f.command(1, '!here', 20);
  assert.equal(busy._joins.length, 0);
  assert.deepEqual(idle._joins, [20]);
  assert.match(f.replies.at(-1)!, /Idle \[#2\].*joining/i);
});

test('!here does not auto-steal when every bot has other humans', async () => {
  const a = makeBot(1, { name: 'Alpha', channelId: 10, peers: 1 });
  const b = makeBot(2, { name: 'Beta', channelId: 11, peers: 3 });
  const f = fixture([a, b]);
  await f.command(1, '!here', 20);
  assert.equal(a._joins.length, 0);
  assert.equal(b._joins.length, 0);
  assert.match(f.replies.at(-1)!, /busy with other users/i);
  assert.match(f.replies.at(-1)!, /!here <id>/);
});

test('!here lists idle bots when more than one is idle', async () => {
  const a = makeBot(1, { name: 'Alpha', peers: 0 });
  const b = makeBot(2, { name: 'Beta', peers: 0 });
  const f = fixture([a, b]);
  await f.command(1, '!here', 20);
  assert.equal(a._joins.length, 0);
  assert.match(f.replies.at(-1)!, /\[1\] Alpha/);
  assert.match(f.replies.at(-1)!, /\[2\] Beta/);
  assert.match(f.replies.at(-1)!, /!here <id>/);
});

test('!here <id> summons the requested bot even when busy', async () => {
  const a = makeBot(1, { name: 'Alpha', channelId: 10, peers: 0 });
  const b = makeBot(2, { name: 'Beta', channelId: 11, peers: 4 });
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

test('getNeededCommandChannelIds does not treat defaultChannel as home when voice cid is 0', () => {
  const bot = makeBot(1, { channelId: 0 });
  const f = fixture([bot]);
  // Command channel 20 equals defaultChannel in fixture config — previously skipped SSH.
  f.handler.botChannelConfig.set(1, {
    serverConfigId: 9,
    virtualServerId: 1,
    defaultChannel: '20',
    commandChannelIds: ['20'],
  });
  const needed = f.handler.getNeededCommandChannelIds(9, 1);
  assert.deepEqual(needed, [20]);
});

test('getNeededServerPairs includes music bots even without commandChannelIds', () => {
  const bot = makeBot(1);
  const f = fixture([bot]);
  f.handler.botChannelConfig.set(1, {
    serverConfigId: 9,
    virtualServerId: 1,
    defaultChannel: '10',
    commandChannelIds: [],
  });
  assert.deepEqual(f.handler.getNeededServerPairs(), ['9:1']);
});

test('empty commandChannelIds opens SSH helpers only for occupied human channels', async () => {
  const bot = makeBot(1, { channelId: 1 }); // Default Channel home
  const f = fixture([bot]);
  f.handler.botChannelConfig.set(1, {
    serverConfigId: 9,
    virtualServerId: 1,
    defaultChannel: '1',
    commandChannelIds: [],
  });

  const connected: number[] = [];
  const commands: string[] = [];
  f.handler.eventBridge = {
    getCommandListenerChannelIds: () => [...connected],
    connectCommandListener: async (_c: number, _s: number, cid: number) => {
      connected.push(cid);
    },
    disconnectCommandListener: async (_c: number, _s: number, cid: number) => {
      const i = connected.indexOf(cid);
      if (i >= 0) connected.splice(i, 1);
    },
    executeCommand: async (_c: number, _s: number, cmd: string) => {
      commands.push(cmd);
      assert.equal(cmd, 'clientlist');
      // Human in Test4 (cid=34); bot home cid=1 must be excluded; query client ignored.
      return [
        'clid=9 cid=1 client_type=0',
        'clid=2 cid=34 client_type=0',
        'clid=50 cid=99 client_type=1',
      ].join('|');
    },
  };

  await f.handler.syncCommandListenersForPair(9, 1);
  assert.deepEqual(commands, ['clientlist']);
  assert.deepEqual(connected, [34]);
  assert.ok(f.handler.channelToBots.get('9:1:34')?.has(1));
});

test('SSH !here is skipped when a voice bot is already in the command channel', async () => {
  const home = makeBot(1, { name: 'Home', channelId: 20 });
  const f = fixture([home]);
  const key = '9:1:20';
  f.handler.channelToBots.set(key, new Set([1]));
  await f.handler.onCrossChannelTextMessage(9, 1, 20, { invokerid: '2', msg: '!here' });
  assert.equal(home._joins.length, 0);
  assert.equal(f.replies.length, 0);
});

test('duplicate voice !here from two bots only summons once', async () => {
  const a = makeBot(1, { name: 'Alpha', channelId: 10, peers: 0 });
  const b = makeBot(2, { name: 'Beta', channelId: 11, peers: 0 });
  // Make only Alpha idle-preference winner by putting Beta busy... actually both idle → list.
  // Use single-idle pair: Alpha idle, Beta busy — first voice handler summons; second dedupes.
  const busy = makeBot(2, { name: 'Beta', channelId: 11, peers: 2 });
  const f = fixture([a, busy]);
  await Promise.all([
    f.command(1, '!here', 20),
    f.command(2, '!here', 20),
  ]);
  assert.deepEqual(a._joins, [20]);
  assert.equal(busy._joins.length, 0);
  assert.equal(f.replies.filter((r) => /joining/i.test(r)).length, 1);
});

test('SSH then voice !here for same message only summons once', async () => {
  const bot = makeBot(1, { channelId: 10 });
  const f = fixture([bot]);
  await f.handler.handleHereCrossChannel(9, 1, 20, { invokerid: '2', msg: '!here' }, '');
  await f.command(1, '!here', 20);
  assert.deepEqual(bot._joins, [20]);
  assert.equal(f.replies.filter((r) => /joining/i.test(r)).length, 1);
});

test('voice !here soft-notifies unknown channel when SSH is connected but has no cmd listener', async () => {
  const bot = makeBot(1, { channelId: 0 });
  const f = fixture([bot]);
  // Main SSH up ≠ helper will answer (no auto-discovered listeners).
  f.handler.eventBridge = {
    isConnected: () => true,
    getCommandListenerChannelIds: () => [],
    executeCommand: async () => {
      throw new Error('SSH clientlist unavailable');
    },
    sendChannelText: async () => true,
  };
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!here' }, undefined);
  assert.equal(bot._joins.length, 0);
  assert.equal(bot._channelMessages.length, 1);
  assert.match(bot._channelMessages[0]!, /Could not determine this channel/i);
});

test('voice !here soft-notifies when SSH exists but is disconnected', async () => {
  const bot = makeBot(1, { channelId: 0 });
  const f = fixture([bot]);
  f.handler.eventBridge = {
    isConnected: () => false,
    getCommandListenerChannelIds: () => [20],
    executeCommand: async () => {
      throw new Error('SSH not connected');
    },
  };
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!here' }, undefined);
  assert.equal(bot._joins.length, 0);
  assert.equal(bot._channelMessages.length, 1);
  assert.match(bot._channelMessages[0]!, /Could not determine this channel/i);
});

test('voice !here soft-notifies unknown channel only when SSH cannot own the line', async () => {
  const bot = makeBot(1, { channelId: 0 });
  const f = fixture([bot]);
  // No eventBridge → pure voice path; tell the user instead of total silence.
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!here' }, undefined);
  assert.equal(bot._joins.length, 0);
  assert.equal(bot._channelMessages.length, 1);
  assert.match(bot._channelMessages[0]!, /Could not determine this channel/i);
});

test('voice !here resolves unknown homeCid via invoker clientlist', async () => {
  const bot = makeBot(1, { channelId: 0, name: 'Alpha' });
  const f = fixture([bot]);
  f.handler.eventBridge = {
    executeCommand: async () => 'clid=2 cid=34 client_type=0|clid=101 cid=1 client_type=0',
  };
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!here' }, undefined);
  assert.deepEqual(bot._joins, [34]);
  assert.match(f.replies.at(-1)!, /joining/i);
});

test('only one bot replies to !help when both hear the same line', async () => {
  const a = makeBot(1, { name: 'A', channelId: 20 });
  const b = makeBot(2, { name: 'B', channelId: 20 });
  const f = fixture([a, b]);
  await Promise.all([
    f.handler.onTextMessage(1, a, { invokerid: '2', msg: '!help' }, 20),
    f.handler.onTextMessage(2, b, { invokerid: '2', msg: '!help' }, 20),
  ]);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!, /Music bot commands/i);
});

test('!help in different channels is not collapsed by same-user dedupe', async () => {
  const bot = makeBot(1, { name: 'A', channelId: 20 });
  const f = fixture([bot]);
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, 20);
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, 34);
  assert.equal(f.replies.length, 2);
});

test('failed SSH !help does not block voice reply on the same channel', async () => {
  const bot = makeBot(1, { name: 'Home', channelId: 20 });
  const f = fixture([bot]);
  const key = '9:1:20';
  f.handler.channelToBots.set(key, new Set([1]));
  f.handler.eventBridge = {
    sendChannelText: async () => false,
  };
  // Force SSH path even though a voice bot is in-channel (simulates homeCid race).
  await f.handler.handleHelpCrossChannel(9, 1, 20, { invokerid: '2', msg: '!help' });
  assert.equal(f.replies.length, 0);
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, 20);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!, /Music bot commands/i);
});

test('successful SSH !help still suppresses a later voice reply on that channel', async () => {
  const bot = makeBot(1, { name: 'Home', channelId: 20 });
  const f = fixture([bot]);
  f.handler.eventBridge = {
    sendChannelText: async () => true,
  };
  await f.handler.handleHelpCrossChannel(9, 1, 20, { invokerid: '2', msg: '!help' });
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, 20);
  assert.equal(f.replies.length, 0);
});

test('in-flight SSH !help claim blocks concurrent voice during send', async () => {
  const bot = makeBot(1, { name: 'Home', channelId: 20 });
  const f = fixture([bot]);
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  f.handler.eventBridge = {
    sendChannelText: async () => {
      await sendGate;
      return true;
    },
  };
  const ssh = f.handler.handleHelpCrossChannel(9, 1, 20, { invokerid: '2', msg: '!help' });
  // Voice waits on the in-flight owner; must not reply while SSH is still sending.
  const voice = f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, 20);
  // Yield so voice reaches beginHelpAction and parks on the flight.
  await new Promise((r) => setImmediate(r));
  assert.equal(f.replies.length, 0);
  releaseSend();
  await Promise.all([ssh, voice]);
  assert.equal(f.replies.length, 0);
});

test('in-flight SSH !help failure lets waiting voice reply', async () => {
  const bot = makeBot(1, { name: 'Home', channelId: 20 });
  const f = fixture([bot]);
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  f.handler.eventBridge = {
    sendChannelText: async () => {
      await sendGate;
      return false;
    },
  };
  const ssh = f.handler.handleHelpCrossChannel(9, 1, 20, { invokerid: '2', msg: '!help' });
  const voice = f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, 20);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.replies.length, 0);
  releaseSend();
  await Promise.all([ssh, voice]);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!, /Music bot commands/i);
});

test('thrown SSH !help still settles flight so voice can reply', async () => {
  const bot = makeBot(1, { name: 'Home', channelId: 20 });
  const f = fixture([bot]);
  f.handler.eventBridge = {
    sendChannelText: async () => {
      throw new Error('dynamic import boom');
    },
  };
  const ssh = f.handler.handleHelpCrossChannel(9, 1, 20, { invokerid: '2', msg: '!help' });
  const voice = f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, 20);
  await Promise.all([ssh, voice]);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!, /Music bot commands/i);
});

test('voice !help with homeCid=0 resolves invoker channel so claim matches SSH', async () => {
  const bot = makeBot(1, { name: 'A', channelId: 0 });
  const f = fixture([bot]);
  const sent: string[] = [];
  f.handler.eventBridge = {
    executeCommand: async () => 'clid=2 cid=20 client_type=0|clid=101 cid=1 client_type=0',
    sendChannelText: async (_c: number, _s: number, _cid: number, msg: string) => {
      sent.push(msg);
      return true;
    },
  };
  // Voice replies first with resolved cid=20; SSH helper must dedupe on the same key.
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, undefined);
  assert.equal(f.replies.length, 1);
  await f.handler.handleHelpCrossChannel(9, 1, 20, { invokerid: '2', msg: '!help' });
  assert.equal(sent.length, 0);
});

test('voice !help with unknown channel replies when SSH is connected but has no cmd listener', async () => {
  const bot = makeBot(1, { name: 'A', channelId: 0 });
  const f = fixture([bot]);
  f.handler.eventBridge = {
    isConnected: () => true,
    getCommandListenerChannelIds: () => [],
    executeCommand: async () => {
      throw new Error('SSH clientlist unavailable');
    },
    sendChannelText: async () => true,
  };
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, undefined);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!, /Music bot commands/i);
});

test('voice !help with unknown channel still replies when SSH is disconnected', async () => {
  const bot = makeBot(1, { name: 'A', channelId: 0 });
  const f = fixture([bot]);
  f.handler.eventBridge = {
    isConnected: () => false,
    getCommandListenerChannelIds: () => [20],
    executeCommand: async () => {
      throw new Error('SSH not connected');
    },
  };
  await f.handler.onTextMessage(1, bot, { invokerid: '2', msg: '!help' }, undefined);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!, /Music bot commands/i);
});

test('!here prefers idle from clientlist even when voice peer count is stale zero', async () => {
  const busy = makeBot(1, { name: 'Busy', channelId: 10, peers: 0, ts3ClientId: 101 });
  const idle = makeBot(2, { name: 'Idle', channelId: 11, peers: 0, ts3ClientId: 102 });
  const f = fixture([busy, idle]);
  f.handler.eventBridge = {
    executeCommand: async () =>
      [
        'clid=101 cid=10 client_type=0',
        'clid=55 cid=10 client_type=0',
        'clid=102 cid=11 client_type=0',
      ].join('|'),
  };
  await f.command(1, '!here', 20);
  assert.equal(busy._joins.length, 0);
  assert.deepEqual(idle._joins, [20]);
  assert.match(f.replies.at(-1)!, /Idle \[#2\].*joining/i);
});

test('!here does not treat sibling music bots as human occupants', async () => {
  const a = makeBot(1, { name: 'Alpha', channelId: 10, ts3ClientId: 101, peerClids: [102] });
  const b = makeBot(2, { name: 'Beta', channelId: 10, ts3ClientId: 102, peerClids: [101] });
  const busy = makeBot(3, { name: 'Busy', channelId: 11, ts3ClientId: 103, peers: 1 });
  const f = fixture([a, b, busy]);
  f.handler.eventBridge = {
    executeCommand: async () =>
      [
        'clid=101 cid=10 client_type=0',
        'clid=102 cid=10 client_type=0',
        'clid=103 cid=11 client_type=0',
        'clid=77 cid=11 client_type=0',
      ].join('|'),
  };
  await f.command(1, '!here', 20);
  assert.equal(busy._joins.length, 0);
  // Parked siblings are idle (only each other); busy has a human → list idle bots, not "all busy".
  assert.match(f.replies.at(-1)!, /Available bots/i);
  assert.match(f.replies.at(-1)!, /\[1\] Alpha/);
  assert.match(f.replies.at(-1)!, /\[2\] Beta/);
  assert.doesNotMatch(f.replies.at(-1)!, /busy with other users/i);
});

test('!here summons when only sibling music bots share the channel', async () => {
  // Two music bots parked together with no humans — both idle, so bare !here lists (not "all busy").
  const parked = makeBot(1, { name: 'Parked', channelId: 10, ts3ClientId: 201, peerClids: [202] });
  const sibling = makeBot(2, { name: 'Sibling', channelId: 10, ts3ClientId: 202, peerClids: [201] });
  const f = fixture([parked, sibling]);
  f.handler.eventBridge = {
    executeCommand: async () =>
      ['clid=201 cid=10 client_type=0', 'clid=202 cid=10 client_type=0'].join('|'),
  };
  await f.command(1, '!here', 20);
  assert.equal(parked._joins.length, 0);
  assert.equal(sibling._joins.length, 0);
  assert.match(f.replies.at(-1)!, /Available bots/i);
  assert.doesNotMatch(f.replies.at(-1)!, /busy with other users/i);
});

test('!here summons the only idle bot when its channel mate is another music bot', async () => {
  const idle = makeBot(1, { name: 'Idle', channelId: 10, ts3ClientId: 201, peerClids: [] });
  const mate = makeBot(2, { name: 'Mate', channelId: 10, ts3ClientId: 202, peerClids: [201] });
  const busy = makeBot(3, { name: 'Busy', channelId: 11, ts3ClientId: 203, peers: 2 });
  const f = fixture([idle, mate, busy]);
  // Mate disconnected → gone from clientlist; leftover mate.ts3ClientId must not mask anyone.
  mate.status = 'stopped';
  f.handler.eventBridge = {
    executeCommand: async () =>
      [
        'clid=201 cid=10 client_type=0',
        'clid=203 cid=11 client_type=0',
        'clid=50 cid=11 client_type=0',
        'clid=51 cid=11 client_type=0',
      ].join('|'),
  };
  await f.command(1, '!here', 20);
  assert.deepEqual(idle._joins, [20]);
  assert.match(f.replies.at(-1)!, /Idle \[#1\].*joining/i);
});

test('!here does not hide humans behind stale disconnected bot clids', async () => {
  // Stopped bot left ts3ClientId=55; a human now occupies that clid with the live bot.
  // Without a live-connection gate, 55 is excluded and Occupied looks idle → wrong pick.
  const occupied = makeBot(1, {
    name: 'Occupied',
    channelId: 10,
    ts3ClientId: 101,
    peerClids: [55],
  });
  const dead = makeBot(2, {
    name: 'Dead',
    channelId: 10,
    ts3ClientId: 55,
    status: 'stopped',
  });
  const idle = makeBot(3, {
    name: 'Idle',
    channelId: 11,
    ts3ClientId: 102,
    peers: 0,
  });
  const f = fixture([occupied, dead, idle]);
  f.handler.eventBridge = {
    executeCommand: async () =>
      [
        'clid=101 cid=10 client_type=0',
        'clid=55 cid=10 client_type=0',
        'clid=102 cid=11 client_type=0',
      ].join('|'),
  };
  await f.command(1, '!here', 20);
  assert.equal(occupied._joins.length, 0);
  assert.deepEqual(idle._joins, [20]);
  assert.match(f.replies.at(-1)!, /Idle \[#3\].*joining/i);
});

test('cross-channel !help posts via SSH helper when no voice bot is in channel', async () => {
  const bot = makeBot(1, { channelId: 10 });
  const f = fixture([bot]);
  const key = '9:1:20';
  f.handler.channelToBots.set(key, new Set([1]));
  const sent: Array<{ msg: string; nick?: string }> = [];
  f.handler.eventBridge = {
    sendChannelText: async (
      _c: number,
      _s: number,
      _cid: number,
      msg: string,
      opts?: { helperNickname?: string },
    ) => {
      sent.push({ msg, nick: opts?.helperNickname });
      return true;
    },
  };
  await f.handler.onCrossChannelTextMessage(9, 1, 20, { invokerid: '2', msg: '!help' });
  assert.equal(bot._joins.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.msg, /!here/i);
  assert.equal(sent[0]!.nick, 'TS6 Helper');
});

test('cross-channel !help is skipped when a voice bot is already in the channel', async () => {
  const home = makeBot(1, { name: 'Home', channelId: 20 });
  const f = fixture([home]);
  const key = '9:1:20';
  f.handler.channelToBots.set(key, new Set([1]));
  const sent: string[] = [];
  f.handler.eventBridge = {
    sendChannelText: async (_c: number, _s: number, _cid: number, msg: string) => {
      sent.push(msg);
      return true;
    },
  };
  await f.handler.onCrossChannelTextMessage(9, 1, 20, { invokerid: '2', msg: '!help' });
  assert.equal(sent.length, 0);
});
