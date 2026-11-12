/** Isolated media fetcher. Unix Job API only. ffmpeg never sees tokens. */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { radioFfmpegArgs } from './ffmpeg-args.mjs';
import { landlockDisabledByEnv, parseCheckOutput } from './landlock.mjs';
import { peerPid } from './peer-pid.mjs';
import { allocateJobId, allowTlsConnect, constrainRadioPorts, parseJobId } from './policy.mjs';
import {
  abandonPending,
  continueIfClientAlive,
  createPendingJob,
} from './pending-job.mjs';
import { attachClientSocketLifecycle } from './socket-guards.mjs';
import { assertPrivateTokenMode, tokensEqual } from './token.mjs';

const sockPath = process.env.JOBS_SOCK || '/jobs/jobs.sock';
const ctlPath = process.env.PROXY_CTL || '/ctl/proxy.sock';
const ctlTokenFile = process.env.PROXY_CTL_TOKEN_FILE || '/ctl/.ctl-token';
const wrapPath = process.env.LL_WRAP_PATH || '/usr/local/bin/ll-wrap';
const maxJobs = Number(process.env.FETCHER_MAX_JOBS || 4);
const maxLine = Number(process.env.FETCHER_MAX_LINE || 8192);
const jobTimeoutMs = Number(process.env.FETCHER_JOB_MS || 12 * 60 * 60_000);
const proxyHost = process.env.PROXY_HOST || 'media-egress-proxy';
const jobs = new Map();

function readSecretFile(file, label) {
  if (!file) throw new Error(`${label} required`);
  assertPrivateTokenMode(fs.statSync(file).mode);
  const token = fs.readFileSync(file, 'utf8').replace(/\s+/g, '');
  if (token.length < 16) throw new Error(`${label} too short`);
  return token;
}

function readToken() {
  const file = process.env.MEDIA_FETCHER_TOKEN_FILE;
  const token = readSecretFile(file, 'MEDIA_FETCHER_TOKEN_FILE');
  delete process.env.MEDIA_FETCHER_TOKEN;
  delete process.env.FETCHER_TOKEN;
  return token;
}

function requireLandlock() {
  if (landlockDisabledByEnv()) {
    throw new Error('landlock required');
  }
  if (!wrapPath || !fs.existsSync(wrapPath)) {
    throw new Error('landlock wrapper missing');
  }
  const probe = spawnSync(wrapPath, ['--check'], { encoding: 'utf8', timeout: 5_000 });
  const checked = parseCheckOutput(probe.stdout, probe.status);
  if (!checked.ok) {
    throw new Error('landlock unavailable');
  }
}

let fetcherToken;
let ctlToken;
try {
  fetcherToken = readToken();
  ctlToken = readSecretFile(ctlTokenFile, 'PROXY_CTL_TOKEN_FILE');
  requireLandlock();
} catch (err) {
  process.stdout.write(`FETCHER error ${err.message}\n`);
  process.exit(1);
}

function ctl(method, path, body) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${ctlToken}` };
    if (body) headers['content-type'] = 'application/json';
    const req = http.request({
      socketPath: ctlPath,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function startShim(jobToken) {
  const auth = `Basic ${Buffer.from(`job:${jobToken}`).toString('base64')}`;
  const dests = [];
  const rejected = [];
  let allowedPid = 0;
  const pending = [];
  const server = net.createServer((client) => {
    const start = () => {
      const pid = peerPid(client);
      if (!allowedPid || pid !== allowedPid) {
        rejected.push({ pid, allowedPid });
        client.destroy();
        return;
      }
      const up = net.connect(8080, proxyHost);
      up.on('connect', () => dests.push(`${up.remoteAddress}:${up.remotePort}`));
      let buf = Buffer.alloc(0);
      let headed = false;
      client.on('data', (chunk) => {
        if (headed) { up.write(chunk); return; }
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString();
        const rest = buf.subarray(idx + 4);
        headed = true;
        up.write(`${head}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
        if (rest.length) up.write(rest);
      });
      up.on('data', (c) => { try { client.write(c); } catch { /* closed */ } });
      const die = () => { client.destroy(); up.destroy(); };
      client.on('error', die);
      up.on('error', die);
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
    };
    if (allowedPid) start();
    else pending.push(start);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        dests,
        rejected,
        allowPid(pid) {
          allowedPid = pid;
          for (const fn of pending.splice(0)) fn();
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function killTree(pid) {
  try {
    for (const p of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(p)) continue;
      try {
        const text = fs.readFileSync(`/proc/${p}/status`, 'utf8');
        if (new RegExp(`^PPid:\\s+${pid}$`, 'm').test(text)) killTree(Number(p));
      } catch { /* gone */ }
    }
    process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }
}

