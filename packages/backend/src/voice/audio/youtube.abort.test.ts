import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadYouTube } from './youtube.js';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('cancelling a download stops the yt-dlp process and rejects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ts6-abort-'));
  const previousYtDlpPath = process.env.YT_DLP_PATH;
  const pidFile = path.join(dir, 'pid');
  try {
    // A yt-dlp that records its pid and never finishes.
    const executable = path.join(dir, 'yt-dlp');
    await writeFile(executable, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    await chmod(executable, 0o755);
    process.env.YT_DLP_PATH = executable;
    const controller = new AbortController();
    const pending = downloadYouTube('https://www.youtube.com/watch?v=abcdefghijk', dir, undefined, controller.signal);
    let pid = 0;
    for (let i = 0; i < 200 && !pid; i++) {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '')) || 0;
      if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(pid > 0, 'yt-dlp started');
    controller.abort(new Error('cancelled'));
    await assert.rejects(pending);
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(alive(pid), false, 'yt-dlp was stopped');
  } finally {
    if (previousYtDlpPath === undefined) delete process.env.YT_DLP_PATH;
    else process.env.YT_DLP_PATH = previousYtDlpPath;
    await rm(dir, { recursive: true, force: true });
  }
});
