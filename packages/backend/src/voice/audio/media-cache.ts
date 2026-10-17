import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Application-owned download cache for audio downloads.
 *
 * Layout under the music folder (never scanned by `/scan`, which reads the top
 * level only):
 *
 *   .ts6-media-cache/
 *     OWNER                    marker: this folder belongs to TS6 Manager
 *     v2/<key>.<rand>.<ext>     media, published once and never overwritten
 *     v2/<key>.json            manifest, the commit marker
 *     v2/locks/<key>.lock      cross-process lock
 *     v2/staging/<random>/     one folder per download job
 *
 * Every name is built here from a lower-case hex key, random lower-case hex
 * and an allowlisted lower-case extension: nothing reported by the downloader
 * becomes part of a published path, and names cannot collide by letter case.
 * Nothing outside this folder is read as a cache hit, renamed or deleted.
 * Manifests never hold a source URL.
 */

export const CACHE_DIR_NAME = '.ts6-media-cache';
const OWNER_MARKER = 'ts6-manager media cache\nformat=2\n';
const FORMAT = 2;

/** Audio extensions a cached download may have. */
export const CACHE_EXTENSIONS: ReadonlySet<string> = new Set(['opus', 'ogg', 'webm', 'm4a', 'mp3', 'aac', 'flac', 'wav', 'mp4']);
/** Largest download accepted into the cache. */
export const MAX_CACHE_FILE_BYTES = 1024 * 1024 * 1024;

const KEY_RE = /^[0-9a-f]{64}$/;
const MEDIA_RE = /^([0-9a-f]{64})\.([0-9a-f]{16})\.([a-z0-9]{2,5})$/;
const STAGING_RE = /^[0-9a-f]{32}$/;
const LOCK_RE = /^[0-9a-f]{64}\.lock$/;

/** A lock older than this belongs to a process that is gone. */
const LOCK_STALE_MS = 20 * 60_000;
/** Staging folders older than this are left over from a crash. */
const STAGING_STALE_MS = 60 * 60_000;

export class MediaCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaCacheError';
  }
}

// ── Source identity ────────────────────────────────────────────────────────

/** What a download is, as the backend determined it. */
export type SourceIdentity =
  | { kind: 'youtube'; videoId: string }
  | { kind: 'url'; extractor: string; mediaId: string; canonicalUrl: string };

/**
 * The requested URL in canonical form: lower-case scheme and host, no
 * default port, no fragment; path and query kept as they are. Credentials
 * are refused before this point and dropped here anyway.
 */
export function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  const defaultPort = (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80');
  const host = url.hostname.toLowerCase() + (url.port && !defaultPort ? `:${url.port}` : '');
  return `${url.protocol.toLowerCase()}//${host}${url.pathname}${url.search}`;
}

/** Cache key: sha256 over a versioned, length-prefixed encoding of the identity, as hex. */
export function cacheKey(identity: SourceIdentity): string {
  const fields = identity.kind === 'youtube'
    ? ['ts6-media-cache', String(FORMAT), 'youtube', identity.videoId]
    : ['ts6-media-cache', String(FORMAT), 'url', identity.extractor, identity.mediaId, identity.canonicalUrl];
  const hash = createHash('sha256');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

/**
 * Check yt-dlp's metadata against what was asked for and return the identity
 * to cache under. Refuses playlists and anything but one item; for YouTube
 * the extractor and video id must match the id the backend parsed itself.
 */
export function identityFromInfo(
  request: { youtubeVideoId?: string; url: string },
  info: Record<string, unknown>,
): SourceIdentity {
  const type = info._type;
  if ((type !== undefined && type !== 'video') || 'entries' in info) {
    throw new MediaCacheError('The link is not a single track.');
  }
  const requested = info.requested_downloads;
  if (Array.isArray(requested) && requested.length > 1) throw new MediaCacheError('The link is not a single track.');
  const extractor = typeof info.extractor_key === 'string' ? info.extractor_key : '';
  const mediaId = typeof info.id === 'string' ? info.id : '';
  if (!extractor || !mediaId) throw new MediaCacheError('The downloader did not identify the track.');
  if (request.youtubeVideoId !== undefined) {
    if (extractor !== 'Youtube' || mediaId !== request.youtubeVideoId) {
      throw new MediaCacheError('The downloader returned a different video than the one requested.');
    }
    return { kind: 'youtube', videoId: request.youtubeVideoId };
  }
  return { kind: 'url', extractor, mediaId, canonicalUrl: canonicalUrl(request.url) };
}

// ── Verification of a finished download ────────────────────────────────────

export interface ProbeResult { hasAudio: boolean; durationSec: number | null }

/** Run ffprobe on a local file; rejects when ffprobe is missing or fails. */
export function probeAudio(filePath: string, timeoutMs = 30_000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', filePath,
    ], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (chunk: Buffer) => { out = (out + chunk.toString()).slice(-65_536); });
    proc.on('error', (err) => { clearTimeout(timer); reject(new MediaCacheError(`ffprobe could not run (${(err as NodeJS.ErrnoException).code ?? err.name})`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new MediaCacheError('The downloaded file could not be read as audio.')); return; }
      try {
        resolve(parseProbe(out));
      } catch {
        reject(new MediaCacheError('The downloaded file could not be read as audio.'));
      }
    });
  });
}

