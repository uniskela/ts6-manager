import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CACHE_DIR_NAME, MediaCache, MediaCacheError, cacheKey, canonicalUrl, checkProbe, checkStagedFile,
  identityFromInfo, parseManifest, parseProbe, renameWithRetry, type StagedDownload,
} from './media-cache.js';

const audioProbe = async () => ({ hasAudio: true, durationSec: 100 });

describe('source identity', () => {
  it('canonicalises the requested URL without changing path or query', () => {
    assert.equal(canonicalUrl('HTTPS://Media.Example.COM:443/A/B?x=1&Y=2#frag'), 'https://media.example.com/A/B?x=1&Y=2');
    assert.equal(canonicalUrl('http://media.example.com:80/a'), 'http://media.example.com/a');
    assert.equal(canonicalUrl('https://media.example.com:8443/a'), 'https://media.example.com:8443/a');
  });

  it('derives lower-case hex keys that differ for every field and for letter case', () => {
    const a = cacheKey({ kind: 'youtube', videoId: 'aBcDeFgHiJk' });
    const b = cacheKey({ kind: 'youtube', videoId: 'abcdefghijk' });
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b, 'ids that differ only by case stay apart on case-insensitive filesystems');
    const url = (extractor: string, mediaId: string, link: string) => cacheKey({ kind: 'url', extractor, mediaId, canonicalUrl: link });
    assert.notEqual(url('Generic', 'ab', 'https://x.test/c'), url('Generic', 'a', 'https://x.test/bc'), 'fields are length-prefixed');
    assert.notEqual(url('Generic', 'track', 'https://x.test/1'), url('Generic', 'track', 'https://x.test/2'), 'the source link is part of the identity');
    assert.equal(cacheKey({ kind: 'youtube', videoId: 'abcdefghijk' }), b, 'stable');
  });

  it('takes the identity from what was requested, checked against the metadata', () => {
    assert.deepEqual(
      identityFromInfo({ youtubeVideoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' }, { extractor_key: 'Youtube', id: 'abcdefghijk' }),
      { kind: 'youtube', videoId: 'abcdefghijk' },
    );
    assert.deepEqual(
      identityFromInfo({ url: 'https://Media.test/track.mp3#x' }, { extractor_key: 'Generic', id: 'track', _type: 'video' }),
      { kind: 'url', extractor: 'Generic', mediaId: 'track', canonicalUrl: 'https://media.test/track.mp3' },
    );
  });

  it('accepts only metadata for the one item that was requested', () => {
    const youtube = { youtubeVideoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' };
    for (const info of [
      { extractor_key: 'Youtube', id: 'zzzzzzzzzzz' },
      { extractor_key: 'Generic', id: 'abcdefghijk' },
      { extractor_key: 'Youtube', id: 'abcdefghijk', _type: 'playlist' },
      { extractor_key: 'Youtube', id: 'abcdefghijk', entries: [] },
      { extractor_key: 'Youtube', id: 'abcdefghijk', requested_downloads: [{}, {}] },
    ]) {
      assert.throws(() => identityFromInfo(youtube, info), MediaCacheError, JSON.stringify(info));
    }
    assert.throws(() => identityFromInfo({ url: 'https://x.test/a' }, { id: 'a' }), MediaCacheError, 'no extractor');
    assert.throws(() => identityFromInfo({ url: 'https://x.test/a' }, { extractor_key: 'Generic', _type: 'multi_video', id: 'a' }), MediaCacheError);
  });
});

describe('download verification', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'ts6-cache-verify-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('accepts exactly one regular audio file inside the staging folder', async () => {
    const staging = path.join(dir, 'staging');
    await mkdir(staging);
    await writeFile(path.join(staging, 'media.opus'), 'audio');
    const checked = await checkStagedFile(staging, [path.join(staging, 'media.opus')]);
    assert.equal(checked.ext, 'opus');
    assert.equal(checked.size, 5);
  });

  it('refuses anything else', async () => {
    const staging = path.join(dir, 'staging');
    await mkdir(staging);
    await mkdir(path.join(staging, 'sub'));
    await writeFile(path.join(staging, 'a.opus'), 'audio');
    await writeFile(path.join(staging, 'b.opus'), 'audio');
    await writeFile(path.join(staging, 'empty.opus'), '');
    await writeFile(path.join(staging, 'page.html'), '<html>');
    await writeFile(path.join(staging, 'sub', 'c.opus'), 'audio');
    await writeFile(path.join(dir, 'outside.opus'), 'audio');
    await symlink(path.join(dir, 'outside.opus'), path.join(staging, 'link.opus'));
    const cases: Array<[string, string[]]> = [
      ['no file', []],
      ['two files', [path.join(staging, 'a.opus'), path.join(staging, 'b.opus')]],
      ['empty file', [path.join(staging, 'empty.opus')]],
      ['wrong type', [path.join(staging, 'page.html')]],
      ['nested folder', [path.join(staging, 'sub', 'c.opus')]],
      ['outside staging', [path.join(dir, 'outside.opus')]],
      ['link leading outside', [path.join(staging, 'link.opus')]],
      ['missing', [path.join(staging, 'gone.opus')]],
    ];
    for (const [label, reported] of cases) {
      await assert.rejects(checkStagedFile(staging, reported), MediaCacheError, label);
    }
  });

  it('requires audio and a duration close to the metadata', () => {
    assert.deepEqual(parseProbe('{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"212.4"}}'), { hasAudio: true, durationSec: 212.4 });
    assert.doesNotThrow(() => checkProbe({ hasAudio: true, durationSec: 212 }, 214));
    assert.doesNotThrow(() => checkProbe({ hasAudio: true, durationSec: 3600 }, 3900), 'within 10%');
    assert.doesNotThrow(() => checkProbe({ hasAudio: true, durationSec: 30 }, null), 'no announced length');
    assert.throws(() => checkProbe({ hasAudio: false, durationSec: 200 }, 200), MediaCacheError);
    assert.throws(() => checkProbe({ hasAudio: true, durationSec: 30 }, 214), MediaCacheError);
    assert.throws(() => checkProbe({ hasAudio: true, durationSec: null }, 214), MediaCacheError, 'an announced length must be confirmed');
  });

  it('retries replacing a manifest that is briefly in use (Windows), and gives up on other errors', async () => {
    let calls = 0;
    const busyTwice = async () => {
      calls++;
      if (calls <= 2) throw Object.assign(new Error('in use'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
    };
    await renameWithRetry('a', 'b', busyTwice);
    assert.equal(calls, 3);
    calls = 0;
    const missing = async () => { calls++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    await assert.rejects(renameWithRetry('a', 'b', missing), /gone/);
    assert.equal(calls, 1);
    calls = 0;
    const alwaysBusy = async () => { calls++; throw Object.assign(new Error('in use'), { code: 'EACCES' }); };
    await assert.rejects(renameWithRetry('a', 'b', alwaysBusy, 3), /in use/);
    assert.equal(calls, 3);
  });

  it('reads only manifests this cache writes', () => {
    const key = 'a'.repeat(64);
    const good = { format: 2, key, kind: 'youtube', extractor: 'Youtube', file: `${key}.0123456789abcdef.opus`, size: 10, sha256: 'b'.repeat(64), durationSec: 10, createdAt: '' };
    assert.ok(parseManifest(JSON.stringify(good), key));
    for (const bad of [
      { ...good, format: 1 },
      { ...good, key: 'c'.repeat(64) },
      { ...good, file: '../escape.opus' },
      { ...good, file: `${'c'.repeat(64)}.0123456789abcdef.opus` },
      { ...good, file: `${key}.0123456789abcdef.exe` },
      { ...good, size: 0 },
      { ...good, kind: 'other' },
    ]) {
      assert.equal(parseManifest(JSON.stringify(bad), key), null, JSON.stringify(bad));
    }
    assert.equal(parseManifest('{', key), null);
  });
});

describe('media cache', () => {
  let music: string;
  beforeEach(async () => { music = await mkdtemp(path.join(tmpdir(), 'ts6-cache-')); });
  afterEach(async () => { await rm(music, { recursive: true, force: true }); });

  const key = cacheKey({ kind: 'youtube', videoId: 'abcdefghijk' });

  /** A download that writes one audio file and reports it. */
  const writer = (calls: { n: number }, gate?: Promise<void>) => async (staging: string, signal: AbortSignal, report?: (p: number) => void): Promise<StagedDownload> => {
    calls.n++;
    report?.(50);
    await gate;
    signal.throwIfAborted();
    const file = path.join(staging, 'media.opus');
    await writeFile(file, 'opus audio bytes');
    return { reportedPaths: [file], expectedDurationSec: 100, kind: 'youtube', extractor: 'Youtube' };
  };

  it('publishes a verified download with its manifest and reuses it', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    const calls = { n: 0 };
    const file = await cache.fetch(key, writer(calls));
    assert.equal(path.dirname(file), path.join(music, CACHE_DIR_NAME, 'v2'));
    assert.match(path.basename(file), new RegExp(`^${key}\\.[0-9a-f]{16}\\.opus$`));
    assert.equal(await readFile(file, 'utf8'), 'opus audio bytes');
    const manifest = JSON.parse(await readFile(path.join(music, CACHE_DIR_NAME, 'v2', `${key}.json`), 'utf8'));
    assert.equal(manifest.file, path.basename(file));
    assert.equal(manifest.size, 16);
    assert.ok(!JSON.stringify(manifest).includes('http'), 'no URL in the manifest');
    assert.equal(await cache.fetch(key, writer(calls)), file);
    assert.equal(calls.n, 1, 'the second request reuses the entry');
    assert.deepEqual(await readdir(path.join(music, CACHE_DIR_NAME, 'v2', 'staging')), [], 'staging is cleaned up');
  });

  it('never reuses, renames or deletes files outside its folder', async () => {
    await writeFile(path.join(music, 'abcdefghijk.opus'), 'legacy download');
    await writeFile(path.join(music, 'my-song.mp3'), 'user file');
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    const calls = { n: 0 };
    await cache.fetch(key, writer(calls));
    assert.equal(calls.n, 1, 'a legacy file with a matching name is not a cache hit');
    await cache.sweep();
    assert.equal(await readFile(path.join(music, 'abcdefghijk.opus'), 'utf8'), 'legacy download');
    assert.equal(await readFile(path.join(music, 'my-song.mp3'), 'utf8'), 'user file');
  });

  it('does not adopt a folder of the same name that it did not create', async () => {
    await mkdir(path.join(music, CACHE_DIR_NAME));
    await writeFile(path.join(music, CACHE_DIR_NAME, 'notes.txt'), 'mine');
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await assert.rejects(cache.fetch(key, writer({ n: 0 })), /not created by TS6 Manager/);
    assert.deepEqual(await readdir(path.join(music, CACHE_DIR_NAME)), ['notes.txt']);
  });

  it('publishes nothing when verification fails', async () => {
    const cache = new MediaCache(music, { probe: async () => ({ hasAudio: false, durationSec: null }), log: () => {} });
    await assert.rejects(cache.fetch(key, writer({ n: 0 })), /no audio/);
    const v2 = path.join(music, CACHE_DIR_NAME, 'v2');
    assert.deepEqual((await readdir(v2)).sort(), ['locks', 'staging']);
    assert.deepEqual(await readdir(path.join(v2, 'staging')), []);
    assert.deepEqual(await readdir(path.join(v2, 'locks')), []);
  });

  it('treats an entry whose media is missing or changed as absent', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    const file = await cache.fetch(key, writer({ n: 0 }));
    await writeFile(file, 'truncated');
    assert.equal(await cache.lookup(key), null);
    await rm(file);
    assert.equal(await cache.lookup(key), null);
  });

  it('shares one download between requests, and cancels it only when every request left', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = { n: 0 };
    let jobSignal: AbortSignal | undefined;
    const download = async (staging: string, signal: AbortSignal) => { jobSignal = signal; return writer(calls, gate)(staging, signal); };
    const first = new AbortController();
    const second = new AbortController();
    const a = cache.fetch(key, download, { signal: first.signal });
    const b = cache.fetch(key, download, { signal: second.signal });
    for (let i = 0; i < 100 && !jobSignal; i++) await new Promise((r) => setTimeout(r, 5));
    first.abort(new Error('first left'));
    await assert.rejects(a, /first left/);
    assert.equal(jobSignal?.aborted, false, 'another request still waits');
    release();
    const file = await b;
    assert.ok(existsSync(file));
    assert.equal(calls.n, 1);

    const otherKey = cacheKey({ kind: 'youtube', videoId: 'bbbbbbbbbbb' });
    let otherSignal: AbortSignal | undefined;
    const never = new Promise<void>(() => {});
    const only = new AbortController();
    const c = cache.fetch(otherKey, async (staging, signal) => { otherSignal = signal; return writer({ n: 0 }, Promise.race([never, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))]))(staging, signal); }, { signal: only.signal });
    for (let i = 0; i < 100 && !otherSignal; i++) await new Promise((r) => setTimeout(r, 5));
    only.abort(new Error('left'));
    await assert.rejects(c, /left/);
    assert.equal(otherSignal?.aborted, true, 'the download stops when nobody waits');
    for (let i = 0; i < 100 && (await readdir(path.join(music, CACHE_DIR_NAME, 'v2', 'locks'))).length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(await readdir(path.join(music, CACHE_DIR_NAME, 'v2', 'locks')), [], 'its lock is released');
  });

  it('waits for another process holding the lock, and takes over a stale lock', async () => {
    let now = Date.now();
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {}, now: () => now });
    await cache.init();
    const lock = path.join(music, CACHE_DIR_NAME, 'v2', 'locks', `${key}.lock`);
    await writeFile(lock, JSON.stringify({ host: 'other-host', pid: 1, instance: 'other', token: 't' }));
    const calls = { n: 0 };
    const pending = cache.fetch(key, writer(calls));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.n, 0, 'waits while the lock is held');
    now += 4 * 60_000;
    assert.ok(await pending);
    assert.equal(calls.n, 1);
  });

  it('does not use a cache whose folders are links, and cleans up nothing through them', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await cache.init();
    const outside = path.join(music, 'elsewhere');
    await mkdir(outside);
    const old = path.join(outside, 'a'.repeat(32));
    await mkdir(old);
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(old, past, past);
    const staging = path.join(music, CACHE_DIR_NAME, 'v2', 'staging');
    await rm(staging, { recursive: true });
    await symlink(outside, staging);
    const fresh = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await assert.rejects(fresh.sweep(), /link where a folder belongs/);
    await assert.rejects(fresh.fetch(key, writer({ n: 0 })), /link where a folder belongs/);
    assert.ok(existsSync(old), 'nothing outside the cache was removed');
  });

  it('builds its folder under a temporary name, so no unmarked folder is left', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await cache.init();
    assert.deepEqual((await readdir(music)).sort(), [CACHE_DIR_NAME]);
    assert.equal(await readFile(path.join(music, CACHE_DIR_NAME, 'OWNER'), 'utf8'), 'ts6-manager media cache\nformat=2\n');
  });

  it('starts nothing for a request cancelled while the cache was being checked', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await cache.init();
    const controller = new AbortController();
    const calls = { n: 0 };
    const pending = cache.fetch(key, writer(calls), { signal: controller.signal });
    controller.abort(new Error('left early'));
    await assert.rejects(pending, /left early/);
    assert.equal(calls.n, 0);
  });

  it('does not join a download that is being cancelled, and keeps a newer one in the map', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const slow = async (staging: string, signal: AbortSignal) => {
      started++;
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))]);
      return writer({ n: 0 })(staging, signal);
    };
    const first = new AbortController();
    const a = cache.fetch(key, slow, { signal: first.signal });
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    first.abort(new Error('gone'));
    const b = cache.fetch(key, writer({ n: 0 }));
    await assert.rejects(a, /gone/);
    release();
    assert.ok(existsSync(await b), 'the new request got its own download');
  });

  it('passes progress to every request waiting for the same download', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    let started = false;
    const download = async (staging: string, signal: AbortSignal, report: (p: number) => void) => {
      started = true;
      await gate;
      report(75);
      return writer({ n: 0 })(staging, signal);
    };
    const a = cache.fetch<number>(key, download, { onProgress: (p) => seen.push(`a${p}`) });
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    const b = cache.fetch<number>(key, download, { onProgress: (p) => seen.push(`b${p}`) });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([a, b]);
    assert.ok(seen.includes('a75') && seen.includes('b75'), seen.join());
  });

  it('removes its own files when publishing fails, and keeps an earlier entry', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await cache.init();
    const v2 = path.join(music, CACHE_DIR_NAME, 'v2');
    // A folder where the manifest belongs makes the final rename fail.
    await mkdir(path.join(v2, `${key}.json`));
    await writeFile(path.join(v2, `${key}.json`, 'keep'), 'x');
    await assert.rejects(cache.fetch(key, writer({ n: 0 })));
    const left = (await readdir(v2)).filter((n) => n !== 'locks' && n !== 'staging').sort();
    assert.deepEqual(left, [`${key}.json`], 'no orphaned media or temporary manifest');
  });

  it('treats an entry whose content changed but not its size as absent', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    const file = await cache.fetch(key, writer({ n: 0 }));
    const later = new MediaCache(music, { probe: audioProbe, log: () => {} });
    assert.equal(await later.lookup(key), file);
    await writeFile(file, 'OPUS AUDIO BYTES');
    const fresh = new MediaCache(music, { probe: audioProbe, log: () => {} });
    assert.equal(await fresh.lookup(key), null);
  });

  it('takes over a lock left by an earlier run on this host at once, and releases only its own lock', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {}, hostname: 'host-a', instanceId: 'now' });
    await cache.init();
    const lock = path.join(music, CACHE_DIR_NAME, 'v2', 'locks', `${key}.lock`);
    // Same host and PID (a restarted container), different instance: the old run is gone.
    await writeFile(lock, JSON.stringify({ host: 'host-a', pid: process.pid, instance: 'before-restart', token: 'old' }));
    const calls = { n: 0 };
    assert.ok(await cache.fetch(key, writer(calls)));
    assert.equal(calls.n, 1);
    assert.equal(existsSync(lock), false);

    const otherKey = cacheKey({ kind: 'youtube', videoId: 'ccccccccccc' });
    const otherLock = path.join(music, CACHE_DIR_NAME, 'v2', 'locks', `${otherKey}.lock`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = cache.fetch(otherKey, writer({ n: 0 }, gate));
    for (let i = 0; i < 100 && !existsSync(otherLock); i++) await new Promise((r) => setTimeout(r, 5));
    // Another process takes the lock over meanwhile; finishing must not remove its lock.
    await writeFile(otherLock, JSON.stringify({ host: 'host-b', pid: 7, instance: 'b', token: 'theirs' }));
    release();
    await running;
    assert.match(await readFile(otherLock, 'utf8'), /theirs/);
  });

  it('sweeps only its own leftovers', async () => {
    let now = Date.now();
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {}, now: () => now });
    const file = await cache.fetch(key, writer({ n: 0 }));
    const v2 = path.join(music, CACHE_DIR_NAME, 'v2');
    const oldStaging = path.join(v2, 'staging', 'a'.repeat(32));
    const freshStaging = path.join(v2, 'staging', 'b'.repeat(32));
    const foreign = path.join(v2, 'staging', 'not-ours');
    for (const folder of [oldStaging, freshStaging, foreign]) await mkdir(folder);
    const past = new Date(now - 2 * 60 * 60_000);
    await utimes(oldStaging, past, past);
    await utimes(foreign, past, past);
    await writeFile(path.join(v2, 'locks', `${'c'.repeat(64)}.lock`), '{}');
    await utimes(path.join(v2, 'locks', `${'c'.repeat(64)}.lock`), past, past);
    await cache.sweep();
    assert.equal(existsSync(oldStaging), false);
    assert.equal(existsSync(freshStaging), true);
    assert.equal(existsSync(foreign), true, 'names it does not create are left alone');
    assert.deepEqual(await readdir(path.join(v2, 'locks')), []);
    assert.ok(existsSync(file), 'published media is never swept');
    now += 0;
  });
});
