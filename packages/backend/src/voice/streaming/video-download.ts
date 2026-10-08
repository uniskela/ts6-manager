import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getCookieArgs } from '../audio/youtube.js';
import { validateUrl, parseLocalHostAllowlist } from '../../utils/url-validator.js';
import { describeDuration } from './lifecycle.js';
import { AppError } from '../../middleware/error-handler.js';

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

/**
 * yt-dlp format selection for a YouTube video stream, preferring formats no
 * taller than `maxHeight`. The unrestricted `bv*+ba` and `b` at the end are
 * a deliberate last resort so a stream still starts when no format matches
 * the limit (for example formats without height metadata): `bv*+ba` covers
 * separate video and audio formats, which a bare `b` never merges, and `b`
 * covers a single combined format. The sidecar scales the picture to the preset.
 *
 * SDR is preferred because HDR sources come out washed out once encoded for
 * TeamSpeak. Among formats of equal resolution and frame rate, VP9 is sorted
 * ahead of AV1: yt-dlp ranks AV1 first, and AV1 decodes far slower, so a
 * high-resolution AV1 source can fall below real time (stutter). Resolution
 * and frame rate still sort first, so this never lowers quality; AV1 is still
 * used where it is the only format at the best resolution. Based on testing
 * by @KorppuJauho in his fork.
 */
export const YOUTUBE_VIDEO_FORMAT_SORT = 'res,fps,vcodec:vp9';

export function youtubeVideoFormatArgs(maxHeight: number): string[] {
  const filter =
    `bv*[height<=${maxHeight}][dynamic_range=SDR]+ba` +
    `/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/bv*+ba/b`;
  return ['-f', filter, '-S', YOUTUBE_VIDEO_FORMAT_SORT];
}

/**
 * A source the server will not stream as configured (over the download length
 * limit, or a live broadcast that cannot be downloaded). The message tells the
 * user what to change, so it answers 422 with that message instead of the
 * generic 500 a plain Error would become.
 */
export class VideoSourceRefusedError extends AppError {
  constructor(message: string) {
    super(422, message, undefined, { reason: 'source_refused' });
    this.name = 'VideoSourceRefusedError';
  }
}

/**
 * yt-dlp could not get the video (it failed, timed out, or returned nothing
 * playable). The source's fault rather than ours, so 502 with the reason.
 */
export class VideoSourceFailedError extends AppError {
  constructor(message: string) {
    const timeout = /timed out/i.test(message);
    super(timeout ? 504 : 502, message, undefined, {
      reason: timeout ? 'source_timeout' : 'source_unavailable',
      retryable: timeout,
    });
    this.name = 'VideoSourceFailedError';
  }
}

/**
 * Bounds one yt-dlp resolve. Below the web UI's 120s stream-start timeout, so
 * a slow resolve comes back as a readable error instead of a client timeout.
 */
const RESOLVE_TIMEOUT_MS = 90_000;

/**
 * The user-facing reason from yt-dlp's stderr: its last "ERROR:" line (e.g.
 * "Sign in to confirm you're not a bot"), without the extractor prefix, file
 * paths or the rest of the output, which stays in the server log. Null when
 * there is no such line. Exported for unit tests.
 */
export function ytDlpErrorReason(stderr: string): string | null {
  const lines = stderr.split('\n').filter((line) => line.startsWith('ERROR:'));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const reason = last
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[^:\s]*:\s*/, '')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/][^\s'"]*/g, '<path>')
    .trim();
  return reason ? reason.slice(0, 200) : null;
}

/** A short failure message for the client; the full stderr goes to the log. */
function ytDlpFailure(what: string, code: number | null, stderr: string): VideoSourceFailedError {
  console.warn(`[VideoDownload] ${what} (code ${code}): ${stderr.slice(0, 2000)}`);
  const reason = ytDlpErrorReason(stderr);
  return new VideoSourceFailedError(reason ? `${what}: ${reason}` : what);
}

/** ENOENT → missing binary; anything else → generic start failure. */
function ytDlpSpawnFailureMessage(err: NodeJS.ErrnoException): string {
  return err.code === 'ENOENT'
    ? `yt-dlp not found: ${err.message}`
    : `yt-dlp failed to start: ${err.message}`;
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
  /**
   * A second remote input carrying the audio, when the source delivers video
   * and audio separately (YouTube above 720p). `path` is then video only.
   */
  audioPath?: string;
  /** The chosen format's picture size when the extractor reports it, so Auto quality needs no probe. */
  resolution?: { width: number; height: number };
}

/**
 * Parse yt-dlp `--dump-single-json` output for a Twitch page into a playable
 * ffmpeg source. Exported for unit tests (no yt-dlp / network).
 */
