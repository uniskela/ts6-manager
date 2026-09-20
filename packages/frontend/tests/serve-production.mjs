// Test-only origin serving real production artifacts. Never ships in dist.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(new URL('../../backend/package.json', import.meta.url))('ws');
const dist = new URL('../dist/', import.meta.url);
let generation = 0;
let unavailable = false;
let mutations = 0;
let needsSetup = false;
let allowTestAuth = false;
let dashboardScenario = 'no-connections';
let dashboardRequests = 0;

const connections = [
  { id: 1, name: 'Primary connection', host: 'voice.example.test', webqueryPort: 10080, sshPort: 10022, useHttps: true },
  { id: 2, name: 'Secondary connection', host: 'backup.example.test', webqueryPort: 10080, sshPort: 10022, useHttps: true },
];

const dashboards = {
  '1:1': {
    serverName: 'Operations Voice',
    platform: 'Linux x86_64 with an intentionally long platform description that must wrap safely',
    version: '6.0.0-beta.7 build 20260920-very-long-version-identifier-that-must-wrap-safely',
    onlineUsers: 18,
    maxClients: 32,
    uptime: 183845,
    channelCount: 27,
    bandwidth: { incoming: 18240, outgoing: 24680 },
    packetloss: 0.0012,
    ping: 18.42,
  },
  '2:2': {
    serverName: 'Backup Voice',
    platform: 'Linux',
    version: '6.0.0-beta.7',
    onlineUsers: 1,
    maxClients: 4,
    uptime: 95,
    channelCount: 3,
    bandwidth: { incoming: 512, outgoing: 1024 },
    packetloss: 0,
    ping: 4.8,
  },
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/__test/')) {
    if (url.pathname === '/__test/update') generation++;
    if (url.pathname === '/__test/reset') { unavailable = false; mutations = 0; needsSetup = false; allowTestAuth = false; dashboardScenario = 'no-connections'; dashboardRequests = 0; }
    if (url.pathname === '/__test/unavailable') unavailable = url.searchParams.has('on');
    if (url.pathname === '/__test/setup') needsSetup = url.searchParams.has('on');
    if (url.pathname === '/__test/auth') allowTestAuth = url.searchParams.has('on');
    if (url.pathname === '/__test/dashboard') { dashboardScenario = url.searchParams.get('scenario') || 'normal'; dashboardRequests = 0; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ mutations, dashboardScenario, dashboardRequests }));
    return;
  }
  if (/^\/(api|ws)(\/|$)/.test(url.pathname)) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') mutations++;
    if (unavailable) { res.writeHead(503); res.end('{"error":"unavailable"}'); return; }
    const data = url.pathname === '/api/health' ? { status: 'ok' }
      : url.pathname === '/api/setup/status' ? { needsSetup }
      : url.pathname === '/api/auth/login' && allowTestAuth ? {
        accessToken: 'brand-test-access-token',
        refreshToken: 'brand-test-refresh-token',
        user: { id: 1, username: 'admin', displayName: 'Administrator', role: 'admin' },
      }
      : url.pathname === '/api/auth/login' ? { error: 'Invalid credentials' }
      : url.pathname === '/api/auth/me' && allowTestAuth ? {
        user: { id: 1, username: 'admin', displayName: 'Administrator', role: 'admin' },
      }
      : url.pathname === '/api/servers/deployment-check' && allowTestAuth ? {
        managerInDocker: false,
        probes: [],
        suggestedScenarioId: null,
        suggestedHost: null,
        confidence: 'none',
        reason: 'No local server detected in the production test environment.',
      }
      : url.pathname === '/api/widgets' && allowTestAuth ? []
      : url.pathname === '/api/servers' && allowTestAuth ? (dashboardScenario === 'no-connections' ? [] : connections)
      : /^\/api\/servers\/\d+\/virtual-servers$/.test(url.pathname) && allowTestAuth
        ? (dashboardScenario === 'no-selection' ? [] : [{
            virtualserver_id: url.pathname.includes('/2/') ? 2 : 1,
            virtualserver_name: url.pathname.includes('/2/') ? 'Backup Voice' : 'Operations Voice',
            virtualserver_status: 'online',
            virtualserver_clients_online: url.pathname.includes('/2/') ? 1 : 18,
            virtualserver_maxclients: url.pathname.includes('/2/') ? 4 : 32,
          }])
      : /^\/api\/servers\/(\d+)\/vs\/(\d+)\/dashboard$/.test(url.pathname) && allowTestAuth
        ? (() => {
            dashboardRequests++;
            if (dashboardScenario === 'initial-failure') {
              res.statusCode = 503;
              return { error: 'TeamSpeak connection unavailable', details: 'WebQuery handshake timed out' };
            }
            if (dashboardScenario === 'query-flood' && dashboardRequests === 1) {
              res.statusCode = 429;
              return { error: 'Query flood protection active', details: 'Retry after the TeamSpeak cooldown' };
            }
            if (dashboardScenario === 'background-failure' && dashboardRequests > 1) {
              res.statusCode = 503;
              return { error: 'Live refresh failed', details: 'The last successful snapshot is still available' };
            }
            const [, configId, sid] = url.pathname.match(/^\/api\/servers\/(\d+)\/vs\/(\d+)\/dashboard$/) || [];
            const base = dashboards[`${configId}:${sid}`] || dashboards['1:1'];
            if (dashboardScenario === 'zero-capacity') {
              return { ...base, onlineUsers: 0, maxClients: 0, bandwidth: { incoming: 0, outgoing: 0 }, packetloss: 0, ping: 0 };
            }
            return {
              ...base,
              bandwidth: {
                incoming: base.bandwidth.incoming + dashboardRequests * 128,
                outgoing: base.bandwidth.outgoing + dashboardRequests * 64,
              },
            };
          })()
      : { secret: 'test-only-sensitive-response', timestamp: Date.now() };
    if (url.pathname === '/api/auth/login' && !allowTestAuth) res.statusCode = 401;
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
