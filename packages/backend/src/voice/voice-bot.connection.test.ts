import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { SidecarClient } from './streaming/sidecar-client.js';
import { VoiceBot } from './voice-bot.js';

function makeBot(): VoiceBot {
  return new VoiceBot({
    id: 7, serverConfigId: 1, name: 'test', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50,
  });
}

describe('connection refusals', () => {
  for (const [id, msg] of [[1027, 'server maxclient reached'], [1028, 'invalid server password'], [3329, 'you are banned']] as const) {
    it(`treats ${id} (${msg}) as fatal so the manager does not keep retrying`, () => {
      const bot = makeBot();
      const fatal: string[] = [];
      bot.on('fatalError', (m: string) => fatal.push(m));
      (bot as any).client.emit('ts3error', { id: String(id), msg });
      assert.deepEqual(fatal, [`TS3 error ${id}: ${msg}`]);
      assert.equal(bot.status, 'error');
    });
  }

  it('does not treat a command permission error as a refusal', () => {
    const bot = makeBot();
    let fatal = 0;
    bot.on('fatalError', () => { fatal++; });
    (bot as any).client.emit('ts3error', { id: '2568', msg: 'insufficient client permissions' });
    assert.equal(fatal, 0);
    assert.notEqual(bot.status, 'error');
  });
});

describe('TeamSpeak anti-flood hold (error 524)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
  afterEach(() => mock.timers.reset());

  function connectedBot() {
    const bot = makeBot();
    const sent: string[] = [];
    (bot as any).client.sendCommand = (cmd: string) => sent.push(cmd);
    return { bot, sent };
  }

  it('holds chat for 30 s, restarted by each 524, then says once that commands were ignored', () => {
    const { bot, sent } = connectedBot();
    (bot as any).client.emit('ts3error', { id: '524', msg: 'client is flooding' });
    assert.equal(bot.floodHoldActive, true);

    bot.sendChannelMessage('Now playing: something');
    bot.sendTextMessage(3, 'reply');
    bot.noteIgnoredCommand();
    bot.noteIgnoredCommand();
    assert.equal(sent.length, 0, 'nothing is sent while the server is refusing us');

    mock.timers.tick(20_000);
    (bot as any).client.emit('ts3error', { id: '524', msg: 'client is flooding' });
    mock.timers.tick(20_000);
    assert.equal(bot.floodHoldActive, true, 'a further 524 restarts the hold');
    assert.equal(sent.length, 0);

    mock.timers.tick(10_000);
    assert.equal(bot.floodHoldActive, false);
    assert.equal(sent.length, 1, 'one notice, however many commands were ignored');
    assert.match(sent[0], /too\\sfast/, 'TeamSpeak-escaped notice text');

    bot.sendChannelMessage('back to normal');
    assert.equal(sent.length, 2);
  });

  it('still sends the notice if the timer fires a moment before the hold deadline', () => {
    const { bot, sent } = connectedBot();
    (bot as any).client.emit('ts3error', { id: '524', msg: 'client is flooding' });
    bot.noteIgnoredCommand();
    // Timers and Date.now() are separate clocks: end the hold "early".
    (bot as any)._floodHoldTimer && clearTimeout((bot as any)._floodHoldTimer);
    (bot as any).endFloodHold();
    assert.equal(sent.length, 1);
    assert.equal(bot.floodHoldActive, false);
  });

  it('stays quiet after the hold when nothing was ignored', () => {
    const { bot, sent } = connectedBot();
    (bot as any).client.emit('ts3error', { id: '524', msg: 'client is flooding' });
    mock.timers.tick(30_000);
    assert.equal(bot.floodHoldActive, false);
    assert.equal(sent.length, 0);
  });
});

describe('setupstream reply', () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.SIDECAR_URL;
  });

  function streamingReadyBot() {
    process.env.SIDECAR_URL = 'http://sidecar.test:9800';
    mock.method(SidecarClient.prototype, 'waitHealthy', async () => {});
    mock.method(SidecarClient.prototype, 'getEncoders', async () => ({
      available: ['vp8'], preferred: 'vp8', hardwareAvailable: false,
    }));
    mock.method(SidecarClient.prototype, 'stopSource', async () => {});
    // Source is prepared before setupstream; these tests only cover the TS reply.
    mock.method(VoiceBot.prototype as any, 'applyVideoSource', async function (this: any) {
      this._videoSourceMode = 'vod';
      this._videoPreset = '720p';
    });
    const bot = makeBot();
    const b = bot as any;
    b._status = 'connected';
    const sent: string[] = [];
    b.client.sendCommand = (cmd: string) => sent.push(cmd);
    b.client.getClientId = () => 42;
    return { bot, b, sent };
  }

  async function refuseNextSetup(b: any, sent: string[], id: string, msg: string) {
    // Let startVideoStream reach its (next) setupstream, then answer it as the server would.
    const setups = () => sent.filter((c) => c.startsWith('setupstream'));
    const before = b.__answeredSetups ?? 0;
    for (let i = 0; i < 50 && setups().length <= before; i++) {
      await new Promise((r) => setImmediate(r));
    }
    b.__answeredSetups = before + 1;
    const setup = setups()[before];
    const code = /return_code=(\S+)/.exec(setup)![1];
    b.client.emit('command', { name: 'error', params: { id, msg, return_code: code } });
  }

  it('fails the start at once with the server reason and cleans up', async () => {
    const { bot, b, sent } = streamingReadyBot();
    const listenersBefore = b.client.listenerCount('command');
    const started = bot.startVideoStream('https://example.com/v.mp4');
    await refuseNextSetup(b, sent, '524', 'client is flooding');
    await assert.rejects(started, /TeamSpeak refused the stream: client is flooding \(error 524\)/);
    assert.equal(bot.videoStreaming, false);
    assert.equal(b.signaling, null);
    assert.equal(b.client.listenerCount('command'), listenersBefore, 'no stream listener is left behind');
  });

  it('registers stream notifications once per connection', async () => {
    const { bot, b, sent } = streamingReadyBot();
    const registrations = () => sent.filter((c) => c.startsWith('servernotifyregister')).length;

    let started = bot.startVideoStream('https://example.com/v.mp4');
    await refuseNextSetup(b, sent, '2568', 'insufficient client permissions');
    await assert.rejects(started, /refused/);
    const first = registrations();
    assert.ok(first > 0);

    started = bot.startVideoStream('https://example.com/v.mp4');
    await refuseNextSetup(b, sent, '2568', 'insufficient client permissions');
    await assert.rejects(started, /refused/);
    assert.equal(registrations(), first, 'no re-registration on the same connection');

    b.client.emit('disconnected');
    b._status = 'connected';
    started = bot.startVideoStream('https://example.com/v.mp4');
    await refuseNextSetup(b, sent, '2568', 'insufficient client permissions');
    await assert.rejects(started, /refused/);
    assert.equal(registrations(), first * 2, 'registered again after a reconnect');
  });
});
