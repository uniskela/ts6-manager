import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadYouTube } from './youtube.js';

/** Running (not exited). An exited child that nobody has reaped yet still answers kill(pid, 0). */
function alive(pid: number): boolean {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0];
    return state !== 'Z' && state !== 'X';
  } catch {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('cancelling a download stops yt-dlp and the process it started', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ts6-abort-'));
  const previousYtDlpPath = process.env.YT_DLP_PATH;
  const pidFile = path.join(dir, 'pids');
  let pids: number[] = [];
  try {
    // A yt-dlp that starts a long-running child, as it starts ffmpeg to convert audio,
    // records both pids and never finishes.
    const executable = path.join(dir, 'yt-dlp');
    await writeFile(executable, `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);
setInterval(() => {}, 1000);
`);
    await chmod(executable, 0o755);
    process.env.YT_DLP_PATH = executable;
    const controller = new AbortController();
    const pending = downloadYouTube('https://www.youtube.com/watch?v=abcdefghijk', dir, undefined, controller.signal);
    await waitFor(async () => {
      pids = (await readFile(pidFile, 'utf8').catch(() => '')).split(' ').map(Number).filter(Boolean);
      return pids.length === 2;
    }, 'yt-dlp and its child to start');
    controller.abort(new Error('cancelled'));
    await assert.rejects(pending, /cancelled/);
    await waitFor(() => !alive(pids[0]), 'yt-dlp to stop');
    await waitFor(() => !alive(pids[1]), 'the child of yt-dlp to stop');
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    if (previousYtDlpPath === undefined) delete process.env.YT_DLP_PATH;
    else process.env.YT_DLP_PATH = previousYtDlpPath;
    await rm(dir, { recursive: true, force: true });
  }
});
