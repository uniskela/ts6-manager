import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR_NAME } from './media-cache.js';

/** What happened to a removed song's file. */
export type SongFileOutcome =
  /** No other song or bot used it; it was deleted. */
  | 'removed'
  /** It did not exist. */
  | 'missing'
  /** Another song (on any server) still uses it. */
  | 'shared'
  /** A bot has it queued or playing. */
  | 'in-use'
  /** It belongs to the download cache, which manages its own files. */
  | 'cache'
  /** It is outside the music folder; the library never deletes such files. */
  | 'outside-music-folder';

export interface SongFileCheck {
  /** The removed song's file path. */
  filePath: string;
  musicDir: string;
  /** File paths of the other songs that may name the same file (any server). */
  otherSongPaths: (basename: string) => Promise<string[]>;
  /** True when a bot has a queue item with this resolved path. */
  inUse?: (resolvedPath: string) => boolean;
}

async function realOrNull(file: string): Promise<string | null> {
  return realpath(file).catch(() => null);
}

/** True when `file` lies inside `dir` (both already resolved). */
function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function inCache(musicDir: string, file: string): boolean {
  const relative = path.relative(musicDir, file);
  return inside(musicDir, file) && relative.split(path.sep)[0] === CACHE_DIR_NAME;
}

/**
 * After a song row was deleted, delete its file only when nothing else uses it.
 *
 * - Files in the download cache (`.ts6-media-cache`) are never deleted here:
 *   other songs and requests can share them, and the cache manages them.
 * - Files outside the music folder are never deleted.
 * - A file another song row still names (on any server, however the path is
 *   spelled) is kept, and so is a file a bot has queued or playing.
 */
export async function removeSongFileIfUnused(check: SongFileCheck): Promise<SongFileOutcome> {
  const given = path.resolve(check.filePath);
  const info = await lstat(given).catch(() => null);
  if (!info) return 'missing';
  const musicDir = path.resolve(check.musicDir);
  const realMusic = (await realOrNull(musicDir)) ?? musicDir;
  const real = (await realOrNull(given)) ?? given;
  // Judged both as written and after resolving links, so a link cannot hide where the file is.
  if (inCache(musicDir, given) || inCache(realMusic, real)) return 'cache';
  if (!inside(musicDir, given) && !inside(realMusic, real)) return 'outside-music-folder';

  for (const other of await check.otherSongPaths(path.basename(given))) {
    const resolved = path.resolve(other);
    if (resolved === given || (await realOrNull(resolved)) === real) return 'shared';
  }
  if (check.inUse?.(given) || (real !== given && check.inUse?.(real))) return 'in-use';

  await rm(given, { force: true });
  return 'removed';
}
