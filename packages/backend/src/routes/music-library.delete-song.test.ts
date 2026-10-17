import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/error-handler.js';
import { CACHE_DIR_NAME } from '../voice/audio/media-cache.js';

// music-library.routes creates MUSIC_DIR on import; keep it out of /data in tests.
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-delete-song-'));
const previousMusicDir = process.env.MUSIC_DIR;
process.env.MUSIC_DIR = musicDir;
const { musicLibraryRoutes } = await import('./music-library.routes.js');
after(() => {
  if (previousMusicDir === undefined) delete process.env.MUSIC_DIR;
  else process.env.MUSIC_DIR = previousMusicDir;
  fs.rmSync(musicDir, { recursive: true, force: true });
});

interface Row { id: number; filePath: string; serverConfigId: number; title: string }

/** In-memory songs and playlists; deleting a song removes its playlist entries (cascade). */
function fakeLibrary(rows: Row[], playlistSongs: Array<{ playlistId: number; songId: number }> = []) {
  let songs = rows.map((row) => ({ ...row }));
  let entries = [...playlistSongs];
  return {
    get songs() { return songs; },
    get entries() { return entries; },
    prisma: {
      song: {
        findUnique: async ({ where }: { where: { id: number } }) => songs.find((s) => s.id === where.id) ?? null,
        delete: async ({ where }: { where: { id: number } }) => {
          songs = songs.filter((s) => s.id !== where.id);
          entries = entries.filter((e) => e.songId !== where.id);
          return {};
        },
        findMany: async ({ where }: { where: { id: { not: number } } }) =>
          songs.filter((s) => s.id !== where.id.not).map((s) => ({ filePath: s.filePath })),
      },
    },
  };
}

function app(prisma: unknown, queued: string[] = []): Express {
  const server = express();
  server.use(express.json());
  server.locals.prisma = prisma;
  server.locals.voiceBotManager = {
    listBots: () => [{ id: 1 }],
    getBot: () => ({ nowPlaying: null, queue: { getAll: () => queued.map((filePath, i) => ({ id: String(i), filePath })) } }),
  };
  server.use((req, _res, next) => { (req as any).user = { id: 1, username: 'admin', role: 'admin' }; next(); });
  server.use('/', musicLibraryRoutes);
  server.use(errorHandler);
  return server;
}

async function remove(server: Express, id: number): Promise<number> {
  const listener = server.listen(0);
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const { port } = listener.address() as { port: number };
  try {
    return (await fetch(`http://127.0.0.1:${port}/songs/${id}`, { method: 'DELETE' })).status;
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

function file(name: string, content = 'audio'): string {
  const full = path.join(musicDir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('deleting a song', () => {
  beforeEach(() => {
    for (const name of fs.readdirSync(musicDir)) fs.rmSync(path.join(musicDir, name), { recursive: true, force: true });
  });

  it('keeps a file another server\'s song still uses, and removes it with the last song', async () => {
    const shared = file('upload-shared.mp3');
    const library = fakeLibrary([
      { id: 1, filePath: shared, serverConfigId: 1, title: 'Server one' },
      { id: 2, filePath: shared, serverConfigId: 2, title: 'Server two' },
    ]);
    const server = app(library.prisma);
    assert.equal(await remove(server, 1), 200);
    assert.ok(fs.existsSync(shared), 'still used on server two');
    assert.deepEqual(library.songs.map((s) => s.id), [2]);
    assert.equal(await remove(server, 2), 200);
    assert.equal(fs.existsSync(shared), false, 'the last song took its file with it');
  });

  it('keeps the file for a song that stays in a playlist when a duplicate entry is removed', async () => {
    const track = file('track.opus');
    const library = fakeLibrary(
      [
        { id: 10, filePath: track, serverConfigId: 1, title: 'In the playlist' },
        { id: 11, filePath: track, serverConfigId: 1, title: 'Duplicate entry' },
      ],
      [{ playlistId: 5, songId: 10 }, { playlistId: 6, songId: 11 }],
    );
    assert.equal(await remove(app(library.prisma), 11), 200);
    assert.deepEqual(library.entries, [{ playlistId: 5, songId: 10 }], 'only the removed song left its playlist');
    assert.ok(fs.existsSync(track), 'the playlist song still plays');
  });

  it('never deletes a file in the download cache, even with the last song that used it', async () => {
    const cached = file(path.join(CACHE_DIR_NAME, 'v2', `${'a'.repeat(64)}.0123456789abcdef.opus`));
    const library = fakeLibrary([
      { id: 20, filePath: cached, serverConfigId: 1, title: 'Downloaded on server one' },
      { id: 21, filePath: cached, serverConfigId: 2, title: 'Same download on server two' },
    ]);
    const server = app(library.prisma);
    assert.equal(await remove(server, 20), 200);
    assert.equal(await remove(server, 21), 200);
    assert.ok(fs.existsSync(cached), 'cache files are managed by the cache');
    assert.deepEqual(library.songs, []);
  });

  it('recognises the same file under a different spelling of its path', async () => {
    const track = file('spelled.mp3');
    const library = fakeLibrary([
      { id: 30, filePath: track, serverConfigId: 1, title: 'A' },
      // Written as stored by hand, not normalised.
      { id: 31, filePath: `${musicDir}${path.sep}.${path.sep}sub${path.sep}..${path.sep}spelled.mp3`, serverConfigId: 2, title: 'B' },
    ]);
    assert.equal(await remove(app(library.prisma), 30), 200);
    assert.ok(fs.existsSync(track));
  });

  it('keeps a file a bot has queued', async () => {
    const track = file('queued.mp3');
    const library = fakeLibrary([{ id: 40, filePath: track, serverConfigId: 1, title: 'Queued' }]);
    assert.equal(await remove(app(library.prisma, [track]), 40), 200);
    assert.ok(fs.existsSync(track));
    assert.deepEqual(library.songs, [], 'the song itself is removed');
  });

  it('removes an unshared upload, and copes with a file that is already gone', async () => {
    const lone = file('lone.mp3');
    const library = fakeLibrary([
      { id: 50, filePath: lone, serverConfigId: 1, title: 'Lone' },
      { id: 51, filePath: path.join(musicDir, 'gone.mp3'), serverConfigId: 1, title: 'Gone' },
    ]);
    const server = app(library.prisma);
    assert.equal(await remove(server, 50), 200);
    assert.equal(fs.existsSync(lone), false);
    assert.equal(await remove(server, 51), 200);
    assert.equal(await remove(server, 999), 404);
  });

  it('answers 404 to the second of two removals of one song', async () => {
    const lone = file('twice.mp3');
    const library = fakeLibrary([{ id: 60, filePath: lone, serverConfigId: 1, title: 'Twice' }]);
    const deleteOnce = library.prisma.song.delete;
    let calls = 0;
    library.prisma.song.delete = async (args: { where: { id: number } }) => {
      calls++;
      if (calls === 2) throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
      return deleteOnce(args);
    };
    const server = app(library.prisma);
    // The second request found the row before the first one removed it.
    library.prisma.song.findUnique = async () => ({ id: 60, filePath: lone, serverConfigId: 1, title: 'Twice' });
    assert.equal(await remove(server, 60), 200);
    assert.equal(await remove(server, 60), 404);
  });
});
