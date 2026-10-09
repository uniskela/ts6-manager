import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseCommandBot, parseBotTarget, type ChannelBot } from './targeting.js';
import { resetChatReplyCooldownsForTests } from './dedupe.js';

const bots: ChannelBot[] = [
  { id: 1, names: ['Test', 'Test'], active: false },
  { id: 2, names: ['Bot 2', 'Bot2'], active: true },
];

describe('parseBotTarget', () => {
  it('reads a bare bot name as the whole argument of a no-argument command', () => {
    assert.deepEqual(parseBotTarget('voteskip', 'bot 2', bots), { botId: 2, args: '' });
    assert.deepEqual(parseBotTarget('next', 'bot 2', bots), { botId: 2, args: '' });
    assert.deepEqual(parseBotTarget('stop', '  Test ', bots), { botId: 1, args: '' });
  });

  it('keeps a bare name as the argument of a command that takes one', () => {
    assert.deepEqual(parseBotTarget('playlist', 'Test', bots), { botId: null, args: 'Test' });
    assert.deepEqual(parseBotTarget('playlist', 'Test @Bot 2', bots), { botId: 2, args: 'Test' });
  });

  it('reads a trailing @name and keeps the rest', () => {
    assert.deepEqual(parseBotTarget('vol', '30 @Bot 2', bots), { botId: 2, args: '30' });
    assert.deepEqual(parseBotTarget('next', '@test', bots), { botId: 1, args: '' });
  });

  it('leaves arguments alone when no bot is named', () => {
    assert.deepEqual(parseBotTarget('vol', '30', bots), { botId: null, args: '30' });
    assert.deepEqual(parseBotTarget('play', 'song by @someone', bots), { botId: null, args: 'song by @someone' });
    assert.deepEqual(parseBotTarget('play', 'mail@Test', bots), { botId: null, args: 'mail@Test' });
  });
});

describe('chooseCommandBot', () => {
  it('prefers the named bot, then the playing bot, then the lowest id', () => {
    assert.equal(chooseCommandBot(bots, 1), 1);
    assert.equal(chooseCommandBot(bots, null), 2);
    assert.equal(chooseCommandBot(bots.map((b) => ({ ...b, active: false })), null), 1);
    assert.equal(chooseCommandBot(bots.map((b) => ({ ...b, active: true })), null), 1);
    assert.equal(chooseCommandBot(bots, 99), 2, 'an unknown target falls back');
    assert.equal(chooseCommandBot([], null), null);
  });
});

describe('chat commands with two bots in one channel', async () => {
  const { MusicCommandHandler } = await import('../music-command-handler.js');

  function setup() {
    const makeBot = (id: number, name: string, status: string) => ({
      id, status, videoStreaming: false, ts3ClientId: 100 + id, floodHoldActive: false,
      currentConfig: { id, name, nickname: name, serverConfigId: 9 },
      getCurrentChannelId: () => 5,
    });
    const bots = new Map<number, any>([[1, makeBot(1, 'Test', 'connected')], [2, makeBot(2, 'Bot 2', 'playing')]]);
    const manager = {
      listBots: () => [...bots.keys()].map((id) => ({ id })),
      getBot: (id: number) => bots.get(id),
    };
    const handler = new MusicCommandHandler({ appSetting: { findUnique: async () => null }, musicBot: { findUnique: async () => ({ serverConfigId: 9, virtualServerId: 1 }) } } as any, manager as any) as any;
    for (const id of bots.keys()) handler.botChannelConfig.set(id, { serverConfigId: 9, virtualServerId: 1, defaultChannel: null, commandChannelIds: [] });
    const skips: number[] = [];
    const volumes: Array<[number, string]> = [];
    handler.handleSkip = async (bot: any) => { skips.push(bot.id); };
    handler.handleVolume = async (bot: any, _clid: number, args: string) => { volumes.push([bot.id, args]); };
    const say = async (msg: string) => {
      for (const [id, bot] of bots) await handler.onTextMessage(id, bot, { invokerid: '2', msg }, 5);
    };
    return { bots, handler, say, skips, volumes };
  }

  it('ignores a peer whose server is unknown', async () => {
    const f = setup();
    f.handler.botChannelConfig.delete(2);
    await f.say('!next');
    assert.deepEqual(f.skips, [1, 2], 'each bot acts alone, as before');
  });

  it('lets only the playing bot answer an unaddressed command', async () => {
    const f = setup();
    await f.say('!next');
    assert.deepEqual(f.skips, [2]);
  });

  it('stops only the lower-ID bot when both are playing', async () => {
    resetChatReplyCooldownsForTests();
    const f = setup();
    f.bots.get(1)!.status = 'playing';
    f.bots.get(2)!.status = 'playing';
    const stops: number[] = [];
    f.handler.handleStop = (bot: any) => {
      stops.push(bot.id);
      bot.status = 'connected';
    };
    await f.say('!stop');
    assert.deepEqual(stops, [1]);
  });

  it('lets a named bot answer and strips its name from the arguments', async () => {
    const f = setup();
    await f.say('!next Test');
    await f.say('!vol 30 @Test');
    assert.deepEqual(f.skips, [1]);
    assert.deepEqual(f.volumes, [[1, '30']]);
  });
});
