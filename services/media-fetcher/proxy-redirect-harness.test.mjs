/**
 * L-1: stopChild / waitForExit must not hang when the child already exited.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { childExited, stopChild, waitForExit } from './proxy-redirect-harness.mjs';

describe('proxy-redirect harness child lifecycle (L-1)', () => {
  it('waitForExit resolves immediately when the child already exited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    await waitForExit(child);
    assert.equal(child.exitCode, 7);
    assert.equal(childExited(child), true);
    const t0 = Date.now();
    const again = await waitForExit(child, 30_000);
    assert.ok(Date.now() - t0 < 500, 'second waitForExit must not block on a dead child');
    assert.equal(again.code, 7);
  });

  it('stopChild is a no-op wait when the process is already dead', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await waitForExit(child);
    const t0 = Date.now();
    await stopChild(child);
    assert.ok(Date.now() - t0 < 500);
  });

  it('stopChild terminates a live child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    assert.equal(childExited(child), false);
    await stopChild(child);
    assert.equal(childExited(child), true);
  });
});
