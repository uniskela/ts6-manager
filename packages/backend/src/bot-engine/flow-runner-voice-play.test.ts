import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_QUEUE_ITEMS, PlayQueue, QueueFullError } from '../voice/playlist/queue.js';

/** Bot Flow "Voice Play" adds through the same queue limit as every other path (#445). */
async function setup(room: number, songs: number) {
  const { FlowRunner } = await import('./flow-runner.js');
  const prisma = {
    playlist: {
      findUnique: async () => ({
        id: 5,
        songs: Array.from({ length: songs }, (_, i) => ({ song: { id: i, title: `P${i}`, filePath: '/p.opus', source: 'local' } })),
      }),
    },
    song: { findUnique: async () => ({ id: 9, title: 'Song', filePath: '/s.opus', source: 'local' }) },
  };
  const runner = new FlowRunner(prisma as any, {} as any, { clients: new Set() } as any) as any;
  const queue = new PlayQueue();
  queue.addMany(Array.from({ length: MAX_QUEUE_ITEMS - room }, (_, i) => ({ id: `q${i}`, title: `Q${i}`, filePath: '', source: 'local' as const })));
  const played: unknown[] = [];
  const bot = { status: 'playing', queue, play: (item: unknown) => played.push(item) };
  runner.setVoiceBotManager({ getBot: () => bot });
  const ctx = { resolveTemplate: async (value: unknown) => String(value) };
  return { runner, queue, played, ctx };
}

test('a flow playlist that does not fit queues none of its tracks', async () => {
  const { runner, queue, played, ctx } = await setup(2, 3);
  await assert.rejects(runner.executeVoicePlay({ botId: '3', playlistId: '5' }, ctx),
    (err: unknown) => err instanceof QueueFullError && /only 2 of these 3 tracks fit/.test(err.message));
  assert.equal(queue.length, MAX_QUEUE_ITEMS - 2);
  assert.deepEqual(played, []);

  const fits = await setup(3, 3);
  await fits.runner.executeVoicePlay({ botId: '3', playlistId: '5' }, fits.ctx);
  assert.equal(fits.queue.length, MAX_QUEUE_ITEMS);
});

test('a flow song on a full queue is refused', async () => {
  const { runner, queue, ctx } = await setup(0, 0);
  await assert.rejects(runner.executeVoicePlay({ botId: '3', songId: '9' }, ctx), QueueFullError);
  assert.equal(queue.length, MAX_QUEUE_ITEMS);
});
