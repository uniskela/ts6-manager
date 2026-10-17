import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { removeSongFileIfUnused, withLibraryFileLock } from './library-files.js';
import { CACHE_DIR_NAME, MediaCache, cacheKey, type StagedDownload } from './media-cache.js';

const none = async () => [] as string[];

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
    const other = `${music}${path.sep}.${path.sep}x${path.sep}..${path.sep}track.mp3`;
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: async () => [other] }), 'shared');
    assert.ok(existsSync(file));
  });

  it('keeps a file another song reaches through a link with another name', async (t) => {
    const file = await put('target.mp3');
    const alias = path.join(music, 'alias.mp3');
    if (!(await symlink(file, alias).then(() => true, () => false))) return t.skip('file links are not allowed here');
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
    const link = path.join(music, 'link-to-cache.opus');
    if (await symlink(cached, link).then(() => true, () => false)) {
      assert.equal(await removeSongFileIfUnused({ filePath: link, musicDir: music, otherSongPaths: none }), 'cache');
      assert.ok(existsSync(link));
    }
    assert.ok(existsSync(cached));
  });

  it('never deletes outside the music folder, even through a linked folder inside it', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'theirs.mp3'), 'x');
    assert.equal(await removeSongFileIfUnused({ filePath: path.join(outside, 'theirs.mp3'), musicDir: music, otherSongPaths: none }), 'outside-music-folder');
    const linked = path.join(music, 'linked');
    if (await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir').then(() => true, () => false)) {
      assert.equal(await removeSongFileIfUnused({ filePath: path.join(linked, 'theirs.mp3'), musicDir: music, otherSongPaths: none }), 'outside-music-folder');
    }
    assert.ok(existsSync(path.join(outside, 'theirs.mp3')));
  });

  it('works when the music folder itself is reached through a link', async (t) => {
    const viaLink = path.join(root, 'music-link');
    if (!(await symlink(music, viaLink, process.platform === 'win32' ? 'junction' : 'dir').then(() => true, () => false))) return t.skip('folder links are not allowed here');
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
    if (!(await symlink(track, inCache).then(() => true, () => false))) return t.skip('file links are not allowed here');
    assert.equal(await removeSongFileIfUnused({ filePath: inCache, musicDir: music, otherSongPaths: none }), 'cache');
    assert.ok(existsSync(inCache));
    assert.ok(existsSync(track));
  });

  it('keeps a file when another song\'s file cannot be identified', async (t) => {
    const file = await put('unsure.mp3');
    // A link loop: looking it up fails with an error other than "not found".
    const loopA = path.join(music, 'loop-a.mp3');
    const loopB = path.join(music, 'loop-b.mp3');
    if (!(await symlink(loopB, loopA).then(() => symlink(loopA, loopB)).then(() => true, () => false))) return t.skip('file links are not allowed here');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: async () => [loopA] }), 'unverifiable');
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: none, queuedPaths: () => [loopB] }), 'unverifiable');
    assert.ok(existsSync(file));
  });

  it('looks at the queue once more right before deleting', async () => {
    const file = await put('late.mp3');
    let looks = 0;
    const queuedPaths = () => (++looks > 1 ? [file] : []);
    assert.equal(await removeSongFileIfUnused({ filePath: file, musicDir: music, otherSongPaths: none, queuedPaths }), 'in-use');
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
