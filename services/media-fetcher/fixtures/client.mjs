/** App-net Job API client for local validation. Reads the token from a file. */
import fs from 'node:fs';
import net from 'node:net';

const sockPath = process.env.JOBS_SOCK || '/jobs/jobs.sock';
const token = fs.readFileSync(process.env.MEDIA_FETCHER_TOKEN_FILE, 'utf8').replace(/\s+/g, '');

function rpc(msg, { collectPcm = false, timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    const chunks = [];
    let header;
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify({ ...msg, token }) + '\n'));
    socket.on('data', (chunk) => {
      if (!header) {
        buf += chunk.toString('latin1');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        header = JSON.parse(buf.slice(0, nl));
        const rest = Buffer.from(buf.slice(nl + 1), 'latin1');
        if (!collectPcm) {
          clearTimeout(timer);
          socket.end();
          resolve({ header, bytes: 0 });
          return;
        }
        if (rest.length) chunks.push(rest);
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve({ header, bytes: Buffer.concat(chunks).length });
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const op = process.argv[2] || 'status';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

if (op === 'wait') {
  const until = Date.now() + Number(arg('ms', '8000'));
  while (Date.now() < until) {
    try {
      fs.accessSync(sockPath);
      const r = await rpc({ op: 'status' });
      if (r.header?.ok) {
        process.stdout.write(JSON.stringify({ ready: true }) + '\n');
        process.exit(0);
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  process.exit(1);
}

if (op === 'submit') {
  const result = await rpc({
    op: 'submit',
    jobId: arg('id', ''),
    url: arg('url'),
    hosts: arg('hosts', 'origin').split(','),
    ports: arg('ports', '8443,8000').split(',').map(Number),
  }, { collectPcm: true, timeoutMs: Number(arg('timeout', '15000')) });
  process.stdout.write(JSON.stringify({ header: result.header, bytes: result.bytes }) + '\n');
  process.exit(result.header?.ok && result.bytes > 0 ? 0 : 1);
}

if (op === 'cancel') {
  process.stdout.write(JSON.stringify((await rpc({ op: 'cancel', jobId: arg('id') })).header) + '\n');
  process.exit(0);
}

if (op === 'hold-cancel') {
  const jobId = arg('id', 'hold1');
  const started = net.connect(sockPath);
  let header;
  let buf = '';
  started.on('connect', () => {
    started.write(JSON.stringify({
      op: 'submit', token, jobId, url: arg('url'),
      hosts: ['origin'], ports: arg('ports', '8000').split(',').map(Number),
    }) + '\n');
  });
  started.on('data', (chunk) => {
    if (header) return;
    buf += chunk.toString('latin1');
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    header = JSON.parse(buf.slice(0, nl));
    process.stdout.write(JSON.stringify({ started: header }) + '\n');
  });
  await new Promise((r) => setTimeout(r, Number(arg('ms', '800'))));
  const cancel = await rpc({ op: 'cancel', jobId });
  started.destroy();
  process.stdout.write(JSON.stringify({ cancel: cancel.header }) + '\n');
  process.exit(0);
}

/** Destroy during submit startup (before/while header) — no live job leak. */
if (op === 'abrupt-during-start') {
  const jobId = arg('id', 'early1');
  const started = net.connect(sockPath);
  started.on('error', () => {});
  started.on('connect', () => {
    started.write(JSON.stringify({
      op: 'submit', token, jobId, url: arg('url'),
      hosts: ['origin'], ports: arg('ports', '8000').split(',').map(Number),
    }) + '\n');
    started.destroy();
  });
  await new Promise((r) => setTimeout(r, Number(arg('ms', '1500'))));
  const status = await rpc({ op: 'status' });
  const again = await rpc({
    op: 'submit',
    jobId: arg('next', 'after-early'),
    url: arg('next-url', arg('url')),
    hosts: ['origin'],
    ports: arg('ports', '8000').split(',').map(Number),
  }, { collectPcm: true, timeoutMs: Number(arg('timeout', '15000')) });
  const jobsAfter = status.header?.jobs || [];
  process.stdout.write(JSON.stringify({
    statusAfter: status.header,
    cleared: !jobsAfter.includes(jobId),
    next: { header: again.header, bytes: again.bytes },
  }) + '\n');
  process.exit(status.header?.ok && !jobsAfter.includes(jobId) && again.header?.ok && again.bytes > 0 ? 0 : 1);
}

/** Abrupt peer destroy mid-stream (backend /stop). Fetcher must stay alive. */
if (op === 'abrupt-stop') {
  const jobId = arg('id', 'abrupt1');
  const started = net.connect(sockPath);
  let header;
  let buf = '';
  let pcm = 0;
  started.on('connect', () => {
    started.write(JSON.stringify({
      op: 'submit', token, jobId, url: arg('url'),
      hosts: ['origin'], ports: arg('ports', '8000').split(',').map(Number),
    }) + '\n');
  });
  started.on('data', (chunk) => {
    if (!header) {
      buf += chunk.toString('latin1');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      header = JSON.parse(buf.slice(0, nl));
      pcm += Buffer.byteLength(buf.slice(nl + 1), 'latin1');
      return;
    }
    pcm += chunk.length;
  });
  started.on('error', () => {});
  await new Promise((r) => setTimeout(r, Number(arg('ms', '600'))));
  started.destroy();
  await new Promise((r) => setTimeout(r, 400));
  const status = await rpc({ op: 'status' });
  const nextUrl = arg('next-url', arg('url'));
  const again = await rpc({
    op: 'submit',
    jobId: arg('next', 'after-abrupt'),
    url: nextUrl,
    hosts: ['origin'],
    ports: arg('ports', '8000').split(',').map(Number),
  }, { collectPcm: true, timeoutMs: Number(arg('timeout', '15000')) });
  process.stdout.write(JSON.stringify({
    started: header,
    pcmBeforeDestroy: pcm,
    statusAfter: status.header,
    next: { header: again.header, bytes: again.bytes },
  }) + '\n');
  const jobsAfter = status.header?.jobs || [];
  const cleared = !jobsAfter.includes(jobId);
  process.exit(header?.ok && status.header?.ok && cleared && again.header?.ok && again.bytes > 0 ? 0 : 1);
}

if (op === 'status') {
  process.stdout.write(JSON.stringify((await rpc({ op: 'status' })).header) + '\n');
}

if (op === 'unauth') {
  const socket = net.connect(sockPath);
  socket.write(`${JSON.stringify({ op: 'status', token: 'wrong' })}\n`);
  socket.on('data', (c) => {
    process.stdout.write(c.toString());
    process.exit(0);
  });
  setTimeout(() => process.exit(2), 3000);
}
