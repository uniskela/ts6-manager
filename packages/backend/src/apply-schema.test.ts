import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../../../docker-commands/apply-schema.sh', import.meta.url));

/** Processes whose command line contains `marker`, read from /proc. */
function processesWith(marker: string): number[] {
  return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker);
    } catch {
      return false;
    }
  }).map(Number);
}

// apply-schema.sh runs before `exec node dist/index.js`, which becomes PID 1 and
// does not reap processes it did not start. The Prisma CLI's update check forks a
// detached node child; when the check hangs it outlives the script and ends as a
// zombie under the backend (#466). The script must leave no such process behind.
test('apply-schema.sh leaves no Prisma update-check process behind', { skip: !fs.existsSync('/proc'), timeout: 120_000 }, async () => {
  // Accept connections and never answer, as a firewall that drops traffic does.
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => { sockets.add(socket); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/hang`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-schema-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BACKEND_DIR: backendDir,
    DATA_DIR: dataDir,
    DATABASE_URL: `file:${path.join(dataDir, 'test.db')}`,
    HOME: dataDir,
    PRISMA_TELEMETRY_ENDPOINT: endpoint,
  };
  delete env.CHECKPOINT_DISABLE;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('sh', [script], { env, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, 'apply-schema.sh failed');
    assert.deepEqual(processesWith(endpoint), [], 'a Prisma update-check process outlived apply-schema.sh');
  } finally {
    for (const pid of processesWith(endpoint)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
