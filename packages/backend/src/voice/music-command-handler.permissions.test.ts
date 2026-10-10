import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MusicCommandHandler, resetChatReplyCooldownsForTests } from './music-command-handler.js';

function fixture(policy: unknown = null) {
  resetChatReplyCooldownsForTests();
  const privateReplies: string[] = [], actions: string[] = [];
  const prisma = { appSetting: { findUnique: async () => policy == null ? null : { value: JSON.stringify(policy) } } } as any;
  const handler = new MusicCommandHandler(prisma, {} as any) as any;
  const bot: any = { currentConfig: { id: 1, serverConfigId: 9 }, ts3ClientId: 42, status: 'playing', nowPlaying: { id: 'song' }, playbackToken: {},
    sendTextMessage: (_clid: number, text: string) => privateReplies.push(text),
    getCurrentChannelId: () => 5,
  };
  handler.botChannelConfig.set(1, { serverConfigId: 9, virtualServerId: 2 });
  for (const method of ['handlePlay', 'handleSkip', 'handleStop', 'handleVolume', 'handleQueue', 'handleShuffle', 'handleStream', 'handleTv', 'handleStopStream', 'handleHere', 'handleHelp', 'handleNowPlaying', 'handleChannels']) {
    handler[method] = async () => { actions.push(method); };
  }
  handler.eventBridge = { executeCommand: async () => 'client_unique_identifier=human client_servergroups=6 client_type=0' };
  const command = (msg: string, uid: string | undefined = 'human') => handler.onTextMessage(1, bot, { invokerid: '2', ...(uid ? { invokeruid: uid } : {}), msg });
  return { handler, bot, privateReplies, actions, command };
}
const restricted = { playback: { mode: 'server_groups', serverGroupIds: [9] }, queue: { mode: 'server_groups', serverGroupIds: [9] }, video: { mode: 'server_groups', serverGroupIds: [9] } };

test('all command groups enforce roles before side effects and deny privately once', async () => {
  const f = fixture(restricted);
  for (const cmd of ['!play song', '!stop', '!skip', '!next', '!volume 50', '!queue clear', '!add url', '!shuffle', '!tv station', '!iptv station', '!stream url', '!stopstream', '!here']) await f.command(cmd);
  assert.deepEqual(f.actions, []);
  assert.equal(f.privateReplies.length, 1);
  assert.match(f.privateReplies[0], /not allowed/i);
});

test('info/help and read-only forms remain accessible with restricted permissions', async () => {
  const f = fixture(restricted);
  for (const cmd of ['!help', '!np', '!channels', '!queue show', '!queue', '!vol']) await f.command(cmd);
  assert.deepEqual(f.actions, ['handleHelp', 'handleNowPlaying', 'handleChannels', 'handleQueue', 'handleQueue', 'handleVolume']);
  assert.deepEqual(f.privateReplies, []);
});

test('Everyone is the upgrade default and does not require identity lookup', async () => {
  const f = fixture();
  f.handler.eventBridge = null;
  await f.command('!play song', undefined);
  await f.command('!stream url', undefined);
  await f.command('!queue clear', undefined);
  assert.deepEqual(f.actions, ['handlePlay', 'handleStream', 'handleQueue']);
});

test('matching server groups work while unavailable or mismatched identities fail closed', async () => {
  const f = fixture({ ...restricted, playback: { mode: 'server_groups', serverGroupIds: [6] } });
  await f.command('!skip');
  assert.deepEqual(f.actions, ['handleSkip']);
  await f.command('!skip', 'reused-clid');
  f.handler.eventBridge = null;
  await f.command('!play song');
  assert.deepEqual(f.actions, ['handleSkip']);
  assert.equal(f.privateReplies.length, 1);
});

test('TeamSpeak flood hold suppresses checks, actions and denied replies', async () => {
  const f = fixture(restricted);
  let ignored = 0;
  f.bot.floodHoldActive = true;
  f.bot.noteIgnoredCommand = () => { ignored++; };
  f.handler.eventBridge.executeCommand = async () => { throw new Error('must not query'); };
  await f.command('!skip');
  assert.equal(ignored, 1);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.privateReplies, []);
});

test('vote-skip excludes bots, deduplicates identities and advances once per track', async () => {
  const f = fixture(restricted);
  f.handler.musicBotClidsOnServer = () => new Set([42, 43]);
  f.handler.eventBridge.executeCommand = async () => 'clid=2 cid=5 client_type=0 client_unique_identifier=a|clid=3 cid=5 client_type=0 client_unique_identifier=b|clid=4 cid=5 client_type=0 client_unique_identifier=c|clid=42 cid=5 client_type=0 client_unique_identifier=self|clid=43 cid=5 client_type=0 client_unique_identifier=otherbot|clid=44 cid=5 client_type=1 client_unique_identifier=query';
  await f.handler.onTextMessage(1, f.bot, { invokerid: '2', invokeruid: 'a', msg: '!voteskip' });
  await f.handler.onTextMessage(1, f.bot, { invokerid: '2', invokeruid: 'a', msg: '!voteskip' });
  assert.deepEqual(f.actions, []);
  await Promise.all([3, 4].map(id => f.handler.onTextMessage(1, f.bot, { invokerid: String(id), invokeruid: id === 3 ? 'b' : 'c', msg: '!voteskip' })));
  assert.deepEqual(f.actions, ['handleSkip']);
  f.bot.playbackToken = {};
  await f.handler.onTextMessage(1, f.bot, { invokerid: '2', invokeruid: 'a', msg: '!voteskip' });
  assert.deepEqual(f.actions, ['handleSkip']);
});

test('vote-skip rejects missing identities, non-listeners and track changes during roster lookup', async () => {
  const f = fixture();
  f.handler.musicBotClidsOnServer = () => new Set([42]);
  f.handler.eventBridge.executeCommand = async () => 'clid=2 cid=5 client_type=0 client_unique_identifier=a';
  await f.command('!voteskip', 'someone-else');
  await f.handler.onTextMessage(1, f.bot, { invokerid: '3', invokeruid: 'a', msg: '!voteskip' });
  f.handler.eventBridge.executeCommand = async () => { f.bot.playbackToken = {}; return 'clid=2 cid=5 client_type=0 client_unique_identifier=human'; };
  await f.command('!voteskip');
  assert.deepEqual(f.actions, []);
});


test('missing channel mapping resolves the persisted SID instead of defaulting to Everyone on SID 1', async () => {
  const f = fixture(restricted);
  f.handler.botChannelConfig.clear();
  f.handler.prisma.musicBot = { findUnique: async () => ({ serverConfigId: 9, virtualServerId: 2 }) };
  f.handler.prisma.appSetting.findUnique = async ({ where }: any) => {
    assert.equal(where.key, 'media_command_permissions:9:2');
    return { value: JSON.stringify(restricted) };
  };
  await f.command('!skip');
  assert.deepEqual(f.actions, []);
  assert.equal(f.privateReplies.length, 1);
  f.handler.prisma.musicBot.findUnique = async () => null;
  await f.command('!play song');
  assert.deepEqual(f.actions, []);
});