function startFfmpeg(url, shimPort) {
  if (landlockDisabledByEnv() || !fs.existsSync(wrapPath)) {
    throw new Error('landlock required');
  }
  const ca = process.env.MEDIA_FETCHER_CA_FILE;
  const args = radioFfmpegArgs(url, { ca });
  const env = {
    PATH: process.env.PATH,
    http_proxy: `http://127.0.0.1:${shimPort}`,
    https_proxy: `http://127.0.0.1:${shimPort}`,
    HTTP_PROXY: `http://127.0.0.1:${shimPort}`,
    HTTPS_PROXY: `http://127.0.0.1:${shimPort}`,
    SSL_CERT_FILE: ca || process.env.SSL_CERT_FILE || '/etc/ssl/certs/ca-certificates.crt',
  };
  const child = spawn(wrapPath, [String(shimPort), 'ffmpeg', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, argv: args };
}

function parse(line) {
  const msg = JSON.parse(line);
  if (!fetcherToken || !tokensEqual(String(msg.token ?? ''), fetcherToken)) {
    throw new Error('unauthorized');
  }
  return msg;
}

async function finish(job) {
  if (!job || job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  if (job.child?.pid) killTree(job.child.pid);
  try { await job.shim?.close(); } catch { /* gone */ }
  try { await ctl('POST', `/jobs/${job.id}/revoke`); } catch { /* proxy down */ }
  try { await ctl('DELETE', `/jobs/${job.id}`); } catch { /* proxy down */ }
  jobs.delete(job.id);
}

async function handle(socket) {
  let buf = Buffer.alloc(0);
  /** @type {{ id: string, child: import('node:child_process').ChildProcess, shim: object, timer: NodeJS.Timeout, done?: boolean } | null} */
  let job = null;
  const pending = createPendingJob();
  const pendingHelpers = {
    killTree,
    async revokeJob(id) {
      try { await ctl('POST', `/jobs/${id}/revoke`); } catch { /* proxy down */ }
      try { await ctl('DELETE', `/jobs/${id}`); } catch { /* proxy down */ }
    },
  };
  // Attach before any await/write: backend /stop destroys the peer and emits
  // ECONNRESET; without a listener Node throws and kills the fetcher.
  const life = attachClientSocketLifecycle(socket, {
    onTeardown: () => {
      void (async () => {
        await abandonPending(pending, pendingHelpers);
        await finish(job);
      })().catch(() => {});
    },
  });
  socket.on('data', async (chunk) => {
    if (buf === null) return;
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > maxLine) {
      socket.end(JSON.stringify({ ok: false, error: 'too-large' }) + '\n');
      buf = null;
      return;
    }
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.subarray(0, nl).toString();
    buf = null;
    let msg;
    try { msg = parse(line); } catch {
      socket.end(JSON.stringify({ ok: false, error: 'unauthorized' }) + '\n');
      return;
    }
    if (msg.op === 'status') {
      socket.end(JSON.stringify({
        ok: true,
        jobs: [...jobs.keys()],
        rejected: [...jobs.values()].flatMap((j) => (j.shim?.rejected || []).map((r) => ({ jobId: j.id, ...r }))),
      }) + '\n');
      return;
    }
    if (msg.op === 'cancel') {
      const jobId = parseJobId(msg.jobId);
      if (!jobId) {
        socket.end(JSON.stringify({ ok: false, error: 'bad-job-id' }) + '\n');
        return;
      }
      const existing = jobs.get(jobId);
      await finish(existing);
      socket.end(JSON.stringify({ ok: true, cancelled: jobId, existed: Boolean(existing) }) + '\n');
      return;
    }
    if (msg.op !== 'submit') {
      socket.end(JSON.stringify({ ok: false, error: 'bad op' }) + '\n');
      return;
    }
    if (life.done) return;
    if (jobs.size >= maxJobs) {
      socket.end(JSON.stringify({ ok: false, error: 'busy' }) + '\n');
      return;
    }
    if (typeof msg.url !== 'string' || !/^https?:\/\//i.test(msg.url) || msg.url.length > 2048) {
      socket.end(JSON.stringify({ ok: false, error: 'bad url' }) + '\n');
      return;
    }
    const allocated = allocateJobId(jobs, msg.jobId);
    if (!allocated.ok) {
      socket.end(JSON.stringify({ ok: false, error: allocated.error }) + '\n');
      return;
    }
    const jobId = allocated.jobId;
    pending.jobId = jobId;
    const jobToken = randomBytes(16).toString('hex');
    const ports = constrainRadioPorts(msg.ports);
    if (!ports) {
      socket.end(JSON.stringify({ ok: false, error: 'bad-ports' }) + '\n');
      return;
    }
    const hosts = Array.isArray(msg.hosts) ? msg.hosts.map(String) : [];
    try {
      const reg = await ctl('POST', '/jobs', {
        id: jobId, token: jobToken, hosts, ports, connect: allowTlsConnect(msg.url),
      });
      if (reg.status === 409) {
        pending.jobId = null;
        socket.end(JSON.stringify({ ok: false, error: 'duplicate-job' }) + '\n');
        return;
      }
      if (reg.status !== 201) throw new Error('proxy register');
      pending.proxyRegistered = true;
    } catch {
      pending.jobId = null;
      socket.end(JSON.stringify({ ok: false, error: 'proxy-unavailable' }) + '\n');
      return;
    }
    if (!(await continueIfClientAlive(life, pending, pendingHelpers))) return;

    let shim;
    let child;
    try {
      shim = await startShim(jobToken);
      pending.shim = shim;
      if (!(await continueIfClientAlive(life, pending, pendingHelpers))) return;
      ({ child } = startFfmpeg(msg.url, shim.port));
      pending.child = child;
    } catch {
      await abandonPending(pending, pendingHelpers);
      if (!life.done) {
        socket.end(JSON.stringify({ ok: false, error: 'fetcher-unavailable' }) + '\n');
      }
      return;
    }
    if (!(await continueIfClientAlive(life, pending, pendingHelpers))) return;

    shim.allowPid(child.pid);
    job = {
      id: jobId,
      child,
      shim,
      timer: setTimeout(() => finish(job), jobTimeoutMs),
    };
    jobs.set(jobId, job);
    // finish() owns cleanup from here; clear pending so teardown cannot double-kill.
    pending.child = null;
    pending.shim = null;
    pending.proxyRegistered = false;
    pending.jobId = null;
    if (life.done) {
      await finish(job);
      return;
    }
    try {
      socket.write(JSON.stringify({ ok: true, jobId, shimPort: shim.port }) + '\n');
    } catch { /* closed */ }
    if (life.done) {
      await finish(job);
      return;
    }
    // Pause ffmpeg stdout when the client socket is full so a fast VOD cannot
    // buffer unbounded audio in this process.
    child.stdout.on('data', (c) => {
      try {
        if (!socket.write(c)) child.stdout.pause();
      } catch { /* closed */ }
    });
    socket.on('drain', () => {
      try { child.stdout.resume(); } catch { /* closed */ }
    });
    child.stderr.on('data', (c) => {
      const log = process.env.FETCHER_FFMPEG_LOG;
      if (log) {
        try { fs.appendFileSync(log, c); } catch { /* ignore */ }
      }
    });
    child.on('close', (status) => {
      try { socket.end(); } catch { /* closed */ }
      void finish(job).catch(() => {});
      void status;
    });
    // socket close/error → abandonPending + finish via lifecycle (idempotent)
  });
}

try { fs.unlinkSync(sockPath); } catch { /* first run */ }
const server = net.createServer(handle);
server.listen(sockPath, () => {
  try { fs.chmodSync(sockPath, 0o660); } catch { /* volume */ }
  process.stdout.write('FETCHER ready\n');
});
server.on('error', (err) => {
  process.stdout.write(`FETCHER error ${err.message}\n`);
  process.exit(1);
});

async function shutdown() {
  for (const job of [...jobs.values()]) await finish(job);
  server.close();
  try { fs.unlinkSync(sockPath); } catch { /* gone */ }
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
