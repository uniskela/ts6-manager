import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MusicCommandHandler, resetChatReplyCooldownsForTests } from './music-command-handler.js';

afterEach(() => resetChatReplyCooldownsForTests());

function fixture(helperResult = true) {
  const voice: string[] = [];
  const ssh: Array<{ cid: number; msg: string }> = [];
  let paused = false;
  const bot = {
    currentConfig: { id: 1, serverConfigId: 9 },
    ts3ClientId: 101,
    status: 'playing',
    floodHoldActive: false,
    getCurrentChannelId: () => 5,
    pause: () => { paused = true; },
    sendChannelMessage: (msg: string) => voice.push(msg),
  };
  const handler = new MusicCommandHandler({
    appSetting: { findUnique: async () => null },
    musicBot: { findUnique: async () => ({ serverConfigId: 9 }) },
    chatCommand: { findMany: async () => [] },
  } as any, { getBot: () => bot } as any) as any;
  handler.botChannelConfig.set(1, {
    serverConfigId: 9, virtualServerId: 1, defaultChannel: '5', commandChannelIds: [],
  });
  handler.eventBridge = {
    sendChannelText: async (configId: number, sid: number, cid: number, msg: string) => {
      assert.equal(configId, 9);
      assert.equal(sid, 1);
      ssh.push({ cid, msg });
      return helperResult;
    },
  };
  return { handler, bot, voice, ssh, paused: () => paused };
}

test('in-channel !help uses the checked SSH reply path without a duplicate voice reply', async () => {
  const f = fixture();
  await f.handler.onTextMessage(1, f.bot, { invokerid: '3', msg: '!help' }, 5);
  assert.equal(f.ssh.length, 1);
  assert.equal(f.ssh[0]!.cid, 5);
  assert.match(f.ssh[0]!.msg, /Music bot commands/i);
  assert.deepEqual(f.voice, []);
});

test('in-channel !pause replies through SSH as well as pausing playback', async () => {
  const f = fixture();
  await f.handler.onTextMessage(1, f.bot, { invokerid: '3', msg: '!pause' }, 5);
  assert.equal(f.paused(), true);
  assert.deepEqual(f.ssh, [{ cid: 5, msg: 'Paused.' }]);
  assert.deepEqual(f.voice, []);
});

test('a failed SSH reply falls back to voice in the bot channel', async () => {
  const f = fixture(false);
  await f.handler.onTextMessage(1, f.bot, { invokerid: '3', msg: '!help' }, 5);
  assert.equal(f.ssh.length, 1);
  assert.equal(f.voice.length, 1);
  assert.equal(f.voice[0], f.ssh[0]!.msg);
});

test('voice-only commands still reply without an SSH bridge', async () => {
  const f = fixture();
  f.handler.eventBridge = null;
  await f.handler.onTextMessage(1, f.bot, { invokerid: '3', msg: '!help' }, 5);
  assert.equal(f.voice.length, 1);
  assert.deepEqual(f.ssh, []);
});

test('cross-channel replies retain the requester channel', async () => {
  const f = fixture();
  await f.handler.onTextMessage(1, f.bot, { invokerid: '3', msg: '!pause' }, 20);
  assert.deepEqual(f.ssh, [{ cid: 20, msg: 'Paused.' }]);
  assert.deepEqual(f.voice, []);
});

test('a flood hold suppresses both reply paths', async () => {
  const f = fixture();
  f.bot.floodHoldActive = true;
  await f.handler.reply(f.bot, 3, 'Paused.');
  assert.deepEqual(f.ssh, []);
  assert.deepEqual(f.voice, []);
});
