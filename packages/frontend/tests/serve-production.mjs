// Test-only origin serving real production artifacts. Never ships in dist.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(new URL('../../backend/package.json', import.meta.url))('ws');
const dist = new URL('../dist/', import.meta.url);
let generation = 0;
let unavailable = false;
let mutations = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/__test/')) {
    if (url.pathname === '/__test/update') generation++;
    if (url.pathname === '/__test/reset') { unavailable = false; mutations = 0; }
    if (url.pathname === '/__test/unavailable') unavailable = url.searchParams.has('on');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ mutations }));
    return;
  }
  if (/^\/(api|ws)(\/|$)/.test(url.pathname)) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') mutations++;
    if (unavailable) { res.writeHead(503); res.end('{"error":"unavailable"}'); return; }
    const data = url.pathname === '/api/health' ? { status: 'ok' }
      : url.pathname === '/api/setup/status' ? { needsSetup: false }
      : url.pathname === '/api/auth/login' ? { error: 'Invalid credentials' }
      : { secret: 'test-only-sensitive-response', timestamp: Date.now() };
    if (url.pathname === '/api/auth/login') res.statusCode = 401;
    res.end(JSON.stringify(data));
    return;
  }
  const staticPath = /^\/(assets|icons)\//.test(url.pathname)
    || ['/sw.js', '/favicon.svg', '/manifest.webmanifest'].includes(url.pathname);
  const file = staticPath ? url.pathname.slice(1) : 'index.html';
  if (file.includes('..')) { res.writeHead(400); res.end(); return; }
  try {
    let data = await readFile(new URL(file, dist));
    if (file === 'sw.js') data = Buffer.concat([data, Buffer.from(`\n// test deployment ${generation}\n`)]);
    const ext = file.split('.').pop();
    res.setHeader('Content-Type', {
      html: 'text/html', js: 'application/javascript', css: 'text/css', png: 'image/png',
      svg: 'image/svg+xml', webmanifest: 'application/manifest+json',
    }[ext] || 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const ws = new WebSocketServer({ server, path: '/ws' });
ws.on('connection', socket => socket.send('live-test-message'));
server.listen(4175, '127.0.0.1');
