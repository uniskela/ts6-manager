import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
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
  if (expectedSec && expectedSec > 0) {
    // An announced length must be confirmed: a file whose length cannot be read is not kept.
    const tolerance = Math.max(10, expectedSec * 0.1);
    if (probe.durationSec === null || Math.abs(probe.durationSec - expectedSec) > tolerance) {
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
  /** The identity kind the entry was keyed by. */
  kind: SourceIdentity['kind'];
  extractor: string;
}

/** Progress from a shared download, passed to every request waiting for it. */
export type ProgressListener<P> = (progress: P) => void;

export interface MediaCacheOptions {
  probe?: (file: string) => Promise<ProbeResult>;
  now?: () => number;
  log?: (message: string) => void;
  /** Tests: identify this process differently. */
  instanceId?: string;
  hostname?: string;
  isAlive?: (pid: number) => boolean;
}

interface Flight<P> {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
  listeners: Set<ProgressListener<P>>;
}

/**
 * Rename, retrying briefly when the target is momentarily in use. Windows
 * refuses to replace or move a file another process has open (EPERM, EBUSY,
 * EACCES), for example an antivirus scan or a reader of a manifest.
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
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock's owner. */
interface LockOwner { host: string; pid: number; instance: string; token: string }

/** A lock untouched for this long belongs to a job that is gone; owners refresh it every minute. */
const LOCK_STALE_MS = 3 * 60_000;
const LOCK_HEARTBEAT_MS = 60_000;
const SIDE_FILE_RE = /^[0-9a-f]{64}\.(?:json\.[0-9a-f]{16}\.tmp|lock\.[0-9a-f]{16}\.stale)$/;

export class MediaCache {
  readonly root: string;
  private readonly v2: string;
  private readonly flights = new Map<string, Flight<unknown>>();
  /** Entries whose checksum was confirmed in this process: key → file, size and mtime. */
  private readonly verified = new Map<string, string>();
  private ready?: Promise<void>;
  private readonly probe: (file: string) => Promise<ProbeResult>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly instance: string;
  private readonly host: string;
  private readonly isAlive: (pid: number) => boolean;

  constructor(musicDir: string, options: MediaCacheOptions = {}) {
    this.root = path.join(musicDir, CACHE_DIR_NAME);
    this.v2 = path.join(this.root, 'v2');
    this.probe = options.probe ?? probeAudio;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
    this.instance = options.instanceId ?? randomBytes(16).toString('hex');
    this.host = options.hostname ?? hostname();
    this.isAlive = options.isAlive ?? processAlive;
  }

  /**
   * Create the cache folder with its marker, or check an existing one. The
   * folder is built under a temporary name and renamed into place, so a crash
   * never leaves an unmarked folder behind. A folder of that name without the
   * marker is not adopted: it may be the user's, so it is left untouched and
   * downloads fail with a clear message.
   */
  init(): Promise<void> {
    this.ready ??= (async () => {
      if (!(await lstat(this.root).catch(() => null))) {
        const building = `${this.root}.${randomBytes(8).toString('hex')}.tmp`;
        await mkdir(building);
        try {
          await writeFile(path.join(building, 'OWNER'), OWNER_MARKER, { flag: 'wx' });
          await rename(building, this.root);
        } catch {
          // Another process created it first; only the folder this call built is removed.
          await rm(building, { recursive: true, force: true });
        }
      }
      const owner = await lstat(path.join(this.root, 'OWNER')).catch(() => null);
      const content = owner?.isFile() ? await readFile(path.join(this.root, 'OWNER'), 'utf8').catch(() => '') : '';
      if (content !== OWNER_MARKER) {
        throw new MediaCacheError(`The folder ${CACHE_DIR_NAME} in the music folder was not created by TS6 Manager; rename or move it so downloads can use the cache.`);
      }
      for (const dir of [this.v2, path.join(this.v2, 'locks'), path.join(this.v2, 'staging')]) {
        await mkdir(dir).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
      }
      await this.assertLayout();
    })();
    this.ready.catch(() => { this.ready = undefined; });
    return this.ready;
  }

  /**
   * The cache folder and its sub-folders must be real folders, not links or
   * junctions, so nothing the cache writes or cleans up can land outside it.
   */
  private async assertLayout(): Promise<void> {
    const parts = ['', 'v2', path.join('v2', 'locks'), path.join('v2', 'staging')];
    const realRoot = await realpath(this.root);
    for (const part of parts) {
      const dir = path.join(this.root, part);
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaCacheError('The download cache contains a link where a folder belongs; downloads are paused until it is removed.');
      if ((await realpath(dir)) !== path.join(realRoot, part)) throw new MediaCacheError('The download cache contains a link where a folder belongs; downloads are paused until it is removed.');
    }
  }

  /** The cached file for `key`, or null. Only a complete, intact entry (manifest last) counts. */
  async lookup(key: string): Promise<string | null> {
    if (!KEY_RE.test(key)) return null;
    await this.init();
    const manifestPath = path.join(this.v2, `${key}.json`);
    const manifestInfo = await lstat(manifestPath).catch(() => null);
    if (!manifestInfo?.isFile()) return null;
    const manifest = parseManifest(await readFile(manifestPath, 'utf8').catch(() => ''), key);
    if (!manifest) return null;
    const file = path.join(this.v2, manifest.file);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.size !== manifest.size) return null;
    // The content is checked once per process (and again if the file changes).
    const fingerprint = `${manifest.file}:${info.size}:${info.mtimeMs}`;
    if (this.verified.get(key) !== fingerprint) {
      if ((await sha256File(file)) !== manifest.sha256) return null;
      this.verified.set(key, fingerprint);
    }
    return file;
  }

  /**
   * The cached file for `key`, downloading it once if needed. Requests for the
   * same key share one download and its progress; a request that is cancelled
   * just stops waiting, and the download stops when nobody waits any more.
   * `download` writes into the staging folder it is given and reports its file.
   */
  async fetch<P = never>(
    key: string,
    download: (stagingDir: string, signal: AbortSignal, progress: ProgressListener<P>) => Promise<StagedDownload>,
    options: { signal?: AbortSignal; onProgress?: ProgressListener<P> } = {},
  ): Promise<string> {
    const { signal, onProgress } = options;
    if (!KEY_RE.test(key)) throw new MediaCacheError('Invalid cache key.');
    signal?.throwIfAborted();
    const hit = await this.lookup(key);
    if (hit) return hit;
    signal?.throwIfAborted();
    let flight = this.flights.get(key) as Flight<P> | undefined;
    // A flight whose last waiter left is finishing its clean-up; it is not joined.
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const created: Flight<P> = { controller, waiters: 0, listeners: new Set(), promise: Promise.resolve('') };
      const report: ProgressListener<P> = (progress) => {
        for (const listener of created.listeners) {
          try { listener(progress); } catch { /* one listener's error must not stop the download */ }
        }
      };
      created.promise = this.produce(key, (dir, jobSignal) => download(dir, jobSignal, report), controller.signal)
        .finally(() => { if (this.flights.get(key) === created) this.flights.delete(key); });
      // Waiters handle the outcome; this keeps an abandoned flight's rejection from going unhandled.
      created.promise.catch(() => undefined);
      this.flights.set(key, created as Flight<unknown>);
      flight = created;
    }
    const current = flight;
    current.waiters++;
    if (onProgress) current.listeners.add(onProgress);
    let left = false;
    const leave = (cancelled: boolean) => {
      if (left) return;
      left = true;
      current.waiters--;
      if (onProgress) current.listeners.delete(onProgress);
      if (cancelled && current.waiters === 0) current.controller.abort(new MediaCacheError('Download cancelled.'));
    };
    try {
      if (!signal) return await current.promise;
      return await new Promise<string>((resolve, reject) => {
        const onAbort = () => { leave(true); reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
        // Cancelled between the checks above and here: abort events are not replayed.
        if (signal.aborted) { onAbort(); return; }
        current.promise.then(
          (file) => { signal.removeEventListener('abort', onAbort); resolve(file); },
          (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
        );
      });
    } finally {
      leave(false);
    }
  }

  /** Download under the lock, verify, then publish media and manifest. */
  private async produce(
    key: string,
    download: (stagingDir: string, signal: AbortSignal) => Promise<StagedDownload>,
    signal: AbortSignal,
  ): Promise<string> {
    await this.init();
    await this.assertLayout();
    const unlock = await this.lock(key, signal);
    const staging = path.join(this.v2, 'staging', randomBytes(16).toString('hex'));
    try {
      // Another process may have finished it while we waited for the lock.
      const done = await this.lookup(key);
      if (done) return done;
      // Private: the info document can hold signed media links and cookies.
      await mkdir(staging, { mode: 0o700 });
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
    const temporary = path.join(this.v2, `${key}.json.${randomBytes(8).toString('hex')}.tmp`);
    // The media is on disk before the manifest that points to it.
    await syncFile(staged.file);
    const manifest: Manifest = {
      format: FORMAT,
      key,
      kind: result.kind,
      extractor: result.extractor.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64),
      file: name,
      size: staged.size,
      sha256: await sha256File(staged.file),
      durationSec: result.expectedDurationSec,
      createdAt: new Date(this.now()).toISOString(),
    };
    let committed = false;
    try {
      // A fresh name each time: nothing is renamed over an existing file, which Windows
      // refuses while it is open and which could pull a file from under a player.
      await renameWithRetry(staged.file, target);
      await this.syncDir(this.v2);
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(JSON.stringify(manifest));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(temporary, path.join(this.v2, `${key}.json`));
      committed = true;
      await this.syncDir(this.v2);
    } finally {
      if (!committed) {
        // Only this job's own uncommitted files; an entry committed earlier stays as it was.
        await rm(target, { force: true }).catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    const published = await lstat(target);
    this.verified.set(key, `${name}:${published.size}:${published.mtimeMs}`);
    return target;
  }

  /** Persist a rename; not supported on every platform (Windows), where it is skipped. */
  private async syncDir(dir: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(dir, fsConstants.O_RDONLY).catch(() => null);
    if (!handle) return;
    try { await handle.sync(); } catch { /* not supported here */ } finally { await handle.close(); }
  }

  /**
   * Cross-process lock (within one process the flight map is enough). The owner
   * refreshes it every minute; a lock older than three minutes, or one left by
   * an earlier run of a process on this host, is taken over. Integrity never
   * depends on the lock: publication is atomic, so a lost lock can at worst
   * cause one duplicate download.
   */
  private async lock(key: string, signal: AbortSignal): Promise<() => Promise<void>> {
    const file = path.join(this.v2, 'locks', `${key}.lock`);
    const me: LockOwner = { host: this.host, pid: process.pid, instance: this.instance, token: randomBytes(16).toString('hex') };
    for (;;) {
      signal.throwIfAborted();
      try {
        const handle = await open(file, 'wx');
        try { await handle.writeFile(JSON.stringify(me)); } finally { await handle.close(); }
        const heartbeat = setInterval(() => {
          const at = new Date(this.now());
          utimes(file, at, at).catch(() => undefined);
        }, LOCK_HEARTBEAT_MS);
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          const owner = await readLockOwner(file);
          // Only our own lock is removed; another process may have taken it over.
          if (owner?.token === me.token) await rm(file, { force: true });
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const held = await lstat(file).catch(() => null);
      if (!held) continue;
      const owner = await readLockOwner(file);
      const gone = owner?.host === this.host && owner.instance !== this.instance && (owner.pid === process.pid || !this.isAlive(owner.pid));
      if (gone || this.now() - held.mtimeMs > LOCK_STALE_MS) {
        await this.takeOver(file, owner);
        continue;
      }
      await delay(500, signal);
    }
  }

  /** Move a stale lock aside (only one process can), then remove it if it was the one judged stale. */
  private async takeOver(file: string, judged: LockOwner | null): Promise<void> {
    const aside = `${file}.${randomBytes(8).toString('hex')}.stale`;
    try {
      await rename(file, aside);
    } catch {
      return; // Someone else took it over first.
    }
    const moved = await readLockOwner(aside);
    if (judged && moved?.token !== judged.token) {
      // It was replaced between the check and the move: put it back if the place is still free.
      await link(aside, file).catch(() => undefined);
    } else {
      this.log(`[MediaCache] Took over a stale download lock (${path.basename(file).slice(0, 12)})`);
    }
    await rm(aside, { force: true }).catch(() => undefined);
  }

  /**
   * Remove what crashed or cancelled jobs left behind: old staging folders,
   * stale locks and side files, only inside the cache and only names this cache
   * creates. Published media and manifests are never removed here.
   */
  async sweep(): Promise<void> {
    await this.init();
    await this.assertLayout();
    const now = this.now();
    const staging = path.join(this.v2, 'staging');
    for (const name of await readdir(staging).catch(() => [] as string[])) {
      if (!STAGING_RE.test(name)) continue;
      const info = await lstat(path.join(staging, name)).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink() && now - info.mtimeMs > STAGING_STALE_MS) {
        await rm(path.join(staging, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const locks = path.join(this.v2, 'locks');
    for (const name of await readdir(locks).catch(() => [] as string[])) {
      const stale = LOCK_RE.test(name) || SIDE_FILE_RE.test(name);
      const info = stale ? await lstat(path.join(locks, name)).catch(() => null) : null;
      if (info?.isFile() && now - info.mtimeMs > LOCK_STALE_MS) await rm(path.join(locks, name), { force: true }).catch(() => undefined);
    }
    for (const name of await readdir(this.v2).catch(() => [] as string[])) {
      if (!SIDE_FILE_RE.test(name)) continue;
      const info = await lstat(path.join(this.v2, name)).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs > STAGING_STALE_MS) await rm(path.join(this.v2, name), { force: true }).catch(() => undefined);
    }
  }
}

async function readLockOwner(file: string): Promise<LockOwner | null> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as Partial<LockOwner>;
    return typeof data.token === 'string' && typeof data.host === 'string' && typeof data.instance === 'string' && typeof data.pid === 'number'
      ? data as LockOwner : null;
  } catch {
    return null;
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
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