export function parseProbe(json: string): ProbeResult {
  const data = JSON.parse(json) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
  const duration = Number(data.format?.duration);
  return {
    hasAudio: (data.streams ?? []).some((s) => s.codec_type === 'audio'),
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

/** The probe must find audio, and a duration close to the one the metadata announced. */
export function checkProbe(probe: ProbeResult, expectedSec: number | null): void {
  if (!probe.hasAudio) throw new MediaCacheError('The downloaded file has no audio.');
  if (expectedSec && expectedSec > 0 && probe.durationSec !== null) {
    const tolerance = Math.max(10, expectedSec * 0.1);
    if (Math.abs(probe.durationSec - expectedSec) > tolerance) {
      throw new MediaCacheError('The downloaded file does not match the track length.');
    }
  }
}

/**
 * Check the file the downloader reported: exactly one path, inside the job's
 * staging folder after resolving links, a regular file, an allowed extension
 * and a size within bounds. Returns the real path and the extension.
 */
export async function checkStagedFile(stagingDir: string, reported: string[]): Promise<{ file: string; ext: string; size: number }> {
  const paths = reported.map((line) => line.trim()).filter(Boolean);
  if (paths.length !== 1) throw new MediaCacheError('The downloader did not produce exactly one file.');
  const root = await realpath(stagingDir);
  let file: string;
  try {
    file = await realpath(paths[0]);
  } catch {
    throw new MediaCacheError('The downloaded file is missing.');
  }
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new MediaCacheError('The downloaded file is not where it was expected.');
  }
  const info = await lstat(file);
  if (!info.isFile()) throw new MediaCacheError('The downloaded file is not a regular file.');
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!CACHE_EXTENSIONS.has(ext)) throw new MediaCacheError('The downloaded file type is not allowed.');
  if (info.size <= 0 || info.size > MAX_CACHE_FILE_BYTES) throw new MediaCacheError('The downloaded file size is not allowed.');
  return { file, ext, size: info.size };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ── Manifest ───────────────────────────────────────────────────────────────

/** What a cache entry records. No URL, no downloader-reported text beyond the extractor name. */
export interface Manifest {
  format: number;
  key: string;
  kind: SourceIdentity['kind'];
  /** Extractor name, e.g. `Youtube`, `Generic`. */
  extractor: string;
  file: string;
  size: number;
  sha256: string;
  durationSec: number | null;
  createdAt: string;
}

/** A manifest that is well formed and names a file this cache could have published for `key`. */
export function parseManifest(text: string, key: string): Manifest | null {
  let data: Partial<Manifest>;
  try {
    data = JSON.parse(text) as Partial<Manifest>;
  } catch {
    return null;
  }
  const match = typeof data.file === 'string' ? MEDIA_RE.exec(data.file) : null;
  if (data.format !== FORMAT || data.key !== key || !match || match[1] !== key || !CACHE_EXTENSIONS.has(match[3])) return null;
  if (typeof data.size !== 'number' || data.size <= 0 || typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256)) return null;
  if (data.kind !== 'youtube' && data.kind !== 'url') return null;
  return data as Manifest;
}

// ── Cache ──────────────────────────────────────────────────────────────────

