import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { MusicCommandHandler, resetChatReplyCooldownsForTests } from './music-command-handler.js';
import { ListenerRemoteService } from './listener-remote.js';
import { createHash } from 'node:crypto';

function fixture(publicUrl: string | null = 'https://ts.example.test/manager') {
  resetChatReplyCooldownsForTests();
  const privateReplies: Array<{ clid: number; text: string }> = [], channelReplies: string[] = [];
  const queries: string[] = [];
  const audit: any[] = [];
  const prisma = {
    appSetting: { findUnique: async () => ({ value: publicUrl ?? '' }) },
    adminAuditEvent: {
      create: async ({ data }: any) => { audit.push({ ...data }); return { id: 'audit-id' }; },
      updateMany: async ({ where, data }: any) => {
        for (const row of audit) if (row.operationId === where.operationId && row.outcome === 'pending') Object.assign(row, data);
        return { count: 1 };
      },
    },
  } as any;
  const bot: any = Object.assign(new EventEmitter(), {
    currentConfig: { id: 1, serverConfigId: 9, name: 'Music', nickname: 'Music' },
    ts3ClientId: 42, status: 'connected',
    getCurrentChannelId: () => 5,
    sendTextMessage: (clid: number, text: string) => { privateReplies.push({ clid, text }); },
    sendChannelMessage: (text: string) => { channelReplies.push(text); },
  });
  const manager = { getBot: (id: number) => id === 1 ? bot : undefined, listBots: () => [{ id: 1 }] } as any;
  const handler = new MusicCommandHandler(prisma, manager) as any;
  handler.botChannelConfig.set(1, { serverConfigId: 9, virtualServerId: 2 });
  handler.musicBotClidsOnServer = () => new Set([42, 43]);
  handler.scheduleMainHelperPark = () => {};
  handler.scheduleMainHelperRebalance = () => {};
  handler.syncMusicSessionOwnership = async () => {};
  handler.refreshBotChannels = async () => {};
  const bridge: any = Object.assign(new EventEmitter(), {
    executeCommand: async (configId: number, sid: number, command: string) => {
      assert.equal(configId, 9); assert.equal(sid, 2); queries.push(command);
      return command.startsWith('clientinfo')
        ? 'client_unique_identifier=human client_servergroups=6 client_type=0'
        : 'clid=2 cid=5 client_type=0 client_unique_identifier=human|clid=42 cid=5 client_type=0 client_unique_identifier=self';
    },
    getMainHelperChannelId: () => 5,
  });
  const service = new ListenerRemoteService();
  handler.setListenerRemote(service);
  handler.setEventBridge(bridge);
  const command = (msg = '!remote', uid: string | null = 'human') => handler.onTextMessage(1, bot, {
    invokerid: '2', ...(uid ? { invokeruid: uid } : {}), msg, target: '5',
  });
  const token = () => new URL(privateReplies[0].text.split('link: ')[1]).hash.slice('#token='.length);
  return { handler, service, bot, bridge, prisma, audit, privateReplies, channelReplies, queries, command, token };
}

