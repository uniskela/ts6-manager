import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const musicRoot = await mkdtemp(path.join(tmpdir(), 'ts6-history-'));
const previousMusicDir = process.env.MUSIC_DIR;
process.env.MUSIC_DIR = musicRoot;
const {
  MEDIA_UNAVAILABLE,
  MUSIC_REQUEST_HISTORY_LIMIT,
  canonicalRequestReference,
  markMusicRequestUnavailable,
  musicRequestListWhere,
  recordMusicRequest,
  recordMusicRequests,
  pruneMusicRequests,
  replayReference,
} = await import('./music-request-history.js');
import type { MusicRequestHistoryDb } from './music-request-history.js';
after(async () => {
  if (previousMusicDir === undefined) delete process.env.MUSIC_DIR;
  else process.env.MUSIC_DIR = previousMusicDir;
  await rm(musicRoot, { recursive: true, force: true });
});

test('replay uses the stored source URL, not the display title', () => {
  const ref = canonicalRequestReference({
    title: 'Never Gonna Give You Up',
    source: 'youtube',
    sourceUrl: 'https://youtu.be/dQw4w9WgXcQ',
    filePath: '/tmp/not-the-source.mp3',
  } as never);
  assert.deepEqual(ref, { url: 'https://youtu.be/dQw4w9WgXcQ', source: 'youtube' });
  assert.equal(canonicalRequestReference({ source: 'local', filePath: 'song.mp3', title: 'Song' } as never)?.url, 'song.mp3');
  assert.equal(canonicalRequestReference({ source: 'youtube', title: 'Song', filePath: '' } as never), null);
});

test('history retention keeps the newest rows for that bot only', async () => {
  assert.equal(MUSIC_REQUEST_HISTORY_LIMIT, 100);
  const rows: Array<{ id: number; serverConfigId: number; musicBotId: number; url: string; title: string; status: string; requestedAt: Date }> = [];
  let nextId = 1;
  const db: MusicRequestHistoryDb = {
    musicRequest: {
      async upsert(args: any) {
        const key = args.where.serverConfigId_musicBotId_url;
        assert.equal(key.url.includes(args.create.title), false);
        let row = rows.find((item) => item.serverConfigId === key.serverConfigId && item.musicBotId === key.musicBotId && item.url === key.url);
        if (row) Object.assign(row, args.update);
        else rows.push(row = { id: nextId++, ...args.create });
        return row;
      },
      async findMany(args: any) {
        return rows
          .filter((row) => row.serverConfigId === args.where.serverConfigId && row.musicBotId === args.where.musicBotId)
          .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || b.id - a.id)
          .slice(args.skip)
          .map((row) => ({ id: row.id, requestedAt: row.requestedAt }));
      },
      async deleteMany(args: any) {
        const ids = new Set(args.where.id.in);
        for (let i = rows.length - 1; i >= 0; i--) if (ids.has(rows[i].id) && rows[i].requestedAt <= args.where.requestedAt.lte) rows.splice(i, 1);
      },
      async update() { throw new Error('unused'); },
    },
  };
  await recordMusicRequest(db, { serverConfigId: 1, musicBotId: 4, title: 'Old', url: 'https://8.8.8.8/old', source: 'url' }, 2);
  await recordMusicRequest(db, { serverConfigId: 1, musicBotId: 4, title: 'Mid', url: 'https://8.8.8.8/mid', source: 'url' }, 2);
  await recordMusicRequest(db, { serverConfigId: 1, musicBotId: 9, title: 'Other bot', url: 'https://8.8.8.8/other', source: 'url' }, 2);
  await recordMusicRequest(db, { serverConfigId: 1, musicBotId: 4, title: 'New', url: 'https://8.8.8.8/new', source: 'url' }, 2);
  assert.deepEqual(rows.filter((row) => row.musicBotId === 4).map((row) => row.title).sort(), ['Mid', 'New']);
  assert.equal(rows.some((row) => row.title === 'Other bot'), true);
  await recordMusicRequest(db, { serverConfigId: 1, musicBotId: 4, title: 'Mid again', url: 'https://8.8.8.8/mid', source: 'youtube' }, 2);
  assert.equal(rows.filter((row) => row.url === 'https://8.8.8.8/mid').length, 1);
  assert.equal(rows.find((row) => row.url === 'https://8.8.8.8/mid')?.status, 'available');
});

