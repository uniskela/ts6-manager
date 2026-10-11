import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotAutomationSettings } from '@ts6/common';
import { VoiceBotManager } from './voice-bot-manager.js';
import type { VoiceBot, VoiceBotConfig } from './voice-bot.js';
import { generateIdentity } from './tslib/identity.js';

const settings: BotAutomationSettings = { enabled: false, source: null, requireListeners: true,
  quietPeriodSeconds: 300, retryBaseSeconds: 30, retryMaxSeconds: 1800, stayInChannel: true };

function fixture() {
  const saved: Array<Record<string, unknown>> = [];
  const database = {
    musicBot: { update: async ({ data }: { data: Record<string, unknown> }) => { saved.push(data); } },
    playlist: { findFirst: async (_query: unknown) => null as any },
    radioStation: { findFirst: async (_query: unknown) => null as any },
  };
  const manager = new VoiceBotManager(database as any, { clients: new Set() } as any);
  const runtime = manager as any;
  runtime.broadcast = () => {};
  const starts: Array<{ id: number; defaultChannel?: string }> = [];
  function create(id: number, state: Record<string, unknown> = {}, config: Partial<VoiceBotConfig> = {}) {
    const bot = runtime.createBotInstance({ id, name: `DJ ${id}`, nickname: `DJ ${id}`, serverConfigId: 1,
      serverHost: '127.0.0.1', serverPort: 9987, volume: 50, defaultChannel: '9', identity: generateIdentity(0), ...config },
    undefined, JSON.stringify(settings), JSON.stringify(state)) as VoiceBot;
    const voice = bot as any;
    let channel = 9;
    voice.client.connect = async (options: { defaultChannel?: string }) => {
      starts.push({ id, defaultChannel: options.defaultChannel });
      channel = Number(options.defaultChannel || 9);
    };
    voice.client.disconnect = () => voice.client.emit('disconnected');
    voice.client.sendCommand = () => {};
    voice.client.sendVoiceStop = () => {};
    voice.client.getClientId = () => id + 10;
    voice.client.getCurrentChannelId = () => channel;
    voice.client.getChannelMemberClids = () => [];
    voice.applyAvatar = async () => {};
    runtime.bots.set(id, bot);
    return bot;
  }
  return { manager, runtime, database, create, saved, starts, close: () => manager.stopAll() };
}

describe('VoiceBotManager Auto-DJ integration', () => {
  it('reconnect uses the saved persistent channel and manual Home/Leave suppression uses configured home', async t => {
    const f = fixture(); t.after(() => f.close());
    const bot = f.create(1, { channelId: 42 });
    await bot.start();
    assert.equal(f.starts[0].defaultChannel, '42');
    assert.equal(bot.automation?.keepChannel, true);
    await bot.stop();
    bot.automation?.suspendPresence();
    await bot.start();
    assert.equal(f.starts[1].defaultChannel, '9');
    assert.equal(bot.automation?.keepChannel, false);
    assert.equal(bot.automation?.state.channelId, 42);
  });

  it('manager Stop persists suppression and explicit Start restores the remembered channel', async t => {
    const f = fixture(); t.after(() => f.close());
    const bot = f.create(1, { channelId: 42 });
    await f.manager.startBot(1);
    await f.manager.stopBot(1);
    assert.equal(bot.status, 'stopped');
    assert.equal(bot.automation?.state.presenceSuppressed, true);
    assert.equal(JSON.parse(f.saved.at(-1)!.automationState as string).presenceSuppressed, true);
    await f.manager.startBot(1);
    assert.equal(bot.status, 'connected');
    assert.equal(bot.automation?.state.presenceSuppressed, false);
    assert.equal(f.starts.at(-1)?.defaultChannel, '42');
  });

  it('Home reconnects to the configured home and retains suppression until explicit Start', async t => {
    const f = fixture(); t.after(() => f.close());
    const bot = f.create(1, { channelId: 42 });
    await f.manager.startBot(1);
    await f.manager.homeBot(1);
    assert.equal(bot.status, 'connected');
    assert.equal(f.starts.at(-1)?.defaultChannel, '9');
    assert.equal(bot.automation?.state.presenceSuppressed, true);
    assert.equal(bot.automation?.state.channelId, 42);
    await f.manager.stopBot(1);
    await f.manager.startBot(1);
    assert.equal(f.starts.at(-1)?.defaultChannel, '42');
    assert.equal(bot.automation?.state.presenceSuppressed, false);
  });

  it('excludes managed voice bots from human listeners within the same virtual server', async t => {
    const f = fixture(); t.after(() => f.close());
    const bot = f.create(1);
    const peer = f.create(2);
    const otherServer = f.create(3, {}, { serverPort: 9988 });
    await Promise.all([bot.start(), peer.start(), otherServer.start()]);
    (bot as any).client.getChannelMemberClids = () => [12, 13, 99];
    assert.equal(f.runtime.humanListenerCount(bot), 2, 'bot 2 is excluded, the other virtual server is independent');
    (peer as any)._status = 'error';
    assert.equal(f.runtime.humanListenerCount(bot), 3, 'a disconnected bot’s stale ID may now belong to a human');
    (otherServer as any).client.getChannelMemberClids = () => [12, 99];
    assert.equal(f.runtime.humanListenerCount(otherServer), 2);
  });

  it('selects the next saved playlist song and wraps after the last remembered track', async t => {
    const f = fixture(); t.after(() => f.close());
    let query: any;
    f.database.playlist.findFirst = async value => {
      query = value;
      return { songs: [
        { song: { id: 4, title: 'First', filePath: '/first.mp3', source: 'local' } },
        { song: { id: 7, title: 'Second', filePath: '/second.mp3', source: 'local' } },
      ] };
    };
    assert.equal((await f.runtime.loadAutomationSource(2, { kind: 'playlist', id: 10 }, null)).id, '4');
    assert.equal((await f.runtime.loadAutomationSource(2, { kind: 'playlist', id: 10 }, '4')).id, '7');
    assert.equal((await f.runtime.loadAutomationSource(2, { kind: 'playlist', id: 10 }, '7')).id, '4');
    assert.equal((await f.runtime.loadAutomationSource(2, { kind: 'playlist', id: 10 }, 'deleted-track')).id, '4');
    assert.equal(query.where.id, 10);
    assert.deepEqual(query.where.OR, [{ serverConfigId: 2 }, { serverConfigId: null }]);
    assert.deepEqual(query.include.songs.orderBy, { position: 'asc' });
  });

  it('requires a radio source from the bot server and rejects deleted or empty saved sources', async t => {
    const f = fixture(); t.after(() => f.close());
    let query: any;
    f.database.radioStation.findFirst = async value => {
      query = value;
      return { id: 8, name: 'Station', url: 'https://example.com/radio', genre: 'Jazz' };
    };
    const radio = await f.runtime.loadAutomationSource(3, { kind: 'radio', id: 8 }, null);
    assert.deepEqual(query.where, { id: 8, serverConfigId: 3 });
    assert.equal(radio.streamUrl, 'https://example.com/radio');
    f.database.radioStation.findFirst = async () => null;
    await assert.rejects(f.runtime.loadAutomationSource(3, { kind: 'radio', id: 8 }, null), /no longer exists/);
    await assert.rejects(f.runtime.loadAutomationSource(3, { kind: 'playlist', id: 8 }, null), /missing or empty/);
    f.database.playlist.findFirst = async () => ({ songs: [] });
    await assert.rejects(f.runtime.loadAutomationSource(3, { kind: 'playlist', id: 8 }, null), /missing or empty/);
  });
});
