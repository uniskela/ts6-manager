import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_QUEUE_ITEMS, PlayQueue } from '../playlist/queue.js';
import { getImportJob, startYouTubePlaylistImport } from './youtube-playlist-import.js';

// A fake yt-dlp answers the playlist probe with three videos.
const dir = await mkdtemp(path.join(tmpdir(), 'ts6-import-queue-'));
const fake = path.join(dir, 'yt-dlp');
const entries = ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3'].map((id) => ({ id, title: `Video ${id}`, uploader: 'Uploader', duration: 60 }));
await writeFile(fake, `#!/bin/sh\necho '${JSON.stringify({ title: 'Mix', entries })}'\n`);
await chmod(fake, 0o755);
const previous = process.env.YT_DLP_PATH;
process.env.YT_DLP_PATH = fake;
after(async () => {
  if (previous === undefined) delete process.env.YT_DLP_PATH;
  else process.env.YT_DLP_PATH = previous;
  await rm(dir, { recursive: true, force: true });
});

function setup(room: number) {
  const queue = new PlayQueue();
  queue.addMany(Array.from({ length: MAX_QUEUE_ITEMS - room }, (_, i) => ({ id: `q${i}`, title: `Q${i}`, filePath: '', source: 'local' as const })));
  const created: string[] = [];
  let nextId = 1;
  const prisma: any = {
    appSetting: { findUnique: async () => null },
    musicBot: { findUnique: async () => ({ id: 3, serverConfigId: 1 }) },
    song: {
      findFirst: async () => null,
      create: async ({ data }: any) => { created.push(data.sourceUrl); return { id: nextId++, ...data }; },
    },
  };
  const bot = { status: 'playing', queue };
  return { queue, created, prisma, context: { voiceBotManager: { getBot: () => bot } as any } };
}

async function finished(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = getImportJob(jobId)!;
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('import did not finish');
}

test('a queue import that does not fit fails whole before registering any song', async () => {
  const { queue, created, prisma, context } = setup(2);
  const jobId = await startYouTubePlaylistImport(prisma, 1, 'https://www.youtube.com/playlist?list=PLqueue', { musicBotId: 3 }, context);
  const job = await finished(jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.errors.join('\n'), /only 2 of these 3 tracks fit/);
  assert.equal(queue.length, MAX_QUEUE_ITEMS - 2);
  assert.deepEqual(created, []);
});

test('a queue import that fits queues every track and releases its room', async () => {
  const { queue, prisma, context } = setup(5);
  const jobId = await startYouTubePlaylistImport(prisma, 1, 'https://www.youtube.com/playlist?list=PLqueue', { musicBotId: 3 }, context);
  const job = await finished(jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.enqueued, 3);
  assert.deepEqual(queue.getAll().slice(-3).map((item) => item.title), entries.map((entry) => entry.title));
  assert.equal(queue.room, 2);
});