test('removed local media and rejected URLs fail closed', async () => {
  assert.deepEqual(musicRequestListWhere(3, 8), { serverConfigId: 3, OR: [{ musicBotId: 8 }, { musicBotId: 0 }] });
  const missing = await replayReference({ url: 'gone.mp3', source: 'local' }, {
    resolveLocal: () => { throw new Error('Local video file not found'); },
  });
  assert.deepEqual(missing, { ok: false, error: MEDIA_UNAVAILABLE });
  const blocked = await replayReference({ url: 'http://127.0.0.1/secret', source: 'url' }, {
    validateUrl: async () => ({ valid: false }),
  });
  assert.equal(blocked.ok, false);
  const stored = await replayReference({ url: 'https://8.8.8.8/watch?v=stored', source: 'youtube' }, {
    validateUrl: async (url) => ({ valid: url === 'https://8.8.8.8/watch?v=stored' }),
  });
  assert.deepEqual(stored, { ok: true, kind: 'url', url: 'https://8.8.8.8/watch?v=stored' });

  const root = musicRoot;
  try {
    await writeFile(path.join(root, 'kept.mp3'), 'audio');
    const found = await replayReference({ url: 'kept.mp3', source: 'local' });
    assert.equal(found.ok && found.kind, 'local');
    const updates: unknown[] = [];
    await markMusicRequestUnavailable({ musicRequest: { update: async (args: unknown) => { updates.push(args); }, upsert: async () => {}, findMany: async () => [], deleteMany: async () => {} } }, 12);
    assert.deepEqual(updates, [{ where: { id: 12 }, data: { status: 'unavailable' } }]);
  } finally {
    await rm(path.join(root, 'kept.mp3'), { force: true });
  }
});


test('retention preserves a stale row refreshed while pruning is in flight', async () => {
  let kept = true;
  const old = new Date('2026-10-01T00:00:00Z');
  let requestedAt = old;
  const db: MusicRequestHistoryDb = { musicRequest: {
    upsert: async () => {}, update: async () => {},
    findMany: async () => {
      requestedAt = new Date('2026-10-11T00:00:00Z');
      return [{ id: 1, requestedAt: old }];
    },
    deleteMany: async (args: any) => { if (requestedAt <= args.where.requestedAt.lte) kept = false; },
  } };
  await pruneMusicRequests(db, 1, 4);
  assert.equal(kept, true);
});

test('temporary DNS failures keep replay retryable instead of declaring the source unavailable', async () => {
  await assert.rejects(replayReference({ url: 'https://example.test/track', source: 'url' }, {
    validateUrl: async () => ({ valid: false, error: 'Hostname "example.test" could not be resolved' }),
  }), (error: any) => error.statusCode === 503 && error.retryable === true);
});

test('playlist history writes share one transaction and one retention read', async () => {
  const writes: any[] = [];
  let transactions = 0, retentionReads = 0;
  const tx = { musicRequest: {
    upsert: async (args: any) => { writes.push(args); },
    findMany: async () => { retentionReads++; return []; },
  } };
  const db: any = { $transaction: async (fn: any) => { transactions++; await fn(tx); } };
  await recordMusicRequests(db, { serverConfigId: 1, musicBotId: 4 }, [
    { id: 'a', title: 'First', source: 'local', filePath: 'first.ogg' },
    { id: 'b', title: 'Second', source: 'radio', filePath: '', streamUrl: 'https://8.8.8.8/radio' },
    { id: 'c', title: 'No reference', source: 'youtube', filePath: '' },
  ]);
  assert.equal(transactions, 1);
  assert.equal(retentionReads, 1);
  assert.deepEqual(writes.map(args => args.create.url), ['first.ogg', 'https://8.8.8.8/radio']);
  assert.equal(writes[0].create.requestedAt, writes[1].create.requestedAt);
});
