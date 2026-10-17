import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { removeSongFileIfUnused, withLibraryFileLock } from './library-files.js';
import { CACHE_DIR_NAME, MediaCache, cacheKey, type StagedDownload } from './media-cache.js';

const none = async () => [] as string[];

/**
 * Create a link (a junction for folders on Windows); false only when Windows
 * refuses a file link for lack of privileges. Any other failure fails the test.
 */
function link(target: string, at: string, folder = false): Promise<boolean> {
  return symlink(target, at, folder ? (process.platform === 'win32' ? 'junction' : 'dir') : undefined).then(() => true, (err: NodeJS.ErrnoException) => {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) return false;
    throw err;
  });
}

describe('removeSongFileIfUnused', () => {
  let root: string;
  let music: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ts6-library-files-'));
    music = path.join(root, 'music');
    await mkdir(music);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const put = async (name: string, content = 'audio') => {
    const file = path.join(music, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
  };

  it('removes an unused file, including names that start with two dots', async () => {
    const file = await put('..intro.mp3');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: none }), 'removed');
    assert.equal(existsSync(file), false);
  });

  it('keeps a file another song names under a different spelling', async () => {
    const file = await put('track.mp3');
    await mkdir(path.join(music, 'x'));
    const other = `${music}${path.sep}.${path.sep}x${path.sep}..${path.sep}track.mp3`;
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: async () => [other] }), 'shared');
    assert.ok(existsSync(file));
  });

  it('keeps a file another song reaches through a link with another name', async (t) => {
    const file = await put('target.mp3');
    const alias = path.join(music, 'alias.mp3');
    if (!(await link(file, alias))) return t.skip('file links are not allowed here');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: async () => [alias] }), 'shared');
    assert.ok(existsSync(file));
  });

  it('keeps a file another song names in a different letter case, where the filesystem ignores case', async (t) => {
    const file = await put('Track Case.mp3');
    const variant = path.join(music, 'track case.mp3');
    if (!existsSync(variant)) return t.skip('this filesystem is case-sensitive');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: async () => [variant] }), 'shared');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: none, queuedPaths: () => [variant] }), 'in-use');
    assert.ok(existsSync(file));
  });

  it('keeps a file a bot has queued under any spelling', async () => {
    const file = await put('queued.mp3');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: none, queuedPaths: () => [`${music}${path.sep}.${path.sep}queued.mp3`] }), 'in-use');
    assert.ok(existsSync(file));
  });

  it('never deletes a cache file, under any spelling of the cache folder', async (t) => {
    const cached = await put(path.join(CACHE_DIR_NAME, 'v2', `${'a'.repeat(64)}.0123456789abcdef.opus`));
    assert.equal(await removeSongFileIfUnused({ filePath: cached, musicDir: music, otherSongPaths: none }), 'cache');
    const upper = path.join(music, CACHE_DIR_NAME.toUpperCase(), 'v2', path.basename(cached));
    if (existsSync(upper)) {
      assert.equal(await removeSongFileIfUnused({ filePath: upper, musicDir: music, otherSongPaths: none }), 'cache');
    } else {
      t.diagnostic('case-sensitive filesystem: the upper-case spelling names no file here');
    }
    const linkPath = path.join(music, 'link-to-cache.opus');
    if (await link(cached, linkPath)) {
      assert.equal(await removeSongFileIfUnused({ filePath: linkPath, musicDir: music, otherSongPaths: none }), 'cache');
      assert.ok(existsSync(linkPath));
    }
    assert.ok(existsSync(cached));
  });

  it('never deletes outside the music folder, even through a linked folder inside it', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'theirs.mp3'), 'x');
    assert.equal(await removeSongFileIfUnused({ filePath: path.join(outside, 'theirs.mp3'), musicDir: music, otherSongPaths: none }), 'outside-music-folder');
    const linked = path.join(music, 'linked');
    if (await link(outside, linked, true)) {
      assert.equal(await removeSongFileIfUnused({ filePath: path.join(linked, 'theirs.mp3'), musicDir: music, otherSongPaths: none }), 'outside-music-folder');
    }
    assert.ok(existsSync(path.join(outside, 'theirs.mp3')));
  });

  it('works when the music folder itself is reached through a link', async (t) => {
    const viaLink = path.join(root, 'music-link');
    if (!(await link(music, viaLink, true))) return t.skip('folder links are not allowed here');
    const file = await put('linked-folder.mp3');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: viaLink, otherSongPaths: async () => [path.join(viaLink, 'linked-folder.mp3')] }), 'shared');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: viaLink, otherSongPaths: none }), 'removed');
  });

  it('ignores empty paths and folders', async () => {
    await mkdir(path.join(music, 'a-folder'));
    assert.equal(await removeSongFileIfUnused({ filePath: '', musicDir: music, otherSongPaths: none }), 'missing');
    assert.equal(await removeSongFileIfUnused({ filePath: path.join(music, 'a-folder'), musicDir: music, otherSongPaths: none }), 'outside-music-folder');
    assert.equal(await removeSongFileIfUnused({ filePath: path.join(music, 'gone.mp3'), musicDir: music, otherSongPaths: none }), 'missing');
    assert.ok(existsSync(path.join(music, 'a-folder')));
  });

  it('never deletes an entry that lives in the cache folder, even when it points at a music file', async (t) => {
    const track = await put('kept.mp3');
    const inCache = path.join(music, CACHE_DIR_NAME, 'v2', 'entry.mp3');
    await mkdir(path.dirname(inCache), { recursive: true });
    if (!(await link(track, inCache))) return t.skip('file links are not allowed here');
    assert.equal(await removeSongFileIfUnused({ filePath: inCache, musicDir: music, otherSongPaths: none }), 'cache');
    assert.ok(existsSync(inCache));
    assert.ok(existsSync(track));
  });

  it('keeps a file when another song\'s file cannot be identified', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('needs a folder this user cannot read');
    const file = await put('unsure.mp3');
    const locked = path.join(root, 'locked');
    await mkdir(locked);
    await writeFile(path.join(locked, 'theirs.mp3'), 'x');
    await chmod(locked, 0o000);
    try {
      const reported: string[] = [];
      const onUnverifiable = (_file: string, reason: string) => { reported.push(reason); };
      const unreadable = path.join(locked, 'theirs.mp3');
      assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: async () => [unreadable], onUnverifiable }), 'unverifiable');
      assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: none, queuedPaths: () => [unreadable], onUnverifiable }), 'unverifiable');
      assert.deepEqual(reported, ['EACCES', 'EACCES']);
      assert.ok(existsSync(file));
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('treats a path that cannot name a file as not this file', async (t) => {
    const file = await put('loop-free.mp3');
    const loopA = path.join(music, 'loop-a.mp3');
    const loopB = path.join(music, 'loop-b.mp3');
    if (!((await link(loopB, loopA)) && await link(loopA, loopB))) return t.skip('file links are not allowed here');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: async () => [loopA, `${'x'.repeat(5000)}.mp3`] }), 'removed');
  });

  it('follows links before "..", as the filesystem does', async (t) => {
    // Windows resolves ".." in a path before following links, so there is no difference to test.
    if (process.platform === 'win32') return t.skip('".." is resolved by name on Windows');
    const deep = path.join(music, 'sub', 'deep');
    await mkdir(deep, { recursive: true });
    const track = await put(path.join('sub', 'track.mp3'));
    await put('track.mp3', 'a different file');
    if (!(await link(deep, path.join(music, 'link'), true))) return t.skip('folder links are not allowed here');
    // music/link/../track.mp3 is music/sub/track.mp3, not music/track.mp3.
    const viaLink = `${music}${path.sep}link${path.sep}..${path.sep}track.mp3`;
    assert.equal(await removeSongFileIfUnused({ filePath: track, musicDir: music, otherSongPaths: async () => [viaLink] }), 'shared');
    assert.equal(await removeSongFileIfUnused({ filePath: viaLink, musicDir: music, otherSongPaths: async () => [track] }), 'shared');
    assert.equal(await removeSongFileIfUnused({ filePath: viaLink, musicDir: music, otherSongPaths: none }), 'removed');
    assert.equal(existsSync(track), false);
    assert.ok(existsSync(path.join(music, 'track.mp3')), 'the file with the normalised name is untouched');
  });

  it('looks at the queue once more right before deleting', async () => {
    const file = await put('late.mp3');
    let looks = 0;
    const queuedPaths = () => (++looks > 1 ? [file] : []);
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: none, queuedPaths }), 'in-use');
    assert.ok(existsSync(file));
  });

  it('keeps a file queued after the first look at the queue', async () => {
    const file = await put('raced.mp3');
    const others = Array.from({ length: 64 }, (_, i) => path.join(music, `other-${i}.mp3`));
    for (const other of others) await writeFile(other, 'x');
    const queue = [...others];
    let looks = 0;
    const queuedPaths = () => {
      const snapshot = [...queue];
      // Something queues the song while the removal is still busy with the first look.
      if (++looks === 1) setImmediate(() => queue.push(file));
      return snapshot;
    };
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: none, queuedPaths }), 'in-use');
    assert.equal(looks, 2, 'only the last look saw it');
    assert.ok(existsSync(file));
  });

  it('checks many other songs without missing a match', async () => {
    const file = await put('many.mp3');
    const others = Array.from({ length: 100 }, (_, i) => path.join(music, `absent-${i}.mp3`));
    others.splice(77, 0, file);
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: async () => others }), 'shared');
    assert.ok(existsSync(file));
  });

  it('lets a scan adopt a file only before or after a removal, never in between', async () => {
    const file = await put('contested.mp3');
    const rows: string[] = [];
    let releaseCheck!: () => void;
    const checking = new Promise<void>((resolve) => { releaseCheck = resolve; });
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    const removal = removeSongFileIfUnused({
      filePath: file, musicDir: music,
      otherSongPaths: async () => { checkStarted(); await checking; return [...rows]; },
    });
    await started;
    // A scan on another server wants to adopt the same file meanwhile.
    const scan = withLibraryFileLock(async () => {
      if (existsSync(file)) rows.push(file);
      return existsSync(file);
    });
    releaseCheck();
    assert.equal(await removal, 'removed');
    assert.equal(await scan, false, 'the scan ran after the removal and found nothing to adopt');
    assert.deepEqual(rows, []);
  });

  it('keeps a cached download shared by repeated downloads on several servers', async () => {
    const cache = new MediaCache(music, { probe: async () => ({ hasAudio: true, durationSec: 100 }), log: () => {} });
    const key = cacheKey({ kind: 'youtube', videoId: 'abcdefghijk' });
    let downloads = 0;
    const download = async (staging: string): Promise<StagedDownload> => {
      downloads++;
      const out = path.join(staging, 'media.opus');
      await writeFile(out, 'audio');
      return { reportedPaths: [out], expectedDurationSec: 100, kind: 'youtube', extractor: 'Youtube' };
    };
    const serverOne = await cache.fetch(key, download);
    const serverTwo = await cache.fetch(key, download);
    assert.equal(serverOne, serverTwo);
    assert.equal(await removeSongFileIfUnused({ filePath: serverOne, musicDir: music, otherSongPaths: async () => [serverTwo] }), 'cache');
    assert.equal(await removeSongFileIfUnused({ filePath: serverTwo, musicDir: music, otherSongPaths: none }), 'cache');
    assert.equal(await cache.fetch(key, download), serverOne, 'a later request still finds the entry');
    assert.equal(downloads, 1);
  });
});
