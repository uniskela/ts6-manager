import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VoiceBot } from './voice-bot.js';
import { saveBotVolume } from './bot-volume.js';

function makeBot(volume = 100) {
  return new VoiceBot({
    id: 1,
    serverConfigId: 1,
    name: 'DJ',
    nickname: 'DJ',
    serverHost: '127.0.0.1',
    serverPort: 9987,
    volume,
  });
}

describe('shared volume persistence emit', () => {
  it('emits volumeChange when the level changes, not when it stays the same', async () => {
    const bot = makeBot(100);
    const seen: number[] = [];
    bot.on('volumeChange', (v: number) => seen.push(v));

    await bot.applyVolume(100);
    assert.deepEqual(seen, [], 'no-op must not emit (would re-save 100 on every stream start)');

    await bot.applyVolume(40);
    assert.deepEqual(seen, [40]);
    assert.equal(bot.currentConfig.volume, 40);

    await bot.applyVolume(40);
    assert.deepEqual(seen, [40], 'repeated identical values produce no redundant emits/writes');
  });

  it('starts from the configured volume instead of a hard-coded 100%', () => {
    const bot = makeBot(35);
    assert.equal(bot.currentConfig.volume, 35);
    assert.equal((bot as any)._videoStreamVolume, 35);
  });

  it('stream-style assign of the current level does not persist again', async () => {
    const bot = makeBot(55);
    const saved: number[] = [];
    bot.on('volumeChange', (v: number) => {
      void saveBotVolume(
        { musicBot: { update: async ({ data }: { data: { volume: number } }) => { saved.push(data.volume); } } },
        1,
        v,
      );
    });

    // startVideoStreamClaimed calls assignSharedVolume(options.volume ?? config.volume)
    await bot.applyVolume(55);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(saved, [], 'unchanged stream start must not write the DB');
  });

  it('setVolume (flow / Discord) emits once and can be persisted', async () => {
    const bot = makeBot(100);
    const seen: number[] = [];
    bot.on('volumeChange', (v: number) => seen.push(v));
    bot.setVolume(22);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [22]);
    assert.equal(bot.currentConfig.volume, 22);
  });
});
