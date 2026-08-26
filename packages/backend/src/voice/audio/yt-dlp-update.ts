import { spawn } from 'child_process';

/**
 * Best-effort yt-dlp self-update (non-fatal). Runs once at startup.
 */
export function updateYtDlpInBackground(): void {
  if (process.env.YT_DLP_AUTO_UPDATE === '0' || process.env.YT_DLP_AUTO_UPDATE === 'false') {
    return;
  }

  try {
    const proc = spawn('yt-dlp', ['-U'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { out += c.toString(); });
    proc.on('close', (code) => {
      const snippet = out.trim().split('\n').slice(-3).join(' | ');
      if (code === 0) {
        console.log(`[yt-dlp] Update check finished: ${snippet || 'ok'}`);
      } else {
        console.warn(`[yt-dlp] Update check exited ${code}: ${snippet.slice(0, 200)}`);
      }
    });
    proc.on('error', (err) => {
      console.warn(`[yt-dlp] Update check failed to start: ${err.message}`);
    });
  } catch (err: any) {
    console.warn(`[yt-dlp] Update check error: ${err.message}`);
  }
}
