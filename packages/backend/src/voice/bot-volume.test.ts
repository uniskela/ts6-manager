import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { saveBotVolume } from './bot-volume.js';

/** Same fire-and-forget persist the manager attaches to volumeChange. */
function attachVolumePersist(
  bot: EventEmitter,
  prisma: { musicBot: { update: (args: any) => Promise<unknown> } },
  botId: number,
  onError?: (err: Error) => void,
) {
  bot.on('volumeChange', (volume: number) => {
    void saveBotVolume(prisma, botId, volume).catch((err: Error) => onError?.(err));
  });
}

function prismaRecorder(
  saved: Array<{ id: number; volume: number }>,
  write?: (volume: number, id: number) => Promise<void>,
) {
  return {
    musicBot: {
      update: async ({ where, data }: { where: { id: number }; data: { volume: number } }) => {
        if (write) await write(data.volume, where.id);
        saved.push({ id: where.id, volume: data.volume });
      },
    },
  };
}

async function drain() {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}

describe('saveBotVolume', () => {
  it('writes for one bot complete in request order', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const saved: Array<{ id: number; volume: number }> = [];
    let writes = 0;
    const prisma = prismaRecorder(saved, async (volume) => {
      writes++;
      if (volume === 20) await gate;
    });

    const slow = saveBotVolume(prisma, 1, 20);
    while (writes === 0) await new Promise((r) => setImmediate(r));
    const fast = saveBotVolume(prisma, 1, 30);
    await drain();
    release();
    await Promise.all([slow, fast]);
    assert.deepEqual(saved.map((s) => s.volume), [20, 30]);
  });

  it('keeps volume queues independent across bots', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const saved: Array<{ id: number; volume: number }> = [];
    let bot1Started = 0;
    const prisma = prismaRecorder(saved, async (volume, id) => {
      if (id === 1 && volume === 11) {
        bot1Started++;
        await gate;
      }
    });

    const slowA = saveBotVolume(prisma, 1, 11);
    while (bot1Started === 0) await new Promise((r) => setImmediate(r));
    await saveBotVolume(prisma, 2, 22);
    assert.deepEqual(saved, [{ id: 2, volume: 22 }], 'bot 2 must not wait on bot 1');

    release();
    await slowA;
    assert.deepEqual(saved, [
      { id: 2, volume: 22 },
      { id: 1, volume: 11 },
    ]);
  });

  it('surfaces a rejected write without leaving the queue stuck', async () => {
    const saved: number[] = [];
    let failOnce = true;
    const prisma = {
      musicBot: {
        update: async ({ data }: { data: { volume: number } }) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('db down');
          }
          saved.push(data.volume);
        },
      },
    };

    await assert.rejects(() => saveBotVolume(prisma, 1, 40), /db down/);
    await saveBotVolume(prisma, 1, 50);
    assert.deepEqual(saved, [50]);
  });
});

describe('volumeChange persistence (manager contract)', () => {
  it('!vol / Discord / flow share one emit path that persists the level', async () => {
    const saved: Array<{ id: number; volume: number }> = [];
    const bot = new EventEmitter() as EventEmitter & {
      applyVolume(v: number): Promise<void>;
      setVolume(v: number): void;
    };
    let current = 100;
    bot.applyVolume = async (v: number) => {
      if (v === current) return;
      current = v;
      bot.emit('volumeChange', v);
    };
    bot.setVolume = (v: number) => { void bot.applyVolume(v); };

    attachVolumePersist(bot, prismaRecorder(saved), 7);

    await bot.applyVolume(35); // chat !vol
    bot.setVolume(40); // Discord / Bot Flow voiceVolume
    await drain();
    assert.deepEqual(saved.map((s) => s.volume), [35, 40]);
  });

  it('a saved level is what the next session would load', async () => {
    const db = new Map<number, number>([[3, 100]]);
    const prisma = {
      musicBot: {
        update: async ({ where, data }: { where: { id: number }; data: { volume: number } }) => {
          db.set(where.id, data.volume);
        },
      },
    };
    const bot = new EventEmitter();
    attachVolumePersist(bot, prisma, 3);

    bot.emit('volumeChange', 28);
    await drain();
    assert.equal(db.get(3), 28, 'restart would construct VoiceBot with dbBot.volume');
  });

  it('rapid successive changes keep the latest volume last even with delayed writes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const saved: Array<{ id: number; volume: number }> = [];
    let started = 0;
    const prisma = prismaRecorder(saved, async (volume) => {
      started++;
      if (volume === 10) await gate;
    });
    const bot = new EventEmitter();
    attachVolumePersist(bot, prisma, 1);

    bot.emit('volumeChange', 10);
    while (started === 0) await new Promise((r) => setImmediate(r));
    bot.emit('volumeChange', 20);
    bot.emit('volumeChange', 30);
    await drain();
    release();
    await drain();
    assert.deepEqual(saved.map((s) => s.volume), [10, 20, 30]);
    assert.equal(saved.at(-1)?.volume, 30);
  });

  it('a database write failure does not throw into the volumeChange path', async () => {
    const errors: string[] = [];
    const prisma = {
      musicBot: {
        update: async () => { throw new Error('disk full'); },
      },
    };
    const bot = new EventEmitter();
    attachVolumePersist(bot, prisma, 9, (err) => errors.push(err.message));

    assert.doesNotThrow(() => bot.emit('volumeChange', 12));
    await drain();
    assert.deepEqual(errors, ['disk full']);
  });
});