test('remote issues a private fragment link for exactly one verified bot and identity', async () => {
  const f = fixture();
  await f.command();
  assert.equal(f.privateReplies.length, 1);
  assert.equal(f.privateReplies[0].clid, 2);
  assert.match(f.privateReplies[0].text, /https:\/\/ts\.example\.test\/manager\/remote#token=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.channelReplies, []);
  const exchanged = await f.service.exchange(f.token(), async binding => {
    assert.deepEqual(binding, { botId: 1, serverConfigId: 9, virtualServerId: 2, channelId: 5, clid: 2, uid: 'human' });
    return true;
  });
  assert.ok(exchanged.session);
  await assert.rejects(f.service.exchange(f.token(), async () => true));
  assert.equal(f.audit.length, 1);
  assert.equal(f.audit[0].action, 'listener.remote.issue');
  assert.equal(f.audit[0].actorUserId, 0);
  assert.equal(f.audit[0].actorUsername, `listener:${createHash('sha256').update('human').digest('hex')}`);
  assert.equal(f.audit[0].connectionId, 9);
  assert.equal(f.audit[0].virtualServerId, 2);
  assert.equal(f.audit[0].targetId, '1');
  assert.equal(f.audit[0].outcome, 'success');
  const stored = JSON.stringify(f.audit);
  for (const secret of [f.token(), exchanged.session, 'human', 'https://ts.example.test']) assert.equal(stored.includes(secret), false);
});

test('concurrent duplicate remote commands issue and reply once', async () => {
  const f = fixture();
  await Promise.all([f.command(), f.command(), f.command()]);
  assert.equal(f.privateReplies.length, 1);
  assert.equal(f.queries.length, 2);
  assert.deepEqual(f.channelReplies, []);
});

test('remote does not issue a credential if the pending audit insert fails', async () => {
  const f = fixture();
  let issued = 0;
  f.service.issue = () => { issued++; throw new Error('must not issue'); };
  f.prisma.adminAuditEvent.create = async () => { throw new Error('audit credential must not be echoed'); };
  await f.command();
  assert.equal(issued, 0);
  assert.equal(f.privateReplies.length, 1);
  assert.match(f.privateReplies[0].text, /unavailable right now/);
  assert.equal(f.privateReplies[0].text.includes('audit credential'), false);
  assert.deepEqual(f.channelReplies, []);
});

test('departure, bot move, status change and flood hold during the pending audit prevent late issuance', async () => {
  for (const kind of ['leave-rejoin', 'bot-channel', 'bot-status', 'flood']) {
    const f = fixture();
    let issued = 0, ignored = 0;
    f.service.issue = () => { issued++; throw new Error('must not issue'); };
    f.bot.noteIgnoredCommand = () => { ignored++; };
    const create = f.prisma.adminAuditEvent.create;
    f.prisma.adminAuditEvent.create = async (args: any) => {
      const result = await create(args);
      if (kind === 'leave-rejoin') {
        f.bridge.emit('tsEvent', 9, 2, 'notifyclientleftview', { clid: '2' });
        f.bridge.emit('tsEvent', 9, 2, 'notifycliententerview', { clid: '2', ctid: '5' });
      }
      if (kind === 'bot-channel') f.bot.getCurrentChannelId = () => 6;
      if (kind === 'bot-status') f.bot.status = 'stopped';
      if (kind === 'flood') f.bot.floodHoldActive = true;
      return result;
    };
    await f.command();
    assert.equal(issued, 0, kind);
    assert.equal(f.audit[0].outcome, 'failure', kind);
    assert.equal(f.audit[0].resultCode, 'validation_failed', kind);
    assert.equal(f.privateReplies.some(message => message.text.includes('#token=')), false, kind);
    if (kind === 'flood') { assert.equal(ignored, 1); assert.deepEqual(f.privateReplies, []); }
    assert.deepEqual(f.channelReplies, [], kind);
  }
});

test('successful issuance audit records only allow-listed scope and outcome fields', async () => {
  const f = fixture();
  await f.command();
  assert.deepEqual(Object.keys(f.audit[0]).sort(), [
    'operationId', 'actorUserId', 'actorUsername', 'action', 'connectionId', 'virtualServerId',
    'targetType', 'targetId', 'outcome', 'resultCode', 'completedAt',
  ].sort());
});

test('missing and insecure Public URL fail privately before querying listeners', async () => {
  const previous = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  try {
    for (const url of [null, 'http://ts.example.test']) {
      const f = fixture(url);
      await f.command();
      assert.equal(f.privateReplies.length, 1);
      assert.match(f.privateReplies[0].text, /Public URL/);
      assert.deepEqual(f.queries, []);
      assert.deepEqual(f.channelReplies, []);
    }
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = previous;
  }
});

test('HTTP loopback Public URL works only outside production', async () => {
  const previous = process.env.NODE_ENV;
  try {
    for (const environment of ['development', 'production']) {
      process.env.NODE_ENV = environment;
      const f = fixture('http://127.0.0.1:3000');
      await f.command();
      if (environment === 'development') assert.match(f.privateReplies[0].text, /\/remote#token=/);
      else assert.match(f.privateReplies[0].text, /requires an HTTPS Public URL/);
      assert.deepEqual(f.channelReplies, []);
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

test('remote rejects missing, reused and query identities, managed bots, and non-listeners privately', async () => {
  for (const kind of ['missing', 'reused', 'query', 'managed-bot', 'elsewhere']) {
    const f = fixture();
    if (kind === 'query') f.bridge.executeCommand = async () => 'client_unique_identifier=human client_servergroups=6 client_type=1';
    if (kind === 'managed-bot') f.handler.musicBotClidsOnServer = () => new Set([2, 42]);
    if (kind === 'elsewhere') f.bridge.executeCommand = async (_config: number, _sid: number, command: string) => command.startsWith('clientinfo')
      ? 'client_unique_identifier=human client_servergroups=6 client_type=0'
      : 'clid=2 cid=6 client_type=0 client_unique_identifier=human';
    await f.command('!remote', kind === 'missing' ? null : kind === 'reused' ? 'previous-user' : 'human');
    assert.equal(f.privateReplies.length, 1, kind);
    assert.match(f.privateReplies[0].text, /verified listener/, kind);
    assert.deepEqual(f.channelReplies, [], kind);
  }
});

test('TeamSpeak flood hold suppresses remote checks, grants and replies', async () => {
  const f = fixture();
  let ignored = 0;
  f.bot.floodHoldActive = true;
  f.bot.noteIgnoredCommand = () => { ignored++; };
  await f.command();
  assert.equal(ignored, 1);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.privateReplies, []);
  assert.deepEqual(f.channelReplies, []);
});

test('flood hold beginning during remote checks prevents issuing a credential', async () => {
  const f = fixture();
  const query = f.bridge.executeCommand;
  let issued = 0, ignored = 0;
  f.bot.noteIgnoredCommand = () => { ignored++; };
  f.service.issue = () => { issued++; throw new Error('must not issue'); };
  f.bridge.executeCommand = async (...args: any[]) => {
    const result = await query(...args);
    if (args[2] === 'clientlist -uid') f.bot.floodHoldActive = true;
    return result;
  };
  await f.command();
  assert.equal(issued, 0);
  assert.equal(ignored, 1);
  assert.deepEqual(f.privateReplies, []);
  assert.deepEqual(f.channelReplies, []);
});

test('departure events expire tokens and sessions even when the listener immediately returns', async () => {
  for (const event of ['notifyclientmoved', 'notifyclientleftview']) {
    for (const exchange of [false, true]) {
      const f = fixture();
      await f.command();
      const session = exchange ? (await f.service.exchange(f.token(), async () => true)).session : undefined;
      // An unrelated SID cannot revoke access.
      f.bridge.emit('tsEvent', 9, 1, event, { clid: '2', ctid: '6' });
      f.bridge.emit('tsEvent', 9, 2, event, { clid: '2', ctid: '6' });
      f.bridge.emit('tsEvent', 9, 2, 'notifycliententerview', { clid: '2', ctid: '5' });
      await assert.rejects(session ? f.service.authenticate(session, async () => true) : f.service.exchange(f.token(), async () => true));
    }
  }
});

test('departure while a remote identity lookup is pending prevents late issuance', async () => {
  const f = fixture();
  const query = f.bridge.executeCommand;
  f.bridge.executeCommand = async (...args: any[]) => {
    const result = await query(...args);
    if (args[2].startsWith('clientinfo')) {
      f.bridge.emit('tsEvent', 9, 2, 'notifyclientleftview', { clid: '2' });
      f.bridge.emit('tsEvent', 9, 2, 'notifycliententerview', { clid: '2', ctid: '5' });
    }
    return result;
  };
  await f.command();
  assert.match(f.privateReplies[0].text, /verified listener/);
  assert.deepEqual(f.channelReplies, []);
});

test('voice departure, bot departure and disconnect revoke outstanding access', async () => {
  for (const kind of ['voice-departure', 'bot-departure', 'disconnect', 'error']) {
    const f = fixture();
    f.handler.registerBot(1, f.bot);
    await f.command();
    if (kind === 'voice-departure') f.bot.emit('command', { name: 'notifyclientleftview', params: { clid: '2' } });
    if (kind === 'bot-departure') f.bridge.emit('tsEvent', 9, 2, 'notifyclientmoved', { clid: '42', ctid: '6' });
    if (kind === 'disconnect') f.bot.emit('disconnected');
    if (kind === 'error') f.bot.emit('statusChange', 'error');
    await assert.rejects(f.service.exchange(f.token(), async () => true), kind);
  }
});

test('remote errors never echo service credentials or fall back to channel chat', async () => {
  const f = fixture();
  f.service.issue = () => { throw new Error('credential-that-must-not-be-echoed'); };
  await f.command();
  assert.equal(f.privateReplies.length, 1);
  assert.equal(f.privateReplies[0].text.includes('credential-that-must-not-be-echoed'), false);
  assert.deepEqual(f.channelReplies, []);
  resetChatReplyCooldownsForTests();
  f.bot.sendTextMessage = () => { throw new Error('private unavailable'); };
  await f.command();
  assert.deepEqual(f.channelReplies, []);
});