export function parseTwitchResolve(data: Record<string, unknown>): DownloadedStreamVideo {
  const streamUrl = typeof data.url === 'string' ? data.url.trim() : '';
  if (!streamUrl.startsWith('http://') && !streamUrl.startsWith('https://')) {
    throw new VideoSourceFailedError('yt-dlp did not return a playable Twitch stream URL');
  }

  const isLive = data.is_live === true || data.live_status === 'is_live';
  const rawDuration = typeof data.duration === 'number' ? data.duration : NaN;
  const durationSec =
    !isLive && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;

  return { path: streamUrl, durationSec, live: isLive };
}

/**
 * Ask yt-dlp for a page's media URLs and metadata without downloading
 * (`--dump-single-json`). `site` only names the source in error messages.
 */
async function resolveWithYtDlp(
  url: string,
  formatArgs: string[],
  site: string,
): Promise<Record<string, unknown>> {
  const { stdout, stderr, code } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    const args = [
      ...getCookieArgs(),
      ...formatArgs,
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
      reject(new VideoSourceFailedError(`${site} URL resolve timed out after ${RESOLVE_TIMEOUT_MS / 1000}s`));
    }, RESOLVE_TIMEOUT_MS);
    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, code: exitCode });
    });
    proc.on('error', (spawnErr: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(ytDlpSpawnFailureMessage(spawnErr)));
    });
  });

  if (code !== 0) {
    throw ytDlpFailure(`yt-dlp could not resolve the ${site} URL`, code, stderr);
  }

  try {
    const jsonLine =
      stdout.trim().split('\n').find((line) => line.startsWith('{')) || stdout.trim();
    return JSON.parse(jsonLine);
  } catch {
    throw new VideoSourceFailedError(`Failed to parse yt-dlp ${site} metadata`);
  }
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

  const data = await resolveWithYtDlp(url, ['-f', formatFilter], 'Twitch');

  const resolved = parseTwitchResolve(data);
  // Page URL was validated in downloadVideoForStream; the extractor media URL
  // is a second hop. Re-check it (no LAN allowlist — Twitch CDNs are public)
  // so SIDECAR_EGRESS_PROXY=off cannot fetch private/metadata addresses.
  const mediaCheck = await validateUrl(resolved.path, {
    allowedProtocols: ['http:', 'https:'],
  });
  if (!mediaCheck.valid) {
    throw new Error(`Twitch media URL blocked: ${mediaCheck.error}`);
  }
  // Keep the same duration ceiling YouTube downloads used to enforce for Twitch VODs.
  if (
    !resolved.live &&
    maxDurationSec > 0 &&
    resolved.durationSec != null &&
    resolved.durationSec > maxDurationSec
  ) {
    throw new VideoSourceRefusedError(
      `Twitch VOD is longer than the ${maxDurationSec}s limit (${Math.round(resolved.durationSec)}s)`,
    );
  }

  console.log(
    `[VideoDownload] Resolved Twitch ${resolved.live ? 'live' : 'VOD'} URL for ffmpeg` +
      (resolved.durationSec != null ? ` (${resolved.durationSec}s)` : ''),
  );
  return resolved;
}

function mediaUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  return url.startsWith('http://') || url.startsWith('https://') ? url : '';
}

