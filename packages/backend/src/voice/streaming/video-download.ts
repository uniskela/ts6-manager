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
    const resolved = path.resolve(url);
    const musicRoot = path.resolve(MUSIC_DIR);
    if (!resolved.startsWith(musicRoot + path.sep) && resolved !== musicRoot) {
      throw new Error('Local video path must be under MUSIC_DIR');
    }
    if (!fs.existsSync(resolved)) {
      throw new Error('Local video file not found');
    }
    return resolved;
  }

  const check = await validateUrl(url, { allowedProtocols: ['http:', 'https:'] });
  if (!check.valid) {
    throw new Error(`Video source blocked: ${check.error}`);
  }

  if (
    !url.includes('youtube.com/') &&
    !url.includes('youtu.be/') &&
    !url.includes('twitch.tv/')
  ) {
    return url;
  }

  const formatFilter = `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`;
  const tempPath = path.join(MUSIC_DIR, `.stream-${Date.now()}.mp4`);

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

  console.log(`[VideoDownload] Downloaded: ${tempPath} (${fs.statSync(tempPath).size} bytes)`);
  return tempPath;
}

/** Remove orphaned .stream-*.mp4 temp files from prior runs. */
export function sweepStreamTempFiles(): void {
  try {
    if (!fs.existsSync(MUSIC_DIR)) return;
    for (const name of fs.readdirSync(MUSIC_DIR)) {
      if (name.startsWith('.stream-') && name.endsWith('.mp4')) {
        try {
          fs.unlinkSync(path.join(MUSIC_DIR, name));
          console.log(`[VideoDownload] Swept orphan stream file: ${name}`);
        } catch { /* ignore */ }
      }
    }
  } catch (err: any) {
    console.warn(`[VideoDownload] Sweep failed: ${err.message}`);
  }
}
