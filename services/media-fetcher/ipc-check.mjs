/** Offline INT media-fetcher IPC checks (socket + token). No Discord tunnel.
 * Run as uid 1000 with the shared jobs volume mounted (compose profile ipc-check).
 * Does not print token contents.
 */
import fs from 'node:fs';
import net from 'node:net';

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
  return rpc(await connect(), msg);
}

function expectUnauthorized(label, res) {
  if (res?.ok !== false || res?.error !== 'unauthorized') {
    fail(`${label} did not fail closed: ${JSON.stringify(res)}`);
  }
  ok(`${label} fail-closed (unauthorized)`);
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    fail('must not run as root');
  }

  try {
    fs.accessSync(tokenPath, fs.constants.R_OK);
  } catch (err) {
    fail(`token access ${err.code || err.message}`);
  }
  const token = readToken();
  ok(`token readable mode 600 (len=${token.length}, contents omitted)`);

  try {
    fs.accessSync(sockPath, fs.constants.W_OK);
  } catch (err) {
    fail(`socket access ${err.code || err.message}`);
  }
  ok(`jobs socket reachable (${sockPath})`);

  const status = await once({ op: 'status', token });
  if (status?.ok !== true) fail(`authorised status rejected: ${JSON.stringify(status)}`);
  ok('authorised status accepted');

  expectUnauthorized('invalid token', await once({ op: 'status', token: '0'.repeat(32) }));
  expectUnauthorized('missing token', await once({ op: 'status' }));

  const submit = await once({
    op: 'submit',
    token,
    url: 'not-a-url',
    ports: [80, 443],
  });
  if (submit?.ok !== false || submit?.error !== 'bad url') {
    fail(`authorised bad-url submit unexpected: ${JSON.stringify(submit)}`);
  }
  ok('authorised submit reached fetcher (bad url rejected after auth)');
  ok('no local ffmpeg fallback path in this probe (client unit tests cover fail-closed)');
  console.log('ipc-check PASS');
}

await main();
