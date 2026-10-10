import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { VoiceBotManager } from './voice-bot-manager.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakePrisma() {
  const state = {
    rows: [
      { id: 'a', musicBotId: 1, position: 0, source: 'https://video.example.test/a', title: 'A', durationSec: null, sourceMode: 'auto', addedBy: 'admin' },
      { id: 'b', musicBotId: 1, position: 1, source: 'https://video.example.test/b', title: 'B', durationSec: null, sourceMode: 'auto', addedBy: 'admin' },
    ] as Array<Record<string, unknown>>,
    entryDeletes: [] as unknown[],
    botDeletes: [] as unknown[],
    failTransactions: false,
  };
  const prisma = {
    appSetting: {
      findUnique: async () => null,
      upsert: async () => {},
      deleteMany: async () => {},
    },
    musicBot: {
      findMany: async () => [{
        id: 1,
        serverConfigId: 3,
        name: 'Bot',
        nickname: 'Bot',
        voicePort: 9987,
        volume: 50,
        autoStart: false,
        avatarMode: 'none',
        avatarFile: null,
        avatarMd5: null,
        identityData: null,
        serverConfig: { host: '127.0.0.1' },
      }],
      delete: async (args: unknown) => { state.botDeletes.push(args); },
    },
    videoQueueEntry: {
      findMany: async (args: any) => state.rows.filter((r) => r.musicBotId === args.where.musicBotId),
      deleteMany: async (args: any) => {
        state.entryDeletes.push(args);
        state.rows = state.rows.filter((r) => r.musicBotId !== args.where.musicBotId);
      },
      createMany: async (args: any) => { state.rows.push(...args.data); },
    },
    $transaction: async (work: unknown) => {
      if (state.failTransactions) {
        // The queued operations still ran against the fake; only the commit fails.
        await Promise.allSettled(work as Promise<unknown>[]);
        throw new Error('database is locked');
      }
      return Promise.all(work as Promise<unknown>[]);
    },
  };
  return { prisma, state };
}

async function startedManager() {
  const { prisma, state } = fakePrisma();
  const manager = new VoiceBotManager(prisma as any, { clients: new Set() } as any);
  await manager.start();
  const bot = manager.getBot(1)!;
  return { manager, bot, b: bot as any, state };
}

describe('voice bot manager: video queue', () => {
  afterEach(() => mock.restoreAll());

  it('a bot loads its saved lane as kept', async () => {
    const { manager } = await startedManager();
    const state = manager.getVideoQueue(1)!.snapshot();
    assert.equal(state.kept, true);
    assert.equal(state.current, null);
    assert.deepEqual(state.upNext.map((i) => i.id), ['a', 'b']);
  });

  it('videoStreamStopped reaches the controller', async () => {
    const { manager, bot } = await startedManager();
    bot.emit('videoStreamStopped', { reason: 'manual', at: Date.now(), detail: null });
    await tick();
    assert.deepEqual(manager.getVideoQueue(1)!.snapshot(), { current: null, upNext: [], kept: false });
  });

  it('disconnect stops a running stream with server_disconnect', async () => {
    const { manager, bot, b } = await startedManager();
    const order: string[] = [];
    b._videoStreaming = true;
    b.stopVideoStream = async (reason: string, detail: string) => {
      order.push(`stop:${reason}:${detail}`);
      b._videoStreaming = false;
    };
    (manager as any).scheduleReconnect = () => order.push('reconnect');
    bot.emit('disconnected');
    await tick();
    assert.deepEqual(order, ['stop:server_disconnect:Disconnected from the TeamSpeak server', 'reconnect']);
  });

  it('a disconnect still reconnects when stopping the stream fails', async () => {
    const { manager, bot, b } = await startedManager();
    mock.method(console, 'error', () => {});
    let reconnects = 0;
    b._videoStreaming = true;
    b.stopVideoStream = async () => { throw new Error('sidecar gone'); };
    (manager as any).scheduleReconnect = () => { reconnects++; };
    bot.emit('disconnected');
    await tick();
    assert.equal(reconnects, 1);
  });

  it('a failing save does not break an advance', async () => {
    const { manager, b, state } = await startedManager();
    const logged = mock.method(console, 'error', () => {});
    const switched: string[] = [];
    b._videoStreaming = true;
    b._videoSource = 'https://video.example.test/running';
    b.setVideoSource = async (source: string) => { switched.push(source); };
    state.failTransactions = true;
    const queue = manager.getVideoQueue(1)!;
    await queue.clear();
    await queue.enqueue([{ source: 'https://video.example.test/next', title: 'Next', sourceMode: 'auto' }]);
    assert.equal(await queue.onSourceFinished('source_ended', null), true);
    assert.deepEqual(switched, ['https://video.example.test/next']);
    assert.equal(queue.snapshot().current?.source, 'https://video.example.test/next');
    assert.ok(logged.mock.callCount() >= 1);
  });

  it('the bot hook reaches the controller', async () => {
    const { manager, b } = await startedManager();
    const switched: string[] = [];
    b._videoStreaming = true;
    b._videoSource = 'https://video.example.test/running';
    b.setVideoSource = async (source: string) => { switched.push(source); };
    const queue = manager.getVideoQueue(1)!;
    await queue.clear();
    await queue.enqueue([{ source: 'https://video.example.test/next', title: 'Next', sourceMode: 'auto' }]);
    await b.handleVideoSourceFinished('source_ended', 'Video reached its end');
    assert.deepEqual(switched, ['https://video.example.test/next']);
    assert.equal(b._videoStreaming, true);
  });

  it('removing a bot deletes its lane', async () => {
    const { manager, state } = await startedManager();
    await manager.removeBot(1);
    assert.deepEqual(state.entryDeletes.at(-1), { where: { musicBotId: 1 } });
    assert.equal(manager.getVideoQueue(1), undefined);
    assert.equal(state.botDeletes.length, 1);
  });
});