function pictureSize(format: Record<string, unknown>): { width: number; height: number } | undefined {
  const width = Number(format.width);
  const height = Number(format.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

/**
 * Parse yt-dlp `--dump-single-json` output for a YouTube page into a source
 * ffmpeg can read directly. Exported for unit tests (no yt-dlp / network).
 *
 * Above 720p YouTube delivers video and audio as separate streams, which
 * yt-dlp lists under `requested_formats`; those become `path` (video) and
 * `audioPath`. A live broadcast can come the same way, as two HLS playlists.
 * A combined format has a single top-level `url`.
 */
export function parseYoutubeResolve(data: Record<string, unknown>): DownloadedStreamVideo {
  const isLive = data.is_live === true || data.live_status === 'is_live';
  const rawDuration = typeof data.duration === 'number' ? data.duration : NaN;
  const durationSec =
    !isLive && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;

  const formats = Array.isArray(data.requested_formats)
    ? (data.requested_formats as Array<Record<string, unknown>>)
    : [];
  const video = formats.find((f) => f.vcodec !== 'none' && mediaUrl(f.url));
  const audio = formats.find((f) => f !== video && f.acodec !== 'none' && mediaUrl(f.url));
  if (video && audio) {
    return {
      path: mediaUrl(video.url),
      audioPath: mediaUrl(audio.url),
      durationSec,
      live: isLive,
      resolution: pictureSize(video) ?? pictureSize(data),
    };
  }

  const combined = mediaUrl(data.url);
  if (!combined) {
    throw new VideoSourceFailedError('yt-dlp did not return a playable YouTube stream URL');
  }
  return { path: combined, durationSec, live: isLive, resolution: pictureSize(data) };
}

/**
 * Resolve a YouTube page URL to media URLs ffmpeg reads directly, without
 * downloading: the video starts at once whatever its length, and a live
 * broadcast can be streamed at all. Off by default (Settings → YouTube),
 * because YouTube refuses these URLs from some networks; the download path
 * exists for that. "Max video duration" is not applied: nothing is stored.
 */
async function resolveYoutubeStreamUrl(url: string, maxHeight: number): Promise<DownloadedStreamVideo> {
  const data = await resolveWithYtDlp(url, youtubeVideoFormatArgs(maxHeight), 'YouTube');
  const resolved = parseYoutubeResolve(data);
  // Second hop, as for Twitch: the media URLs are checked again (no LAN
  // allowlist; YouTube's CDN is public).
  for (const media of [resolved.path, resolved.audioPath]) {
    if (!media) continue;
    const check = await validateUrl(media, { allowedProtocols: ['http:', 'https:'] });
    if (!check.valid) {
      throw new Error(`YouTube media URL blocked: ${check.error}`);
    }
  }
  console.log(
    `[VideoDownload] Resolved YouTube ${resolved.live ? 'live' : 'VOD'} for direct streaming` +
      (resolved.audioPath ? ' (separate video and audio)' : '') +
      (resolved.resolution ? `, ${resolved.resolution.width}x${resolved.resolution.height}` : '') +
      (resolved.durationSec != null ? `, ${Math.round(resolved.durationSec)}s` : ''),
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
 * The reason yt-dlp downloaded nothing, when --match-filter rejected the
 * video. yt-dlp still exits 0 then: it prints
 * "<title> does not pass filter (duration <= 900), skipping .." and writes no
 * file, which used to surface as a missing temp file. A source without a
 * duration (a live stream) fails the same filter. Null when the output says
 * nothing of the kind.
 */
export function durationFilterSkipMessage(ytDlpStdout: string, maxDurationSec: number): string | null {
  if (!/does not pass filter \(duration [<>]=/.test(ytDlpStdout)) return null;
  if (maxDurationSec > 0) {
    return (
      `Video is longer than the ${describeDuration(maxDurationSec)} limit, or is a live broadcast. ` +
      'Under Settings → YouTube, turn on "Stream YouTube videos directly" (no length limit, live broadcasts work) ' +
      'or raise "Max video duration" (0 = unlimited).'
    );
  }
  return (
    'Video has no known length (a live broadcast?), so it cannot be downloaded for streaming. ' +
    'Turn on "Stream YouTube videos directly" under Settings → YouTube to stream it.'
  );
}

/**
 * Prepare a video source for the sidecar.
 *
 * - YouTube: download via yt-dlp to a temp file under MUSIC_DIR (avoids
 *   datacenter-IP 403 on googlevideo URLs), then stream from disk. With
 *   `youtubeDirect`, resolve direct media URLs instead (no temp file, no
 *   length limit, live broadcasts work).
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
  options: { localHosts?: string[]; youtubeDirect?: boolean } = {},
): Promise<DownloadedStreamVideo> {
  rejectYtDlpOptionUrl(url);

  const isRemote =
    url.startsWith('http://') ||
    url.startsWith('https://');

  if (!isRemote) {
    return { path: resolvePathUnderMusicDir(url), durationSec: null };
  }

  const localAllowlist = options.localHosts?.length
    ? parseLocalHostAllowlist(options.localHosts).allowlist
    : undefined;
  const check = await validateUrl(url, { allowedProtocols: ['http:', 'https:'], localAllowlist });
  if (!check.valid) {
    throw new Error(`Video source blocked: ${check.error}`);
  }

  if (isTwitchStreamHost(url)) {
    return resolveTwitchStreamUrl(url, maxHeight, maxDurationSec);
  }

  if (!isYoutubeStreamHost(url)) {
    // Redirects and HLS segment URLs are checked by the sidecar's egress
    // proxy, with the same localHosts allowance (see docs/public/video-streaming.md).
    return { path: url, durationSec: null };
  }

  if (options.youtubeDirect) {
    return resolveYoutubeStreamUrl(url, maxHeight);
  }

  const musicRoot = ensureMusicDir();
  // Name is fully server-controlled; join to trusted root only.
  const tempName = `.stream-${Date.now()}.mp4`;
  const tempPath = path.join(musicRoot, tempName);

  await new Promise<void>((resolve, reject) => {
    const args = [
      ...getCookieArgs(),
      ...youtubeVideoFormatArgs(maxHeight),
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
    let stdout = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new VideoSourceFailedError('Video download timed out after 10 minutes'));
    }, 10 * 60_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(ytDlpFailure('yt-dlp could not download the video', code, stderr));
        return;
      }
      const skipped = durationFilterSkipMessage(stdout, maxDurationSec);
      if (skipped) {
        reject(new VideoSourceRefusedError(skipped));
        return;
      }
      resolve();
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(ytDlpSpawnFailureMessage(err)));
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
      throw new VideoSourceFailedError(
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
