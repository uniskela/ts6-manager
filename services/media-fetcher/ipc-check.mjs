/** Offline INT media-fetcher IPC checks (socket + token). No Discord tunnel.
 * Run as uid 1000 with the shared jobs volume mounted (compose profile ipc-check).
 * Does not print token contents.
 */
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

const sockPath = process.env.MEDIA_FETCHER_SOCK || '/jobs/jobs.sock';
const tokenPath = process.env.MEDIA_FETCHER_TOKEN_FILE || '/jobs/.token';
const connectMs = Number(process.env.IPC_CHECK_CONNECT_MS || 5000);
const rpcMs = Number(process.env.IPC_CHECK_RPC_MS || 5000);

function fail(msg) {
  console.error(`ipc-check FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`ipc-check OK: ${msg}`);
}

function readToken() {
  let st;
  try {
    st = fs.statSync(tokenPath);
  } catch (err) {
    fail(`token unreadable (${err.code || err.message})`);
  }
  if ((st.mode & 0o007) !== 0) fail(`token mode ${(st.mode & 0o777).toString(8)} is world-accessible`);
  if ((st.mode & 0o777) !== 0o600) fail(`token mode ${(st.mode & 0o777).toString(8)} expected 600`);
  const raw = fs.readFileSync(tokenPath, 'utf8').replace(/\s+/g, '');
  if (raw.length < 16) fail('token too short');
  return raw;
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connect-timeout'));
    }, connectMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function rpc(socket, msg) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('rpc-timeout'));
    }, rpcMs);
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        reject(err);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.write(`${JSON.stringify(msg)}\n`);
  });
}

async function once(msg) {
  const socket = await connect();
  return rpc(socket, msg);
}

function assertNoHostFfmpegFallback() {
  // Client contract: missing/invalid fetcher must not spawn local ffmpeg.
  // Grep the backend client source if mounted; otherwise skip with note.
  const client = '/src/media-fetcher-client.ts';
  if (!fs.existsSync(client)) {
    ok('skip host-ffmpeg source assert (client not mounted); unit tests cover fail-closed');
    return;
  }
  const text = fs.readFileSync(client, 'utf8');
  if (!/Never falls back to local ffmpeg/.test(text)) {
    fail('media-fetcher-client missing fail-closed ffmpeg contract comment');
  }
  if (/\bspawn\s*\(\s*['"]ffmpeg['"]/.test(text)) {
    fail('media-fetcher-client appears to spawn ffmpeg directly');
  }
  ok('media-fetcher-client source has no local ffmpeg spawn');
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    fail('must not run as root');
  }

  // Socket + token visibility (EACCES root cause check)
  try {
    fs.accessSync(tokenPath, fs.constants.R_OK);
  } catch (err) {
    fail(`token access ${err.code || err.message}`);
  }
  const token = readToken();
  ok(`token readable mode 600 (len=${token.length}, contents omitted)`);

  let sockSt;
  for (let i = 0; i < 50; i++) {
    try {
      sockSt = fs.statSync(sockPath);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!sockSt) fail(`socket missing at ${sockPath}`);
  try {
    fs.accessSync(sockPath, fs.constants.W_OK);
  } catch (err) {
    fail(`socket access ${err.code || err.message}`);
  }
  ok(`jobs socket reachable (${sockPath})`);

  // Authorised status
  const status = await once({ op: 'status', token });
  if (!status || status.ok !== true) fail(`authorised status rejected: ${JSON.stringify(status)}`);
  ok('authorised status accepted');

  // Fail-closed: bad token
  const bad = await once({ op: 'status', token: '0'.repeat(32) });
  if (!bad || bad.ok !== false || bad.error !== 'unauthorized') {
    fail(`bad token did not fail closed: ${JSON.stringify(bad)}`);
  }
  ok('invalid token fail-closed (unauthorized)');

  // Fail-closed: missing token field
  const missing = await once({ op: 'status' });
  if (!missing || missing.ok !== false || missing.error !== 'unauthorized') {
    fail(`missing token did not fail closed: ${JSON.stringify(missing)}`);
  }
  ok('missing token fail-closed (unauthorized)');

  // Authorised submit of a deliberately bad URL should auth-pass then reject URL —
  // proves auth works without requiring egress to a real station.
  const submit = await once({
    op: 'submit',
    token,
    url: 'not-a-url',
    ports: [80, 443],
  });
  if (!submit || submit.ok !== false || submit.error !== 'bad url') {
    fail(`authorised bad-url submit unexpected: ${JSON.stringify(submit)}`);
  }
  ok('authorised submit reached fetcher (bad url rejected after auth)');

  // No accidental ffmpeg on the probe host from this check itself
  const ps = spawnSync('sh', ['-c', 'ps -o args= -C ffmpeg 2>/dev/null | head -n 5 || true'], {
    encoding: 'utf8',
  });
  const lines = (ps.stdout || '').trim();
  if (lines && /ffmpeg/.test(lines)) {
    // May be unrelated; only fail if our probe clearly started one with not-a-url
    if (/not-a-url/.test(lines)) fail('ffmpeg invoked for rejected URL');
  }
  ok('no unrestricted ffmpeg fallback from rejected IPC probe');

  assertNoHostFfmpegFallback();
  console.log('ipc-check PASS');
}

main().catch((err) => fail(err.stack || String(err)));
