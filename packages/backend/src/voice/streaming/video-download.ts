import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getCookieArgs } from '../audio/youtube.js';
import { validateUrl } from '../../utils/url-validator.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

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

/** Resolve a local path and require it to live under MUSIC_DIR (symlink-safe). */
export function resolvePathUnderMusicDir(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error('Local video file not found');
  }
  const canonicalMusicRoot = ensureMusicDir();
  const canonicalResolved = fs.realpathSync(resolved);
  if (
    !canonicalResolved.startsWith(canonicalMusicRoot + path.sep) &&
    canonicalResolved !== canonicalMusicRoot
  ) {
    throw new Error('Local video path must be under MUSIC_DIR');
  }
  return canonicalResolved;
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
  const tempPath = path.join(musicRoot, `.stream-${Date.now()}.mp4`);

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

  if (!fs.existsSync(tempPath)) {
    throw new Error('yt-dlp completed but the output file was not found');
  }

  const canonicalTemp = resolvePathUnderMusicDir(tempPath);
  console.log(`[VideoDownload] Downloaded: ${canonicalTemp} (${fs.statSync(canonicalTemp).size} bytes)`);
  return canonicalTemp;
}

/** Safely unlink a `.stream-*.mp4` temp file if it resolves under MUSIC_DIR. */
export function safeUnlinkStreamTemp(filePath: string): void {
  try {
    const canonical = resolvePathUnderMusicDir(filePath);
    const base = path.basename(canonical);
    if (!base.startsWith('.stream-') || !base.endsWith('.mp4')) return;
    fs.unlinkSync(canonical);
  } catch {
    /* ignore missing/invalid paths */
  }
}

/** Remove orphaned .stream-*.mp4 temp files from prior runs. */
export function sweepStreamTempFiles(): void {
  try {
    const musicRoot = ensureMusicDir();
    for (const name of fs.readdirSync(musicRoot)) {
      if (name.startsWith('.stream-') && name.endsWith('.mp4')) {
        try {
          safeUnlinkStreamTemp(path.join(musicRoot, name));
          console.log(`[VideoDownload] Swept orphan stream file: ${name}`);
        } catch { /* ignore */ }
      }
    }
  } catch (err: any) {
    console.warn(`[VideoDownload] Sweep failed: ${err.message}`);
  }
}
