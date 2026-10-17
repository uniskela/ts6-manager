import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CACHE_DIR_NAME, MediaCache, MediaCacheError, cacheKey, probeAudio, canonicalUrl, checkProbe, checkStagedFile,
  identityFromInfo, parseManifest, parseProbe, rememberSuccess, renameWithRetry, runFfprobeCheck, type StagedDownload,
} from './media-cache.js';

const audioProbe = async () => ({ hasAudio: true, durationSec: 100 });

/** A folder link: a junction on Windows, which needs no special privileges. */
function linkFolder(target: string, at: string): Promise<void> {
  return symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Create a file link; false only when Windows refuses it for lack of privileges.
 * Any other failure is a broken test setup and fails the test.
 */
function fileLink(target: string, at: string): Promise<boolean> {
  return symlink(target, at).then(() => true, (err: NodeJS.ErrnoException) => {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) return false;
    throw err;
  });
}

/** Settles with `gate`, or rejects when `signal` aborts; the listener is removed either way. */
function untilOrAbort(gate: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    gate.then(() => { signal.removeEventListener('abort', onAbort); resolve(); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); });
  });
}


describe('ffprobe check', () => {
  const node = process.execPath;

  it('passes when the command exits cleanly and fails otherwise', async () => {
    await runFfprobeCheck(node, ['-e', 'process.exit(0)']);
    await assert.rejects(runFfprobeCheck(node, ['-e', 'process.exit(3)']), /ffprobe could not run/);
    await assert.rejects(runFfprobeCheck('ts6-no-such-ffprobe-command'), /need ffprobe, which was not found/);
  });

  it('kills a command that does not answer and reports it', async () => {
    const started = Date.now();
    await assert.rejects(runFfprobeCheck(node, ['-e', 'setTimeout(() => {}, 60000)'], 300), /did not answer in time/);
    assert.ok(Date.now() - started < 10_000);
  });

  it('remembers a success, and checks again after a failure', async () => {
    let calls = 0;
    const outcomes = [false, true];
    const check = rememberSuccess(async () => {
      const ok = outcomes[calls++] ?? true;
      if (!ok) throw new MediaCacheError('ffprobe did not answer in time.');
    });
    await assert.rejects(check(), /did not answer/);
    await Promise.all([check(), check()]);
    await check();
    assert.equal(calls, 2, 'one failed check, then one shared successful check');
  });
});

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

  it('refuses anything else', async (t) => {
    const staging = path.join(dir, 'staging');
    await mkdir(staging);
    await mkdir(path.join(staging, 'sub'));
    await writeFile(path.join(staging, 'a.opus'), 'audio');
    await writeFile(path.join(staging, 'b.opus'), 'audio');
    await writeFile(path.join(staging, 'empty.opus'), '');
    await writeFile(path.join(staging, 'page.html'), '<html>');
    await writeFile(path.join(staging, 'sub', 'c.opus'), 'audio');
    await writeFile(path.join(dir, 'outside.opus'), 'audio');
    // File links need extra privileges on Windows; without them that case is not tested there.
    const linked = await fileLink(path.join(dir, 'outside.opus'), path.join(staging, 'link.opus'));
    if (!linked) t.diagnostic('file links need extra privileges on this Windows runner; the link case is not tested');
    const cases: Array<[string, string[]]> = [
      ['no file', []],
      ['two files', [path.join(staging, 'a.opus'), path.join(staging, 'b.opus')]],
      ['empty file', [path.join(staging, 'empty.opus')]],
      ['wrong type', [path.join(staging, 'page.html')]],
      ['nested folder', [path.join(staging, 'sub', 'c.opus')]],
      ['outside staging', [path.join(dir, 'outside.opus')]],
      ['missing', [path.join(staging, 'gone.opus')]],
    ];
    if (linked) cases.push(['link leading outside', [path.join(staging, 'link.opus')]]);
    for (const [label, reported] of cases) {
      await assert.rejects(checkStagedFile(staging, reported), MediaCacheError, label);
    }
  });

  it('requires audio with a readable, positive length that matches the metadata', () => {
    assert.deepEqual(parseProbe('{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"212.4"}}'), { hasAudio: true, durationSec: 212.4 });
    assert.equal(parseProbe('{"streams":[{"codec_type":"audio"}],"format":{"duration":"N/A"}}').durationSec, null);
    assert.equal(parseProbe('{"streams":[{"codec_type":"audio","duration":"98.5"}],"format":{"duration":"N/A"}}').durationSec, 98.5, 'the audio stream\'s length when the container has none');
    assert.equal(checkProbe({ hasAudio: true, durationSec: 212 }, 214), 212);
    assert.doesNotThrow(() => checkProbe({ hasAudio: true, durationSec: 3600 }, 3900), 'within 10%');
    assert.doesNotThrow(() => checkProbe({ hasAudio: true, durationSec: 5 }, 14), 'within 10 seconds');
    // Metadata without a length: the probe must still read one.
    assert.equal(checkProbe({ hasAudio: true, durationSec: 30 }, null), 30);
    assert.throws(() => checkProbe({ hasAudio: true, durationSec: null }, null), /could not be read/);
    // A length the probe cannot read is refused even when the metadata announced one.
    assert.throws(() => checkProbe({ hasAudio: true, durationSec: null }, 214), /could not be read/);
    assert.throws(() => checkProbe({ hasAudio: true, durationSec: 0 }, null), /could not be read/);
    // Metadata and probe disagree.
    assert.throws(() => checkProbe({ hasAudio: true, durationSec: 30 }, 214), /does not match/);
    assert.throws(() => checkProbe({ hasAudio: true, durationSec: 4000 }, 3600), /does not match/);
    assert.throws(() => checkProbe({ hasAudio: false, durationSec: 200 }, 200), /no audio/);
  });

  it('publishes nothing when the length cannot be read, with or without metadata', async () => {
    for (const expected of [null, 120]) {
      const music = await mkdtemp(path.join(tmpdir(), 'ts6-cache-length-'));
      try {
        const cache = new MediaCache(music, { probe: async () => ({ hasAudio: true, durationSec: null }), log: () => {} });
        const key = cacheKey({ kind: 'youtube', videoId: 'abcdefghijk' });
        const download = async (staging: string): Promise<StagedDownload> => {
          const file = path.join(staging, 'media.opus');
          await writeFile(file, 'audio');
          return { reportedPaths: [file], expectedDurationSec: expected, kind: 'youtube', extractor: 'Youtube' };
        };
        await assert.rejects(cache.fetch(key, download), /could not be read/);
        assert.equal(await cache.lookup(key), null);
      } finally {
        await rm(music, { recursive: true, force: true });
      }
    }
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

  it('explains a missing ffprobe in words an administrator can act on', async () => {
    const previous = process.env.PATH;
    process.env.PATH = path.join(dir, 'no-tools-here');
    try {
      await assert.rejects(probeAudio(path.join(dir, 'x.opus')), /New downloads need ffprobe, which was not found/);
    } finally {
      process.env.PATH = previous;
    }
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
    assert.equal(parseManifest('null', key), null);
    assert.equal(parseManifest('[]', key), null);
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
    assert.ok(jobSignal, 'the download started');
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
    const c = cache.fetch(otherKey, async (staging, signal) => { otherSignal = signal; return writer({ n: 0 }, untilOrAbort(never, signal))(staging, signal); }, { signal: only.signal });
    for (let i = 0; i < 100 && !otherSignal; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(otherSignal, 'the download started');
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
    await linkFolder(outside, staging);
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
      await untilOrAbort(gate, signal);
      return writer({ n: 0 })(staging, signal);
    };
    const first = new AbortController();
    const a = cache.fetch(key, slow, { signal: first.signal });
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(started, 'the download started');
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
    assert.ok(started, 'the download started');
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

  });

  // On Windows a lock file cannot be replaced while its owner still has it open (it stays
  // pending delete), so another process can never take it over mid-download there.
  it('releases only its own lock when another process took it over mid-download', { skip: process.platform === 'win32' ? 'an open lock file stays pending delete on Windows' : false }, async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {}, hostname: 'host-a', instanceId: 'now' });
    await cache.init();
    const otherKey = cacheKey({ kind: 'youtube', videoId: 'ccccccccccc' });
    const otherLock = path.join(music, CACHE_DIR_NAME, 'v2', 'locks', `${otherKey}.lock`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = cache.fetch(otherKey, writer({ n: 0 }, gate));
    for (let i = 0; i < 100 && !existsSync(otherLock); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(existsSync(otherLock), 'the lock was taken');
    // Another process takes the lock over meanwhile (a new file at that path); finishing must not remove it.
    await rm(otherLock);
    await writeFile(otherLock, JSON.stringify({ host: 'host-b', pid: 7, instance: 'b', token: 'theirs' }));
    release();
    await running;
    assert.match(await readFile(otherLock, 'utf8'), /theirs/);
  });

  it('creates nothing outside the cache when a sub-folder is a link', async () => {
    const root = path.join(music, CACHE_DIR_NAME);
    await mkdir(root);
    await writeFile(path.join(root, 'OWNER'), 'ts6-manager media cache\nformat=2\n');
    const outside = path.join(music, 'elsewhere');
    await mkdir(outside);
    await linkFolder(outside, path.join(root, 'v2'));
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await assert.rejects(cache.init(), /link where a folder belongs/);
    assert.deepEqual(await readdir(outside), [], 'no locks or staging folder were created through the link');
  });

  it('gives no result to a request cancelled while a cache hit was checked', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await cache.fetch(key, writer({ n: 0 }));
    const controller = new AbortController();
    const pending = new MediaCache(music, { probe: audioProbe, log: () => {} }).fetch(key, writer({ n: 0 }), { signal: controller.signal });
    controller.abort(new Error('left'));
    await assert.rejects(pending, /left/);
  });

  it('keeps progress for a request when another request with the same callback leaves', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const seen: number[] = [];
    const shared = (p: number) => seen.push(p);
    const download = async (staging: string, signal: AbortSignal, report: (p: number) => void) => {
      started = true;
      await gate;
      report(90);
      return writer({ n: 0 })(staging, signal);
    };
    const leaving = new AbortController();
    const a = cache.fetch<number>(key, download, { onProgress: shared, signal: leaving.signal });
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(started, 'the download started');
    const b = cache.fetch<number>(key, download, { onProgress: shared });
    leaving.abort(new Error('a left'));
    await assert.rejects(a, /a left/);
    release();
    await b;
    assert.deepEqual(seen, [90], 'the remaining request still gets progress');
  });

  it('reports a stale lock it cannot remove instead of retrying without pause', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    await cache.init();
    const locks = path.join(music, CACHE_DIR_NAME, 'v2', 'locks');
    const lock = path.join(locks, `${key}.lock`);
    await writeFile(lock, JSON.stringify({ host: 'other-host', pid: 1, instance: 'x', token: 't' }));
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, past, past);
    await chmod(locks, 0o555);
    try {
      await assert.rejects(cache.fetch(key, writer({ n: 0 })), /stale download lock could not be removed/);
    } finally {
      await chmod(locks, 0o755);
    }
  });

  it('keeps ids that differ only by letter case apart on any filesystem', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    const upper = cacheKey({ kind: 'youtube', videoId: 'aBcDeFgHiJk' });
    const lower = cacheKey({ kind: 'youtube', videoId: 'abcdefghijk' });
    const content = (text: string) => async (staging: string): Promise<StagedDownload> => {
      const file = path.join(staging, 'media.opus');
      await writeFile(file, text);
      return { reportedPaths: [file], expectedDurationSec: 100, kind: 'youtube', extractor: 'Youtube' };
    };
    const a = await cache.fetch(upper, content('upper case id'));
    const b = await cache.fetch(lower, content('lower case id'));
    assert.notEqual(a.toLowerCase(), b.toLowerCase(), 'the names differ even ignoring case');
    assert.equal(await readFile(a, 'utf8'), 'upper case id');
    assert.equal(await readFile(b, 'utf8'), 'lower case id');
    assert.equal(await cache.lookup(upper), a);
    assert.equal(await cache.lookup(lower), b);
  });

  it('replaces an entry while its old file is still open', async () => {
    const cache = new MediaCache(music, { probe: audioProbe, log: () => {} });
    const first = await cache.fetch(key, writer({ n: 0 }));
    // A player keeps the old file open (on Windows this blocks renaming over it or deleting it).
    const { open } = await import('node:fs/promises');
    const handle = await open(first, 'r');
    try {
      await writeFile(path.join(music, CACHE_DIR_NAME, 'v2', `${key}.json`), 'not a manifest');
      const fresh = new MediaCache(music, { probe: audioProbe, log: () => {} });
      const second = await fresh.fetch(key, writer({ n: 0 }));
      assert.notEqual(second, first, 'published under a fresh name');
      assert.equal(await fresh.lookup(key), second);
      assert.equal((await handle.read(Buffer.alloc(4), 0, 4, 0)).bytesRead, 4, 'the open file is still readable');
      assert.ok(existsSync(first), 'the old file is not removed');
    } finally {
      await handle.close();
    }
  });

  it('downloads nothing when ffprobe is missing', async () => {
    const calls = { n: 0 };
    const cache = new MediaCache(music, {
      probe: audioProbe,
      probeReady: async () => { throw new MediaCacheError('New downloads need ffprobe, which was not found.'); },
      log: () => {},
    });
    await assert.rejects(cache.fetch(key, writer(calls)), /need ffprobe/);
    assert.equal(calls.n, 0);
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
