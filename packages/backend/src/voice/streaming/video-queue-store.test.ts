import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createVideoQueueStore, videoQueueOptionsKey } from './video-queue-store.js';
import type { VideoQueueItem, VideoQueueSessionOptions } from './video-queue.js';

type Row = Record<string, unknown>;

function fakePrisma(seed: { rows?: Row[]; settings?: Record<string, string> } = {}) {
  const state = {
    rows: [...(seed.rows ?? [])],
    settings: new Map(Object.entries(seed.settings ?? {})),
    calls: [] as Array<{ op: string; args: any }>,
    transactions: 0,
  };
  const record = (op: string, args: any) => state.calls.push({ op, args });
  const prisma = {
    videoQueueEntry: {
      async deleteMany(args: any) {
        record('entry.deleteMany', args);
        state.rows = state.rows.filter((r) => r.musicBotId !== args.where.musicBotId);
      },
      async createMany(args: any) {
        record('entry.createMany', args);
        state.rows.push(...args.data);
      },
      async findMany(args: any) {
        record('entry.findMany', args);
        return state.rows
          .filter((r) => r.musicBotId === args.where.musicBotId)
          .sort((a, b) => (a.position as number) - (b.position as number));
      },
    },
    appSetting: {
      async upsert(args: any) {
        record('setting.upsert', args);
        state.settings.set(args.where.key, args.create.value);
      },
      async deleteMany(args: any) {
        record('setting.deleteMany', args);
        state.settings.delete(args.where.key);
      },
      async findUnique(args: any) {
        const value = state.settings.get(args.where.key);
        return value === undefined ? null : { key: args.where.key, value };
      },
    },
    async $transaction(work: unknown) {
      state.transactions++;
      if (Array.isArray(work)) return Promise.all(work);
      return (work as (tx: unknown) => Promise<unknown>)(prisma);
    },
  };
  return { prisma: prisma as any, state };
}

const item = (n: number): VideoQueueItem => ({
  id: `id-${n}`,
  source: `https://video.example.test/watch?v=${n}`,
  title: `Video ${n}`,
  sourceMode: 'auto',
});

describe('video queue store', () => {
  it('save writes positions in order and replaces previous rows', async () => {
    const { prisma, state } = fakePrisma({
      rows: [
        { id: 'old', musicBotId: 7, position: 0, source: 'x', title: 'Old', sourceMode: 'auto' },
        { id: 'other-bot', musicBotId: 8, position: 0, source: 'y', title: 'Other', sourceMode: 'auto' },
      ],
    });
    await createVideoQueueStore(prisma, 7).save([item(1), { ...item(2), durationSec: 90, addedBy: 'admin' }, item(3)], null);
    const deleted = state.calls.find((c) => c.op === 'entry.deleteMany');
    assert.deepEqual(deleted?.args, { where: { musicBotId: 7 } });
    const created = state.calls.find((c) => c.op === 'entry.createMany')?.args.data as Row[];
    assert.deepEqual(created.map((r) => r.position), [0, 1, 2]);
    assert.deepEqual(created.map((r) => r.id), ['id-1', 'id-2', 'id-3']);
    assert.ok(created.every((r) => r.musicBotId === 7));
    assert.equal(created[1].durationSec, 90);
    assert.equal(created[1].addedBy, 'admin');
    assert.equal(state.transactions, 1);
    assert.deepEqual(state.rows.map((r) => r.id).sort(), ['id-1', 'id-2', 'id-3', 'other-bot']);
  });

  it('save with null options removes the options row', async () => {
    const { prisma, state } = fakePrisma({ settings: { [videoQueueOptionsKey(7)]: '{"preset":"720p"}' } });
    await createVideoQueueStore(prisma, 7).save([item(1)], null);
    assert.equal(state.settings.has('video_queue_options:7'), false);
  });

  it('save with options stores them as JSON under the bot key', async () => {
    const { prisma, state } = fakePrisma();
    await createVideoQueueStore(prisma, 7).save([item(1)], { preset: '720p', framerate: 30 });
    assert.deepEqual(JSON.parse(state.settings.get('video_queue_options:7')!), { preset: '720p', framerate: 30 });
  });

  it('load returns items by position and parsed options', async () => {
    const { prisma } = fakePrisma({
      rows: [
        { id: 'b', musicBotId: 7, position: 1, source: 'clip.mp4', title: 'B', durationSec: null, sourceMode: 'vod', addedBy: null },
        { id: 'a', musicBotId: 7, position: 0, source: 'https://a.example.test/1', title: 'A', durationSec: 120, sourceMode: 'auto', addedBy: 'admin' },
        { id: 'c', musicBotId: 9, position: 0, source: 'z', title: 'C', durationSec: null, sourceMode: 'auto', addedBy: null },
      ],
      settings: { 'video_queue_options:7': '{"preset":"480p","noViewerTimeoutSec":0}' },
    });
    const loaded = await createVideoQueueStore(prisma, 7).load();
    assert.deepEqual(loaded.items, [
      { id: 'a', source: 'https://a.example.test/1', title: 'A', durationSec: 120, sourceMode: 'auto', addedBy: 'admin' },
      { id: 'b', source: 'clip.mp4', title: 'B', sourceMode: 'vod' },
    ]);
    assert.deepEqual(loaded.options, { preset: '480p', noViewerTimeoutSec: 0 });
  });

  it('load tolerates a corrupt options row', async () => {
    const { prisma } = fakePrisma({
      rows: [{ id: 'a', musicBotId: 7, position: 0, source: 's', title: 'A', durationSec: null, sourceMode: 'weird', addedBy: null }],
      settings: { 'video_queue_options:7': '{not json' },
    });
    const loaded = await createVideoQueueStore(prisma, 7).load();
    assert.equal(loaded.options, null);
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].sourceMode, 'auto');
  });

  it('stored rows never carry localHosts, volume or replaceSessionIds', async () => {
    const { prisma, state } = fakePrisma();
    const options = {
      preset: '720p', encoder: 'vp8', framerate: 30, bitrate: '2500k', noViewerTimeoutSec: 60,
      volume: 40, replaceSessionIds: ['x'], localHosts: ['10.0.0.5'],
    } as VideoQueueSessionOptions;
    const leaky = { ...item(1), localHosts: ['10.0.0.5'], volume: 40 } as VideoQueueItem;
    await createVideoQueueStore(prisma, 7).save([leaky], options);
    const allowed = ['preset', 'encoder', 'framerate', 'bitrate', 'noViewerTimeoutSec'];
    const saved = JSON.parse(state.settings.get('video_queue_options:7')!);
    assert.ok(Object.keys(saved).every((k) => allowed.includes(k)), Object.keys(saved).join(','));
    const row = (state.calls.find((c) => c.op === 'entry.createMany')?.args.data as Row[])[0];
    assert.deepEqual(
      Object.keys(row).sort(),
      ['addedBy', 'durationSec', 'id', 'musicBotId', 'position', 'source', 'sourceMode', 'title'],
    );
  });

  it('delete removes the rows and the options row', async () => {
    const { prisma, state } = fakePrisma({
      rows: [{ id: 'a', musicBotId: 7, position: 0, source: 's', title: 'A', sourceMode: 'auto' }],
      settings: { 'video_queue_options:7': '{}' },
    });
    await createVideoQueueStore(prisma, 7).delete();
    assert.equal(state.rows.length, 0);
    assert.equal(state.settings.size, 0);
  });
});
