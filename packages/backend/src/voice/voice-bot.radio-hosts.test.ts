import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VoiceBot, type VoiceBotConfig } from './voice-bot.js';

const LAN_STATION = { id: 'radio_1', title: 'LAN radio', source: 'radio' as const, filePath: '', streamUrl: 'http://192.168.1.20:8000/live' };

/** A connected bot whose radio opens are recorded instead of run. */
function makeBot(loadRadioLocalHosts?: VoiceBotConfig['loadRadioLocalHosts']) {
  const bot = new VoiceBot({
    id: 7, serverConfigId: 1, name: 'DJ', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'DJ', volume: 50,
    loadRadioLocalHosts,
  });
  const b = bot as any;
  b._status = 'connected';
  b.client.sendVoiceStop = () => {};
  b.client.sendCommand = () => {};
  b.updateNowPlayingNickname = () => {};
  const icy: Array<Promise<readonly string[]>> = [];
  b.startIcyPolling = (_url: string, hosts: Promise<readonly string[]>) => { icy.push(hosts); };
  const opened: Array<{ url: string; hosts: Promise<readonly string[]> }> = [];
  b.pipeline.toPcmStream = (url: string, hosts: Promise<readonly string[]>) => {
    opened.push({ url, hosts });
    return Promise.reject(new Error('no network in tests'));
  };
  bot.on('error', () => {});
  return { bot, opened, icy };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('radio local hosts reach every radio start', () => {
  it('passes the operator list to the stream and the ICY request', async () => {
    const { bot, opened, icy } = makeBot(async () => ['192.168.1.20']);
    await assert.rejects(bot.playStream(LAN_STATION), /no network/);
    assert.equal(opened.length, 1);
    assert.deepEqual(await opened[0].hosts, ['192.168.1.20']);
    assert.deepEqual(await icy[0], ['192.168.1.20']);
  });

  it('opens the stream without waiting for the list to load', () => {
    let release!: (hosts: string[]) => void;
    const { bot, opened } = makeBot(() => new Promise((resolve) => { release = resolve; }));
    void bot.playStream(LAN_STATION).catch(() => {});
    assert.equal(opened.length, 1, 'toPcmStream is called on the same tick');
    release([]);
  });

  it('uses the list again when a paused station resumes', async () => {
    const { bot, opened } = makeBot(async () => ['192.168.1.20']);
    const b = bot as any;
    b._status = 'paused';
    b._isStreaming = true;
    b._nowPlaying = LAN_STATION;
    bot.resume();
    await settle();
    assert.equal(opened.length, 1);
    assert.deepEqual(await opened[0].hosts, ['192.168.1.20']);
  });

  it('uses the list when skip moves to a queued station', async () => {
    const { bot, opened } = makeBot(async () => ['192.168.1.20']);
    const b = bot as any;
    b._status = 'playing';
    b._nowPlaying = { id: 'now', title: 'Now', source: 'local', filePath: '/now.mp3' };
    bot.queue.add(LAN_STATION);
    bot.skip();
    await settle();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, LAN_STATION.streamUrl);
    assert.deepEqual(await opened[0].hosts, ['192.168.1.20']);
  });

  it('treats a missing or unreadable list as no allowed hosts', async () => {
    for (const loader of [undefined, async () => { throw new Error('settings store unavailable'); }]) {
      const { bot, opened } = makeBot(loader);
      await assert.rejects(bot.playStream(LAN_STATION), /no network/);
      assert.deepEqual(await opened[0].hosts, []);
    }
  });

  it('never gives ordinary stream items the operator radio LAN allowance', async () => {
    for (const source of ['url', 'youtube', 'local'] as const) {
      let loadCalls = 0;
      const { bot, opened, icy } = makeBot(async () => {
        loadCalls++;
        return ['192.168.1.20'];
      });
      const ordinaryStream = { ...LAN_STATION, id: `ordinary-${source}`, source };
      await assert.rejects(bot.playStream(ordinaryStream), /no network/);
      assert.equal(opened.length, 1);
      assert.deepEqual(await opened[0].hosts, [], `${source} must use strict public-address validation`);
      assert.deepEqual(await icy[0], [], `${source} ICY metadata must use the same strict rule`);
      assert.equal(loadCalls, 0, `${source} must not consult the radio allowlist`);
    }
  });
});
