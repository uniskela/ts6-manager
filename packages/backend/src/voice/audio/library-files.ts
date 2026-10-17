import { lstat, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR_NAME } from './media-cache.js';

/** What happened to a removed song's file. */
export type SongFileOutcome =
  /** No other song or bot used it; it was deleted. */
  | 'removed'
  /** It did not exist, or the song had no file. */
  | 'missing'
  /** Another song (on any server) still uses it. */
  | 'shared'
  /** A bot has it queued or playing. */
  | 'in-use'
  /** It belongs to the download cache, which manages its own files. */
  | 'cache'
  /** It is outside the music folder, or not a plain file; the library never deletes such files. */
  | 'outside-music-folder'
  /** Its identity could not be established reliably; it is kept. */
  | 'unverifiable';

export interface SongFileCheck {
  /** The removed song's file path. */
  filePath: string;
  musicDir: string;
  /** File paths of every other song, on any server. */
  otherSongPaths: () => Promise<string[]>;
  /** File paths a bot has playing or queued. */
  queuedPaths?: () => string[];
  /** Told which file could not be identified, when the outcome is 'unverifiable'. */
  onUnverifiable?: (file: string, reason: string) => void;
}

/** A file whose identity cannot be told reliably: anything about it is unknown, so it is kept. */
class UnknownIdentity extends Error {
  constructor(readonly file: string, readonly reason: string) { super(`${reason}: ${file}`); }
}

/** Lookup errors that mean the path names no file at all. */
const NO_FILE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'EINVAL']);

/** A file's identity, the same under any spelling, link or letter case; null when it does not exist. */
async function identityOf(file: string): Promise<string | null> {
  if (!file.trim()) return null;
  try {
    const info = await stat(file, { bigint: true });
    // Some network and FUSE filesystems report no file ids.
    if (info.ino === 0n) throw new UnknownIdentity(file, 'no file id');
    return `${info.dev}:${info.ino}`;
  } catch (err) {
    if (err instanceof UnknownIdentity) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    // A path that cannot name a file (missing, a link loop, an invalid name) is not this file.
    if (NO_FILE.has(code)) return null;
    // Permission, I/O and other errors: unknown, not "not shared".
    throw new UnknownIdentity(file, code);
  }
}

/**
 * True when `dir` is `folder` or one of the folders above it, compared by
 * identity, so a link or a different letter case cannot hide where it is.
 */
async function within(folder: string, dir: string): Promise<boolean> {
  const target = await identityOf(dir);
  if (!target) return false;
  let current = folder;
  for (;;) {
    if ((await identityOf(current)) === target) return true; // NOSONAR: walks up one folder at a time
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Identities of `paths`, a few at a time; missing files are skipped. */
async function identities(paths: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(paths.filter((p) => p.trim()).map((p) => path.resolve(p)))];
  for (let i = 0; i < unique.length; i += 32) {
    const batch = await Promise.all(unique.slice(i, i + 32).map(identityOf)); // NOSONAR: bounded batches
    for (const id of batch) if (id) found.add(id);
  }
  return found;
}

/** One lock for everything that adds library songs for existing files, or deletes them. */
let libraryFiles: Promise<unknown> = Promise.resolve();

/**
 * Run `task` alone with respect to other library file changes: a scan or an
 * upload cannot adopt a file between a removal's last reference check and its
 * deletion. The lock is per backend process (one backend is supported). Never
 * call `removeSongFileIfUnused` from inside a task: it takes the lock itself.
 */
export function withLibraryFileLock<T>(task: () => Promise<T>): Promise<T> {
  pending++;
  const run = libraryFiles.then(task, task).finally(() => { pending--; });
  libraryFiles = run.catch(() => undefined);
  return run;
}

let pending = 0;

/** Tasks holding or waiting for the library file lock. */
export function libraryFileTasks(): number {
  return pending;
}

/**
 * After a song row was deleted, delete its file only when nothing else uses it.
 * Runs under the library file lock.
 *
 * - Nothing inside the download cache (`.ts6-media-cache`) is ever unlinked
 *   here: neither a cache file nor an entry that lives in the cache folder.
 * - Only plain files whose entry and target both lie in the music folder are deleted.
 * - A file another song row still names (on any server, under any path, link
 *   or letter case), or that a bot has queued or playing, is kept.
 * - Anything whose identity cannot be established reliably is kept.
 */
export function removeSongFileIfUnused(check: SongFileCheck): Promise<SongFileOutcome> {
  return withLibraryFileLock(async () => {
    try {
      return await decideAndRemove(check);
    } catch (err) {
      if (!(err instanceof UnknownIdentity)) throw err;
      check.onUnverifiable?.(err.file, err.reason);
      return 'unverifiable';
    }
  });
}

async function decideAndRemove(check: SongFileCheck): Promise<SongFileOutcome> {
  if (!check.filePath.trim()) return 'missing';
  const given = path.resolve(check.filePath);
  const entry = await lstat(given).catch(() => null);
  if (!entry) return 'missing';
  const target = await identityOf(given);
  if (!target) return 'missing';
  const musicDir = path.resolve(check.musicDir);
  const cacheDir = path.join(musicDir, CACHE_DIR_NAME);
  // Where the entry itself sits (its folder, links resolved) and where its target is.
  const entryFolder = await realpath(path.dirname(given));
  const realTarget = await realpath(given);
  if (await within(entryFolder, cacheDir) || await within(path.dirname(realTarget), cacheDir)) return 'cache';
  if (!(entry.isFile() || entry.isSymbolicLink()) || !(await stat(given)).isFile()) return 'outside-music-folder';
  if (!(await within(entryFolder, musicDir)) || !(await within(path.dirname(realTarget), musicDir))) return 'outside-music-folder';

  if ((await identities(await check.otherSongPaths())).has(target)) return 'shared';
  if ((await identities(check.queuedPaths?.() ?? [])).has(target)) return 'in-use';
  // Queued meanwhile? Playback is not under this lock; look once more right before deleting.
  if ((await identities(check.queuedPaths?.() ?? [])).has(target)) return 'in-use';

  await rm(given, { force: true });
  return 'removed';
}
