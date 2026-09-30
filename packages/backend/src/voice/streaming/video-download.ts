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

/** Shared message when a MUSIC_DIR path does not exist (also matched by callers). */
export const LOCAL_VIDEO_NOT_FOUND = 'Local video file not found';

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
    throw new Error(LOCAL_VIDEO_NOT_FOUND);
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

/** Hostname classification for stream URL handling (exported for unit tests). */
export function classifyStreamHost(url: string): 'youtube' | 'twitch' | 'other' {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtu.be'
  ) {
    return 'youtube';
  }
  if (hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv')) {
    return 'twitch';
  }
  return 'other';
}

function isYoutubeStreamHost(url: string): boolean {
  return classifyStreamHost(url) === 'youtube';
}

function isTwitchStreamHost(url: string): boolean {
  return classifyStreamHost(url) === 'twitch';
}

export interface DownloadedStreamVideo {
  path: string;
  /** Set for freshly downloaded temps — used to auto-stop when the clip ends. */
  durationSec: number | null;
  /**
   * When known from the extractor (Twitch), whether the source is live.
   * Used as a probe fallback for fixed quality presets that skip ffprobe.
   */
  live?: boolean;
}

/**
 * Parse yt-dlp `--dump-single-json` output for a Twitch page into a playable
 * ffmpeg source. Exported for unit tests (no yt-dlp / network).
 */
export function parseTwitchResolve(data: Record<string, unknown>): DownloadedStreamVideo {
  const streamUrl = typeof data.url === 'string' ? data.url.trim() : '';
  if (!streamUrl.startsWith('http://') && !streamUrl.startsWith('https://')) {
    throw new Error('yt-dlp did not return a playable Twitch stream URL');
  }

  const isLive = data.is_live === true || data.live_status === 'is_live';
  const rawDuration = typeof data.duration === 'number' ? data.duration : NaN;
  const durationSec =
    !isLive && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;

  return { path: streamUrl, durationSec, live: isLive };
}

/**
 * Resolve a Twitch (live or VOD) page URL to a direct media URL for ffmpeg.
 * Live Twitch cannot be downloaded to a fixed `.stream-*.mp4` the way YouTube
 * VODs are — yt-dlp either never finishes or exits without creating the file,
 * which previously surfaced as "Local video file not found" (#203).
 */
async function resolveTwitchStreamUrl(
  url: string,
  maxHeight: number,
  maxDurationSec: number,
): Promise<DownloadedStreamVideo> {
  // Prefer a single muxed stream so ffmpeg gets one `-i` URL (Twitch often
  // exposes HLS playlists that already include audio).
  const formatFilter = `best[height<=${maxHeight}]/best`;

  const { stdout, stderr, code } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    const args = [
      ...getCookieArgs(),
      '-f', formatFilter,
      '--dump-single-json',
      '--no-download',
      '--no-playlist',
      '--no-warnings',
      '--',
      url,
    ];
    const proc = spawn('yt-dlp', args, { shell: false });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Twitch URL resolve timed out after 2 minutes'));
    }, 2 * 60_000);
    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, code: exitCode });
    });
    proc.on('error', (spawnErr) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp not found: ${spawnErr.message}`));
    });
  });

  if (code !== 0) {
    throw new Error(`yt-dlp failed to resolve Twitch URL (code ${code}): ${stderr.slice(0, 280)}`);
  }

  let data: Record<string, unknown>;
  try {
    const jsonLine =
      stdout.trim().split('\n').find((line) => line.startsWith('{')) || stdout.trim();
    data = JSON.parse(jsonLine);
  } catch {
    throw new Error('Failed to parse yt-dlp Twitch metadata');
  }

  const resolved = parseTwitchResolve(data);
  // Keep the same duration ceiling YouTube downloads used to enforce for Twitch VODs.
  if (
    !resolved.live &&
    maxDurationSec > 0 &&
    resolved.durationSec != null &&
    resolved.durationSec > maxDurationSec
  ) {
    throw new Error(
      `Twitch VOD is longer than the ${maxDurationSec}s limit (${Math.round(resolved.durationSec)}s)`,
    );
  }

  console.log(
    `[VideoDownload] Resolved Twitch ${resolved.live ? 'live' : 'VOD'} URL for ffmpeg` +
      (resolved.durationSec != null ? ` (${resolved.durationSec}s)` : ''),
  );
  return resolved;
}

/** Probe a local media file's duration in seconds, or null if unknown. */
function probeVideoDurationSec(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { shell: false });

    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on('close', (code) => {
      const seconds = code === 0 ? parseFloat(stdout.trim()) : NaN;
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * Prepare a video source for the sidecar.
 *
 * - YouTube: download via yt-dlp to a temp file under MUSIC_DIR (avoids
 *   datacenter-IP 403 on googlevideo URLs), then stream from disk.
 * - Twitch: resolve a direct media URL with yt-dlp (live-safe; no temp file).
 * - Other http(s): pass through for ffmpeg.
 * - Bare filenames: resolve under MUSIC_DIR.
 *
 * Adapted from uniplayer1/ts6-manager; duration probe inspired by DomeNinchen/ts6forkmanager.
 */
export async function downloadVideoForStream(
  url: string,
  maxHeight: number = 720,
  maxDurationSec: number = 900,
): Promise<DownloadedStreamVideo> {
  rejectYtDlpOptionUrl(url);

  const isRemote =
    url.startsWith('http://') ||
    url.startsWith('https://');

  if (!isRemote) {
    return { path: resolvePathUnderMusicDir(url), durationSec: null };
  }

  const check = await validateUrl(url, { allowedProtocols: ['http:', 'https:'] });
  if (!check.valid) {
    throw new Error(`Video source blocked: ${check.error}`);
  }

  if (isTwitchStreamHost(url)) {
    return resolveTwitchStreamUrl(url, maxHeight, maxDurationSec);
  }

  if (!isYoutubeStreamHost(url)) {
    return { path: url, durationSec: null };
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
  // Missing output after a "successful" exit used to throw the same
  // "Local video file not found" as a bad local filename — clarify it.
  try {
    const canonicalTemp = resolvePathUnderMusicDir(tempName);
    const durationSec = await probeVideoDurationSec(canonicalTemp);
    console.log(
      `[VideoDownload] Downloaded: ${canonicalTemp} (${fs.statSync(canonicalTemp).size} bytes, ${durationSec ?? 'unknown'}s)`,
    );
    return { path: canonicalTemp, durationSec };
  } catch (err: any) {
    if (err?.message === LOCAL_VIDEO_NOT_FOUND) {
      throw new Error(
        'yt-dlp finished but the stream temp file was missing — the source may be live or unsupported for download',
      );
    }
    throw err;
  }
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
