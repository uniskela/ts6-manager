import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test, mock } from 'node:test';
import { fetchYouTubeVideoMeta, fetchSpotifyPage } from './youtube.js';
import { resolveAppleMusicTracks } from './apple-music.js';
import { isAbsolute } from 'node:path';

/** A yt-dlp child: it reads its configuration (the media egress proxy) from stdin. */
const fakeYtDlp = () => Object.assign(new EventEmitter(), {
  pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(),
  stdin: Object.assign(new EventEmitter(), { end: () => {} }), kill: () => true,
});

test('shared downloader bounds callers without an AbortSignal', async () => {
  const spawn = mock.method(childProcess, 'spawn', (command: string, _args: unknown, options: { detached?: boolean }) => {
    assert.ok(isAbsolute(command));
    // Its own process group on POSIX, so the timeout can kill everything it started.
    assert.equal(options.detached, process.platform !== 'win32');
    const proc = fakeYtDlp();
    // Like a real child, its output arrives on a later turn of the event loop.
    setImmediate(() => {
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

// Windows has no process groups; there the timeout kills yt-dlp alone, as before.
test('the downloader kills the whole process group after three minutes', { skip: process.platform === 'win32' }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const kills: Array<[number, string | number | undefined]> = [];
  let proc!: EventEmitter;
  const spawn = mock.method(childProcess, 'spawn', () => {
    proc = fakeYtDlp();
    return proc;
  });
  const kill = mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    kills.push([pid, signal]);
    queueMicrotask(() => proc.emit('close', null));
    return true;
  });
  syncBuiltinESMExports();
  try {
    const pending = fetchYouTubeVideoMeta('00000000001');
    // yt-dlp starts once the job's proxy access is ready.
    while (spawn.mock.callCount() === 0) await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(179_999);
    assert.deepEqual(kills, []);
    mock.timers.tick(1);
    assert.equal(await pending, null);
    assert.deepEqual(kills, [[-4242, 'SIGKILL']]);
  } finally {
    kill.mock.restore();
    spawn.mock.restore();
    syncBuiltinESMExports();
    mock.timers.reset();
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
