// Child-process fixture for trust-proxy.test.ts. config.ts reads TRUST_PROXY at import
// time, so each configuration needs its own process. Prints one JSON line of statuses.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const { createApp } = await import('./app.js');
const { ListenerRemoteService } = await import('./voice/listener-remote.js');
const app = createApp();
// index.ts attaches this at startup; the listener remote routes answer 503 without it.
app.locals.listenerRemote = new ListenerRemoteService();
// The test host only has loopback. A request may name the address its connection should
// appear to come from; the header is removed before the app sees the request, and the
// app then derives the client address exactly as it does for a real peer.
const PEER_HEADER = 'x-test-socket-peer';
const server = createServer((req, res) => {
  const peer = req.headers[PEER_HEADER];
  delete req.headers[PEER_HEADER];
  const at = req.rawHeaders.findIndex((name, index) => index % 2 === 0 && name.toLowerCase() === PEER_HEADER);
  if (at >= 0) req.rawHeaders.splice(at, 2);
  // Sockets are reused, so always set or clear the override.
  if (typeof peer === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true });
  else Reflect.deleteProperty(req.socket, 'remoteAddress');
  app(req, res);
}).listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  const onError = (err: Error) => { server.off('listening', onListening); reject(err); };
  const onListening = () => { server.off('error', onError); resolve(); };
  server.once('error', onError);
  server.once('listening', onListening);
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function post(path: string, body: unknown, xff?: string, peer?: string): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(xff ? { 'x-forwarded-for': xff } : {}),
      ...(peer ? { [PEER_HEADER]: peer } : {}),
    },
    body: JSON.stringify(body),
  });
  await res.arrayBuffer();
  return res.status;
}

function login(xff?: string, peer?: string): Promise<number> {
  return post('/api/auth/login', { username: 'nobody', password: 'wrong' }, xff, peer);
}

/** One group of identical requests. `{i}` in `xff` is replaced by the request number (1-based). */
interface Burst { name: string; count: number; peer?: string; xff?: string; path?: string }

const scenario = process.argv[2];
const out: Record<string, number> = {};
if (scenario === 'two-clients') {
  // nginx sets X-Forwarded-For to "<what the client sent>, <client address>".
  for (let i = 0; i < 15; i++) await login('198.51.100.10');
  out.clientA16th = await login('198.51.100.10');
  out.clientB1st = await login('198.51.100.20');
} else if (scenario === 'rotating-forged-header') {
  // Client forges a fresh left-most entry every time; nginx appends the real address.
  for (let i = 0; i < 15; i++) await login(`203.0.113.${i}, 198.51.100.30`);
  out.forged16th = await login('203.0.113.99, 198.51.100.30');
} else if (scenario === 'direct-rotating-header') {
  // No proxy in between: the client sends the header itself.
  for (let i = 0; i < 15; i++) await login(`203.0.113.${i}`);
  out.forged16th = await login('203.0.113.99');
}
if (scenario === 'bursts') {
  const bursts = JSON.parse(process.argv[3] ?? '[]') as Burst[];
  const statuses: Record<string, number[]> = {};
  for (const burst of bursts) {
    statuses[burst.name] = [];
    for (let i = 1; i <= burst.count; i++) {
      const xff = burst.xff?.replaceAll('{i}', String(i));
      statuses[burst.name].push(burst.path
        ? await post(burst.path, { token: 'x' }, xff, burst.peer)
        : await login(xff, burst.peer));
    }
  }
  console.log(`RESULT ${JSON.stringify(statuses)}`);
  server.close();
  process.exit(0);
}
console.log(`RESULT ${JSON.stringify(out)}`);
server.close();
process.exit(0);
