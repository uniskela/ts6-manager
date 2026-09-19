import { spawn } from 'child_process';

/**
 * Best-effort yt-dlp version diagnostic (non-fatal).
 *
 * Production images are immutable: runtime startup must never self-update
 * bundled tools. Pull or rebuild the image to receive a newer yt-dlp.
 */
export function logYtDlpVersionInBackground(): void {
  try {
    const proc = spawn('yt-dlp', ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';

    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });

    proc.on('close', (code) => {
      const snippet = out.trim().split('\n').slice(-3).join(' | ');
      if (code === 0) {
        console.log(`[yt-dlp] Bundled version: ${snippet || 'unknown'}`);
      } else {
        console.warn(`[yt-dlp] Version check exited ${code}: ${snippet.slice(0, 200)}`);
      }
    });

    proc.on('error', (err) => {
      console.warn(`[yt-dlp] Version check failed to start: ${err.message}`);
    });
  } catch (err: any) {
    console.warn(`[yt-dlp] Version check error: ${err.message}`);
  }
}