export interface StagedDownload {
  /** Lines the downloader printed for its final file (`--print after_move:filepath`). */
  reportedPaths: string[];
  /** Duration the metadata announced, if any. */
  expectedDurationSec: number | null;
  extractor: string;
}

export interface MediaCacheOptions {
  probe?: (file: string) => Promise<ProbeResult>;
  now?: () => number;
  log?: (message: string) => void;
}

interface Flight {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
}

/**
 * Rename, retrying briefly when the target is momentarily in use. Windows
 * refuses to replace a file another process has open (EPERM, EBUSY, EACCES);
 * readers hold a manifest only for an instant.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  doRename: (from: string, to: string) => Promise<void> = rename,
  attempts = 10,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export class MediaCache {
  readonly root: string;
  private readonly v2: string;
  private readonly flights = new Map<string, Flight>();
  private ready?: Promise<void>;
  private readonly probe: (file: string) => Promise<ProbeResult>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(musicDir: string, options: MediaCacheOptions = {}) {
    this.root = path.join(musicDir, CACHE_DIR_NAME);
    this.v2 = path.join(this.root, 'v2');
    this.probe = options.probe ?? probeAudio;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /**
   * Create the cache folder with its marker, or check an existing one. A
   * folder of that name without the marker is not adopted: it may be the
   * user's, so it is left untouched and downloads fail with a clear message.
   */
  init(): Promise<void> {
    this.ready ??= (async () => {
      let created = false;
      try {
        await mkdir(this.root);
        created = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const marker = path.join(this.root, 'OWNER');
      if (created) {
        await writeFile(marker, OWNER_MARKER, { flag: 'wx' });
      } else {
        const content = await readFile(marker, 'utf8').catch(() => '');
        if (content !== OWNER_MARKER) {
          throw new MediaCacheError(`The folder ${CACHE_DIR_NAME} in the music folder was not created by TS6 Manager; rename or move it so downloads can use the cache.`);
        }
      }
      for (const dir of [this.v2, path.join(this.v2, 'locks'), path.join(this.v2, 'staging')]) {
        await mkdir(dir, { recursive: true });
      }
    })();
    this.ready.catch(() => { this.ready = undefined; });
    return this.ready;
  }

  /** The cached file for `key`, or null. Only a complete entry (manifest last) counts. */
  async lookup(key: string): Promise<string | null> {
    if (!KEY_RE.test(key)) return null;
    await this.init();
    const text = await readFile(path.join(this.v2, `${key}.json`), 'utf8').catch(() => null);
    if (text === null) return null;
    const manifest = parseManifest(text, key);
    if (!manifest) return null;
    const file = path.join(this.v2, manifest.file);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.size !== manifest.size) return null;
    return file;
  }

  /**
   * The cached file for `key`, downloading it once if needed. Requests for the
   * same key share one download; a request that is cancelled just stops
   * waiting, and the download stops when nobody waits for it any more.
   * `download` writes into the staging folder it is given and reports its file.
   */
  async fetch(
    key: string,
    download: (stagingDir: string, signal: AbortSignal) => Promise<StagedDownload>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!KEY_RE.test(key)) throw new MediaCacheError('Invalid cache key.');
    signal?.throwIfAborted();
    const hit = await this.lookup(key);
    if (hit) return hit;
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight = {
        controller,
        waiters: 0,
        promise: this.produce(key, download, controller.signal).finally(() => this.flights.delete(key)),
      };
      // Waiters handle the outcome; this keeps an abandoned flight's rejection from going unhandled.
      created.promise.catch(() => undefined);
      this.flights.set(key, created);
      flight = created;
    }
    const current = flight;
    current.waiters++;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      current.waiters--;
      if (current.waiters === 0) current.controller.abort(new MediaCacheError('Download cancelled.'));
    };
    try {
      if (!signal) return await current.promise;
      return await new Promise<string>((resolve, reject) => {
        const onAbort = () => { leave(); reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
        current.promise.then(
          (file) => { signal.removeEventListener('abort', onAbort); resolve(file); },
          (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
        );
      });
    } finally {
      // A waiter that finished (either way) no longer holds the download; cancellation already left.
      if (!left) { left = true; current.waiters--; }
    }
  }

  /** Download under the lock, verify, then publish media and manifest. */
  private async produce(
    key: string,
    download: (stagingDir: string, signal: AbortSignal) => Promise<StagedDownload>,
    signal: AbortSignal,
  ): Promise<string> {
    await this.init();
    const unlock = await this.lock(key, signal);
    const staging = path.join(this.v2, 'staging', randomBytes(16).toString('hex'));
    try {
      // Another process may have finished it while we waited for the lock.
      const done = await this.lookup(key);
      if (done) return done;
      await mkdir(staging);
      const result = await download(staging, signal);
      signal.throwIfAborted();
      const staged = await checkStagedFile(staging, result.reportedPaths);
      checkProbe(await this.probe(staged.file), result.expectedDurationSec);
      signal.throwIfAborted();
      return await this.publish(key, staged, result);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await unlock();
    }
  }

  private async publish(key: string, staged: { file: string; ext: string; size: number }, result: StagedDownload): Promise<string> {
    const name = `${key}.${randomBytes(8).toString('hex')}.${staged.ext}`;
    const target = path.join(this.v2, name);
    const manifest: Manifest = {
      format: FORMAT,
      key,
      kind: result.extractor === 'Youtube' ? 'youtube' : 'url',
      extractor: result.extractor.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64),
      file: name,
      size: staged.size,
      sha256: await sha256File(staged.file),
      durationSec: result.expectedDurationSec,
      createdAt: new Date(this.now()).toISOString(),
    };
    // A fresh name each time: nothing is renamed over an existing file, which Windows
    // refuses while it is open and which could pull a file from under a player.
    await rename(staged.file, target);
    const temporary = path.join(this.v2, `${key}.json.${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(JSON.stringify(manifest));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, path.join(this.v2, `${key}.json`));
    await this.syncDir(this.v2);
    return target;
  }

  /** Persist a rename; not supported on every platform (Windows), where it is skipped. */
  private async syncDir(dir: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(dir, fsConstants.O_RDONLY).catch(() => null);
    if (!handle) return;
    try { await handle.sync(); } catch { /* not supported here */ } finally { await handle.close(); }
  }

  /** Cross-process lock (defence in depth; within one process the flight map is enough). */
  private async lock(key: string, signal: AbortSignal): Promise<() => Promise<void>> {
    const file = path.join(this.v2, 'locks', `${key}.lock`);
    for (;;) {
      signal.throwIfAborted();
      try {
        const handle = await open(file, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: this.now() }));
        await handle.close();
        return () => rm(file, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const held = await stat(file).catch(() => null);
      if (held && this.now() - held.mtimeMs > LOCK_STALE_MS) {
        this.log(`[MediaCache] Removing a stale download lock (${key.slice(0, 12)})`);
        await rm(file, { force: true });
        continue;
      }
      await delay(500, signal);
    }
  }

  /**
   * Remove what crashed or cancelled jobs left behind: old staging folders and
   * stale locks, only inside the cache and only names this cache creates.
   * Published media and manifests are never removed here.
   */
  async sweep(): Promise<void> {
    await this.init();
    const now = this.now();
    const staging = path.join(this.v2, 'staging');
    for (const name of await readdir(staging).catch(() => [] as string[])) {
      if (!STAGING_RE.test(name)) continue;
      const info = await lstat(path.join(staging, name)).catch(() => null);
      if (info?.isDirectory() && now - info.mtimeMs > STAGING_STALE_MS) {
        await rm(path.join(staging, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const locks = path.join(this.v2, 'locks');
    for (const name of await readdir(locks).catch(() => [] as string[])) {
      if (!LOCK_RE.test(name)) continue;
      const info = await lstat(path.join(locks, name)).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs > LOCK_STALE_MS) await rm(path.join(locks, name), { force: true }).catch(() => undefined);
    }
  }
}

const caches = new Map<string, MediaCache>();

/** Use `cache` for a music folder (tests). Pass undefined to go back to the default. */
export function setMediaCacheForTests(musicDir: string, cache: MediaCache | undefined): void {
  const root = path.resolve(musicDir);
  if (cache) caches.set(root, cache);
  else caches.delete(root);
}

/** The shared cache for a music folder. */
export function mediaCacheFor(musicDir: string): MediaCache {
  const root = path.resolve(musicDir);
  let cache = caches.get(root);
  if (!cache) {
    cache = new MediaCache(root);
    caches.set(root, cache);
  }
  return cache;
}
