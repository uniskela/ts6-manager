// Child-process fixture for trust-proxy.test.ts. config.ts reads TRUST_PROXY at import
// time, so each configuration needs its own process. Prints one JSON line of statuses.
import type { AddressInfo } from 'node:net';

const { createApp } = await import('./app.js');
const server = createApp().listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function login(xff?: string): Promise<number> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
    body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
  });
  await res.arrayBuffer();
  return res.status;
}

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
console.log(`RESULT ${JSON.stringify(out)}`);
server.close();
process.exit(0);
