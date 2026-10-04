/**
 * TeamSpeak 6 clients show avatars up to about 320x320 pixels and leave larger
 * server-stored avatars blank (the TS6 client resizes its own uploads; a bot's
 * upload must do the same). The web UI keeps showing the original image.
 *
 * Fitted output must also stay within TeamSpeak's avatar upload size
 * (i_client_max_avatar_filesize / MAX_AVATAR_BYTES). Resizing a large JPEG to
 * PNG can exceed that even when the original passed the route check.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MAX_AVATAR_BYTES } from '../utils/bot-avatar-storage.js';

export const TS_AVATAR_MAX_PX = 300;
const FFMPEG_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

type FitFormat = 'gif' | 'png' | 'jpeg';

/** Width and height from the image header, or null when the header is not recognised. */
export function avatarDimensions(image: Buffer): { width: number; height: number } | null {
  if (image.length >= 24 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && image.subarray(12, 16).toString('ascii') === 'IHDR') {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  }
  if (image.length >= 10 && ['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('ascii'))) {
    return { width: image.readUInt16LE(6), height: image.readUInt16LE(8) };
  }
  if (image.length >= 4 && image[0] === 0xff && image[1] === 0xd8) {
    let i = 2;
    while (i + 9 < image.length) {
      if (image[i] !== 0xff) { i++; continue; }
      const marker = image[i + 1];
      // SOF0-SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: image.readUInt16BE(i + 5), width: image.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      i += 2 + image.readUInt16BE(i + 2);
    }
  }
  return null;
}

function ffmpegArgs(format: FitFormat): string[] {
  const scale = `scale=w='min(${TS_AVATAR_MAX_PX},iw)':h='min(${TS_AVATAR_MAX_PX},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;
  if (format === 'gif') {
    // Keep GIF animation, with a palette built from the scaled frames.
    return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', `${scale},split[a][b];[a]palettegen[p];[b][p]paletteuse`, '-f', 'gif', 'pipe:1'];
  }
  if (format === 'jpeg') {
    return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', scale, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'];
  }
  return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', scale, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'];
}

function runFfmpeg(image: Buffer, format: FitFormat): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ffmpegArgs(format), { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let outBytes = 0; let stderr = ''; let overflow = false;
    const timer = setTimeout(() => proc.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return;
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) { overflow = true; proc.kill('SIGKILL'); } else out.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 500) stderr += chunk.toString(); });
    proc.on('error', (error) => { clearTimeout(timer); reject(error); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && outBytes > 0 && outBytes <= MAX_OUTPUT_BYTES) resolve(Buffer.concat(out));
      else reject(new Error(overflow ? 'ffmpeg output exceeded the size limit' : stderr.trim() || `ffmpeg exited with code ${code}`));
    });
    proc.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input; 'close' reports it.
    proc.stdin.end(image);
  });
}

/** Resize, then retry as JPEG when PNG/GIF exceeds TeamSpeak's upload-size limit. */
async function encodeFitted(image: Buffer, isGif: boolean): Promise<Buffer> {
  const first = await runFfmpeg(image, isGif ? 'gif' : 'png');
  if (first.length <= MAX_AVATAR_BYTES) return first;
  const jpeg = await runFfmpeg(image, 'jpeg');
  if (jpeg.length > MAX_AVATAR_BYTES) {
    throw new Error(`Fitted avatar is ${jpeg.length} bytes; TeamSpeak allows at most ${MAX_AVATAR_BYTES}`);
  }
  return jpeg;
}

const fitted = new Map<string, Promise<Buffer>>();

/**
 * Shrink an avatar to fit TS_AVATAR_MAX_PX square (aspect ratio kept) before it
 * is uploaded to TeamSpeak. Small or unrecognised images are returned unchanged.
 * Results are cached by content so reconnects do not re-run ffmpeg.
 */
export async function fitAvatarForTeamSpeak(image: Buffer | null): Promise<Buffer | null> {
  if (!image) return null;
  const size = avatarDimensions(image);
  if (!size || (size.width <= TS_AVATAR_MAX_PX && size.height <= TS_AVATAR_MAX_PX)) return image;
  const key = createHash('sha256').update(image).digest('hex');
  let pending = fitted.get(key);
  if (!pending) {
    const isGif = image.subarray(0, 3).toString('ascii') === 'GIF';
    pending = encodeFitted(image, isGif).catch((error: unknown) => {
      fitted.delete(key);
      const detail = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg is not installed' : error instanceof Error ? error.message : String(error);
      throw new Error(`Could not resize the avatar to ${TS_AVATAR_MAX_PX}x${TS_AVATAR_MAX_PX} for TeamSpeak: ${detail}`);
    });
    fitted.set(key, pending);
    if (fitted.size > 64) fitted.delete(fitted.keys().next().value!);
  }
  return pending;
}
