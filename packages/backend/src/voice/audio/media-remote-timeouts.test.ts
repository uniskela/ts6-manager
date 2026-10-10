import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test, mock } from 'node:test';
import { fetchYouTubeVideoMeta, fetchSpotifyPage } from './youtube.js';
import { resolveAppleMusicTracks } from './apple-music.js';
import { isAbsolute } from 'node:path';

test('shared downloader bounds callers without an AbortSignal', async () => {
  const spawn = mock.method(childProcess, 'spawn', (command: string, _args: unknown, options: { timeout: number; killSignal: string }) => {
    assert.ok(isAbsolute(command));
    assert.equal(options.timeout, 180_000);
    assert.equal(options.killSignal, 'SIGKILL');
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => {
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ title: 'Song', duration: 1 })));
      proc.emit('close', 0);
    });
    return proc;
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await fetchYouTubeVideoMeta('00000000001'))?.title, 'Song');
    assert.equal(spawn.mock.callCount(), 1);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

test('shared provider fetches include timeout signals', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ results: [{ wrapperType: 'track', kind: 'song', trackName: 'Song', artistName: 'Artist', trackId: 1700000001 }] }));
  });
  try {
    await fetchSpotifyPage(new URL('https://open.spotify.com/track/example'));
    await resolveAppleMusicTracks('https://music.apple.com/us/album/song/1700000000?i=1700000001');
    await assert.rejects(resolveAppleMusicTracks('https://music.apple.com/us/playlist/example/pl.example'));
    assert.ok(fetchMock.mock.callCount() >= 3);
  } finally {
    fetchMock.mock.restore();
  }
});
