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
  | 'outside-music-folder';

export interface SongFileCheck {
  /** The removed song's file path. */
  filePath: string;
  musicDir: string;
  /** File paths of every other song, on any server. */
  otherSongPaths: () => Promise<string[]>;
  /** File paths a bot has playing or queued. */
  queuedPaths?: () => string[];
}

/** A file's identity: the same file under any spelling, link or letter case. */
type Identity = string;

async function identityOf(file: string): Promise<Identity | null> {
  if (!file.trim()) return null;
  const info = await stat(file, { bigint: true }).catch(() => null);
  return info ? `${info.dev}:${info.ino}` : null;
}

/**
 * True when one of the folders above `file` (after resolving links) is the
 * folder `dir`, compared by identity, so a link or a different letter case in
 * the path cannot hide where the file really is.
 */
async function under(file: string, dir: string): Promise<boolean> {
  const target = await identityOf(dir);
  if (!target) return false;
  const real = await realpath(file).catch(() => null);
  if (!real) return false;
  let current = path.dirname(real);
  for (;;) {
    if ((await identityOf(current)) === target) return true; // NOSONAR: walks up one folder at a time
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** One lock for everything that adds library songs for existing files, or deletes them. */
let libraryFiles: Promise<unknown> = Promise.resolve();

/**
 * Run `task` alone with respect to other library file changes: a scan cannot
 * adopt a file between a removal's last reference check and its deletion.
 */
export function withLibraryFileLock<T>(task: () => Promise<T>): Promise<T> {
  const run = libraryFiles.then(task, task);
  libraryFiles = run.catch(() => undefined);
  return run;
}

/**
 * After a song row was deleted, delete its file only when nothing else uses it.
 * Runs under the library file lock.
 *
 * - Files in the download cache (`.ts6-media-cache`) are never deleted here:
 *   other songs and requests can share them, and the cache manages them.
 * - Only plain files inside the music folder are ever deleted.
 * - A file another song row still names (on any server, under any path,
 *   link or letter case), or that a bot has queued or playing, is kept.
 */
export function removeSongFileIfUnused(check: SongFileCheck): Promise<SongFileOutcome> {
  return withLibraryFileLock(async () => {
    if (!check.filePath.trim()) return 'missing';
    const given = path.resolve(check.filePath);
    const info = await lstat(given).catch(() => null);
    if (!info) return 'missing';
    const target = await identityOf(given);
    if (!target) return 'missing';
    const musicDir = path.resolve(check.musicDir);
    if (await under(given, path.join(musicDir, CACHE_DIR_NAME))) return 'cache';
    // Only a plain file (or a link to one) whose real location is inside the music folder.
    if (!(info.isFile() || info.isSymbolicLink()) || !(await under(given, musicDir))) return 'outside-music-folder';
    if (!(await stat(given)).isFile()) return 'outside-music-folder';

    for (const other of new Set(await check.otherSongPaths())) {
      if ((await identityOf(path.resolve(other))) === target) return 'shared'; // NOSONAR: one row after another
    }
    for (const queued of new Set(check.queuedPaths?.() ?? [])) {
      if ((await identityOf(path.resolve(queued))) === target) return 'in-use'; // NOSONAR: one item after another
    }

    await rm(given, { force: true });
    return 'removed';
  });
}
