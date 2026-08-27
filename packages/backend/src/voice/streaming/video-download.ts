import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getCookieArgs } from '../audio/youtube.js';
import { validateUrl } from '../../utils/url-validator.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

/** Temp files we create: `.stream-<digits>.mp4` */
const STREAM_TEMP_NAME = /^\.stream-\d+\.mp4$/;

/** Plain filenames under MUSIC_DIR (no separators / traversal). */
const SAFE_LOCAL_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function rejectYtDlpOptionUrl(url: string): void {
  if (url.trim().startsWith('-')) {
    throw new Error("Invalid URL: must not start with '-'");
  }
}

function ensureMusicDir(): string {
  const musicRoot = path.resolve(MUSIC_DIR);
  if (!fs.existsSync(musicRoot)) {
    fs.mkdirSync(musicRoot, { recursive: true });
  }
  return fs.realpathSync(musicRoot);
}

/**
 * Map a user-supplied local reference to a path under MUSIC_DIR.
 * Only basenames (or MUSIC_DIR/basename) are accepted — never raw absolute paths.
 * The returned path is always `path.join(musicRoot, basename)` so FS ops are not
 * driven by uncontrolled path expressions (CodeQL path-injection).
 */
export function resolvePathUnderMusicDir(filePath: string): string {
  const musicRoot = ensureMusicDir();
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error('Invalid local video path');
  }

  // Allow either a bare basename or an absolute/relative path whose basename is used.
  // Reject anything whose basename fails the allowlist (blocks `..`, dirs, odd chars).
  const base = path.basename(trimmed);
  if (!SAFE_LOCAL_BASENAME.test(base) && !STREAM_TEMP_NAME.test(base)) {
    throw new Error('Local video path must be a filename under MUSIC_DIR');
  }

  // If the caller passed a path with directories, require it to resolve under MUSIC_DIR
  // before we discard the directory part — prevents surprising basename-only fallback.
  if (trimmed !== base) {
    const absolute = path.resolve(trimmed);
    const relative = path.relative(musicRoot, absolute);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).some((p) => p === '..')
    ) {
      throw new Error('Local video path must be under MUSIC_DIR');
    }
    if (path.basename(absolute) !== base) {
      throw new Error('Local video path must be under MUSIC_DIR');
    }
  }

  // Reconstruct exclusively from trusted root + allowlisted basename.
  const safePath = path.join(musicRoot, base);
  if (!fs.existsSync(safePath)) {
    throw new Error('Local video file not found');
  }

  // Symlink escape: realpath must still land under MUSIC_DIR; return join(root, base)
  // of the real basename only if it remains allowlisted.
  const realFile = fs.realpathSync(safePath);
  const realRel = path.relative(musicRoot, realFile);
  if (
    realRel.startsWith('..') ||
    path.isAbsolute(realRel) ||
    realRel.split(path.sep).length !== 1
  ) {
    throw new Error('Local video path must be under MUSIC_DIR');
  }
  const realBase = path.basename(realFile);
  if (!SAFE_LOCAL_BASENAME.test(realBase) && !STREAM_TEMP_NAME.test(realBase)) {
    throw new Error('Local video path must be under MUSIC_DIR');
  }
  return path.join(musicRoot, realBase);
}

function isYtDlpStreamHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtu.be' ||
    hostname === 'twitch.tv' ||
    hostname.endsWith('.twitch.tv')
  );
}

/**
 * Download on-demand video via proxied yt-dlp to a temp file under MUSIC_DIR,
 * then stream from disk (avoids datacenter-IP YouTube 403 on googlevideo URLs).
 * Adapted from uniplayer1/ts6-manager.
 */
export async function downloadVideoForStream(
  url: string,
  maxHeight: number = 720,
  maxDurationSec: number = 900,
): Promise<string> {
  rejectYtDlpOptionUrl(url);

  const isRemote =
    url.startsWith('http://') ||
    url.startsWith('https://');

  if (!isRemote) {
    return resolvePathUnderMusicDir(url);
  }

  const check = await validateUrl(url, { allowedProtocols: ['http:', 'https:'] });
  if (!check.valid) {
    throw new Error(`Video source blocked: ${check.error}`);
  }

  if (!isYtDlpStreamHost(url)) {
    return url;
  }

  const musicRoot = ensureMusicDir();
  const formatFilter = `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`;
  // Name is fully server-controlled; join to trusted root only.
  const tempName = `.stream-${Date.now()}.mp4`;
  const tempPath = path.join(musicRoot, tempName);

  await new Promise<void>((resolve, reject) => {
    const args = [
      ...getCookieArgs(),
      '-f', formatFilter,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-progress',
      '-o', tempPath,
      '--match-filter', maxDurationSec > 0 ? `duration <= ${maxDurationSec}` : 'duration >= 0',
      '--',
      url,
    ];

    const proc = spawn('yt-dlp', args, { shell: false });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Video download timed out after 10 minutes'));
    }, 10 * 60_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(0, 280)}`));
        return;
      }
      resolve();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });

  // Re-resolve via allowlisted basename (tempName is server-generated).
  const canonicalTemp = resolvePathUnderMusicDir(tempName);
  console.log(`[VideoDownload] Downloaded: ${canonicalTemp} (${fs.statSync(canonicalTemp).size} bytes)`);
  return canonicalTemp;
}

/**
 * Unlink a `.stream-*.mp4` temp file.
 * Path for unlink is always `join(MUSIC_DIR, allowlistedBasename)` — never the raw input.
 */
export function safeUnlinkStreamTemp(filePath: string): void {
  try {
    const musicRoot = ensureMusicDir();
    const base = path.basename(filePath.trim());
    if (!STREAM_TEMP_NAME.test(base)) return;
    const safePath = path.join(musicRoot, base);
    fs.unlinkSync(safePath);
  } catch {
    /* ignore missing/invalid paths */
  }
}

/** Remove orphaned .stream-*.mp4 temp files from prior runs. */
export function sweepStreamTempFiles(): void {
  try {
    const musicRoot = ensureMusicDir();
    for (const name of fs.readdirSync(musicRoot)) {
      if (!STREAM_TEMP_NAME.test(name)) continue;
      try {
        // name comes from readdir of trusted root; still unlink via join + allowlist.
        const safePath = path.join(musicRoot, name);
        fs.unlinkSync(safePath);
        console.log(`[VideoDownload] Swept orphan stream file: ${name}`);
      } catch { /* ignore */ }
    }
  } catch (err: any) {
    console.warn(`[VideoDownload] Sweep failed: ${err.message}`);
  }
}
