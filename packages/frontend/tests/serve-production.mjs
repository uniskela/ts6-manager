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
let permissionScenario = 'normal';
let permissionRequests = [];
let botScenario = 'normal';
let botUpdateRequests = [];
let dataTableScenario = 'normal';
const initialBots = [
  {
    id: 1,
    name: 'Large Flow',
    description: 'A deterministic editor fixture',
    enabled: true,
    serverConfigId: 1,
    virtualServerId: 1,
    flowData: {
      nodes: [
        { id: 'trigger', type: 'trigger_event', label: 'Trigger', config: {}, x: 80, y: 80 },
        { id: 'condition', type: 'condition', label: 'Condition', config: {}, x: 380, y: 180 },
        { id: 'far', type: 'action_message', label: 'Far action', config: { message: 'legacy' }, x: 2200, y: 1300 },
      ],
      edges: [
        { id: 'edge-trigger-condition', source: 'trigger', sourcePort: 'out', target: 'condition', targetPort: 'in' },
        { id: 'edge-condition-far', source: 'condition', sourcePort: 'true', target: 'far', targetPort: 'in' },
      ],
    },
    updatedAt: '2026-09-20T00:00:00.000Z',
  },
];
let bots = structuredClone(initialBots);

const dataTableClients = Array.from({ length: 25 }, (_, index) => ({
  clid: index + 1,
  client_nickname: index === 0 ? 'Ada Admin' : `Client ${String(index + 1).padStart(2, '0')}`,
  client_country: index % 2 === 0 ? 'AU' : 'FI',
  connection_client_ip: `10.0.0.${index + 1}`,
  client_idle_time: index * 1000,
  client_away: index % 5 === 0 ? 1 : 0,
  client_output_muted: 0,
  client_input_muted: index % 4 === 0 ? 1 : 0,
  client_type: 0,
}));

const dataTableComplaints = [
  { fname: 'Zoe', tname: 'Reported target C', message: 'Third complaint', timestamp: 1_726_800_300 },
  { fname: 'Ada', tname: 'Reported target A', message: 'First complaint', timestamp: 1_726_800_100 },
  { fname: 'Mira', tname: 'Reported target B', message: 'Second complaint', timestamp: 1_726_800_200 },
];

function dataTableRows(rows) {
  return dataTableScenario === 'populated' ? rows : [];
}

const permissionDefinitions = [
  { permid: 1, permname: 'b_virtualserver_modify_name', permdesc: 'Modify the virtual server name' },
  { permid: 2, permname: 'i_channel_needed_permission_modify_power', permdesc: 'Needed channel modify power' },
  { permid: 3, permname: 'i_client_kick_from_server_power', permdesc: 'Server kick power' },
  { permid: 4, permname: 'b_client_ignore_bans', permdesc: 'Ignore server bans' },
  { permid: 5, permname: 'i_group_modify_power', permdesc: '' },
];

const initialPermissionValues = {
  'server-groups:10': [
    { permid: 1, permsid: 'b_virtualserver_modify_name', permvalue: 1, permnegated: 0, permskip: 0 },
    { permid: 2, permsid: 'i_channel_needed_permission_modify_power', permvalue: 0, permnegated: 0, permskip: 0 },
  ],
  'server-groups:20': [
    { permid: 2, permsid: 'i_channel_needed_permission_modify_power', permvalue: 25, permnegated: 0, permskip: 1 },
  ],
  'server-groups:30': [
    { permid: 2, permsid: 'i_channel_needed_permission_modify_power', permvalue: 25, permnegated: 1, permskip: 0 },
  ],
  'server-groups:40': [
    { permid: 3, permsid: 'i_client_kick_from_server_power', permvalue: 75, permnegated: 1, permskip: 1 },
  ],
  'server-groups:50': [],
  'channel-groups:60': [{ permid: 5, permsid: 'i_group_modify_power', permvalue: 50, permnegated: 0, permskip: 0 }],
  'channels:70': [{ permid: 2, permsid: 'i_channel_needed_permission_modify_power', permvalue: 10, permnegated: 0, permskip: 0 }],
  'clients:80': [{ permid: 3, permsid: 'i_client_kick_from_server_power', permvalue: 60, permnegated: 0, permskip: 0 }],
  'clients:81': [],
};
let permissionValues = structuredClone(initialPermissionValues);

const permissionEntities = {
  'server-groups': [
    { sgid: 10, name: 'Administrators', type: 1 },
    { sgid: 20, name: 'Moderators', type: 1 },
    { sgid: 30, name: 'Guests', type: 1 },
    { sgid: 40, name: 'Operators', type: 1 },
    { sgid: 50, name: 'Auditors', type: 1 },
  ],
  'channel-groups': [{ cgid: 60, name: 'Channel Admin', type: 1 }],
  channels: [{ cid: 70, channel_name: 'Lobby' }, { cid: 71, channel_name: 'Support' }],
  clients: [
    { client_database_id: 80, client_nickname: 'Online Admin', client_type: 0 },
    { client_database_id: 999, client_nickname: 'Query Bot', client_type: 1 },
  ],
  database: [
    { cldbid: 80, client_nickname: 'Online Admin' },
    { cldbid: 81, client_nickname: 'Offline Admin' },
  ],
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

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
    if (url.pathname === '/__test/reset') {
      unavailable = false;
      mutations = 0;
      needsSetup = false;
      allowTestAuth = false;
      dashboardScenario = 'no-connections';
      dashboardRequests = 0;
      permissionScenario = 'normal';
      permissionRequests = [];
      permissionValues = structuredClone(initialPermissionValues);
      botScenario = 'normal';
      botUpdateRequests = [];
      bots = structuredClone(initialBots);
      dataTableScenario = 'normal';
    }
    if (url.pathname === '/__test/unavailable') unavailable = url.searchParams.has('on');
    if (url.pathname === '/__test/setup') needsSetup = url.searchParams.has('on');
    if (url.pathname === '/__test/auth') allowTestAuth = url.searchParams.has('on');
    if (url.pathname === '/__test/dashboard') { dashboardScenario = url.searchParams.get('scenario') || 'normal'; dashboardRequests = 0; }
    if (url.pathname === '/__test/permissions' && url.searchParams.has('scenario')) {
      permissionScenario = url.searchParams.get('scenario') || 'normal';
      permissionRequests = [];
    }
    if (url.pathname === '/__test/bots' && url.searchParams.has('scenario')) {
      botScenario = url.searchParams.get('scenario') || 'normal';
      botUpdateRequests = [];
      if (botScenario === 'server-update') bots[0].name = 'Server refreshed';
    }
    if (url.pathname === '/__test/data-table' && url.searchParams.has('scenario')) {
      dataTableScenario = url.searchParams.get('scenario') || 'normal';
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ mutations, dashboardScenario, dashboardRequests, permissionScenario, permissionRequests, botScenario, botUpdateRequests }));
    return;
  }
  if (/^\/(api|ws)(\/|$)/.test(url.pathname)) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') mutations++;
    if (unavailable) { res.writeHead(503); res.end('{"error":"unavailable"}'); return; }

    const permissionContext = url.pathname.match(/^\/api\/servers\/(\d+)\/vs\/(\d+)\/(server-groups|channel-groups|channels|clients)\/(\d+)\/permissions$/);
    if (allowTestAuth && permissionContext) {
      const [, configId, sid, entityType, entityId] = permissionContext;
      const key = `${entityType}:${entityId}`;
      if (req.method === 'GET') {
        permissionRequests.push({ method: req.method, path: url.pathname });
        if (permissionScenario === 'compare-429' && entityId === '40') {
          res.writeHead(429);
          res.end('{"error":"Query flood protection active","details":"Retry after the TeamSpeak cooldown"}');
          return;
        }
        if (permissionScenario === 'compare-failure' && entityId === '40') {
          res.writeHead(503);
          res.end('{"error":"Operator permissions unavailable"}');
          return;
        }
        res.end(JSON.stringify(permissionValues[key] || []));
        return;
      }

      const body = await readJson(req);
      permissionRequests.push({ method: req.method, path: url.pathname, body, configId: Number(configId), sid: Number(sid) });
      const writeCount = permissionRequests.filter(request => request.method !== 'GET').length;
      if (permissionScenario === 'slow-save') await new Promise(resolve => setTimeout(resolve, 800));
      if (permissionScenario === 'save-failure' || (permissionScenario === 'partial-failure' && writeCount === 2)) {
        res.writeHead(503);
        res.end('{"error":"TeamSpeak rejected this permission change"}');
        return;
      }

      const values = permissionValues[key] || [];
      if (req.method === 'DELETE') {
        permissionValues[key] = values.filter(value => value.permsid !== body.permsid);
      } else {
        const definition = permissionDefinitions.find(value => value.permname === body.permsid);
        const next = {
          permid: definition?.permid ?? 0,
          permsid: body.permsid,
          permvalue: Number(body.permvalue) || 0,
          permnegated: Number(body.permnegated) || 0,
          permskip: Number(body.permskip) || 0,
        };
        permissionValues[key] = [...values.filter(value => value.permsid !== body.permsid), next];
      }
      res.end('{"success":true}');
      return;
    }

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
      : url.pathname === '/api/bots' && allowTestAuth ? bots
      : /^\/api\/bots\/(\d+)$/.test(url.pathname) && allowTestAuth
        ? (() => {
            const id = Number(url.pathname.split('/').pop());
            const bot = bots.find((item) => item.id === id);
            if (req.method === 'GET') return bot || { error: 'Bot not found' };
            return bot;
          })()
      : url.pathname === '/api/servers' && allowTestAuth ? (dashboardScenario === 'no-connections' ? [] : connections)
      : /^\/api\/servers\/\d+\/virtual-servers$/.test(url.pathname) && allowTestAuth
        ? (dashboardScenario === 'no-selection' ? [] : url.pathname.includes('/2/') ? [
            { virtualserver_id: 2, virtualserver_name: 'Backup Voice', virtualserver_status: 'online', virtualserver_clients_online: 1, virtualserver_maxclients: 4 },
            { virtualserver_id: 22, virtualserver_name: 'Backup Staging', virtualserver_status: 'online', virtualserver_clients_online: 0, virtualserver_maxclients: 8 },
          ] : [
            { virtualserver_id: 1, virtualserver_name: 'Operations Voice', virtualserver_status: 'online', virtualserver_clients_online: 18, virtualserver_maxclients: 32 },
            { virtualserver_id: 11, virtualserver_name: 'Operations Staging', virtualserver_status: 'online', virtualserver_clients_online: 2, virtualserver_maxclients: 16 },
          ])
      : /^\/api\/servers\/\d+\/vs\/\d+\/permissions$/.test(url.pathname) && allowTestAuth ? permissionDefinitions
      : /^\/api\/servers\/\d+\/vs\/\d+\/server-groups$/.test(url.pathname) && allowTestAuth ? permissionEntities['server-groups']
      : /^\/api\/servers\/\d+\/vs\/\d+\/channel-groups$/.test(url.pathname) && allowTestAuth ? permissionEntities['channel-groups']
      : /^\/api\/servers\/\d+\/vs\/\d+\/channels$/.test(url.pathname) && allowTestAuth ? permissionEntities.channels
      : /^\/api\/servers\/\d+\/vs\/\d+\/clients\/database$/.test(url.pathname) && allowTestAuth ? permissionEntities.database
      : /^\/api\/servers\/\d+\/vs\/\d+\/clients$/.test(url.pathname) && allowTestAuth
        ? (dataTableScenario === 'normal' ? permissionEntities.clients : dataTableRows(dataTableClients))
      : /^\/api\/servers\/\d+\/vs\/\d+\/complaints$/.test(url.pathname) && allowTestAuth
        ? dataTableRows(dataTableComplaints)
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
    const botUpdate = url.pathname.match(/^\/api\/bots\/(\d+)$/) && req.method === 'PUT' && allowTestAuth;
    if (botUpdate) {
      const id = Number(url.pathname.split('/').pop());
      const body = await readJson(req);
      botUpdateRequests.push(body);
      if (botScenario === 'slow-save') await new Promise(resolve => setTimeout(resolve, 600));
      if (botScenario === 'failed-save') { res.statusCode = 503; res.end('{"error":"Bot save rejected"}'); return; }
      const index = bots.findIndex((item) => item.id === id);
      if (index >= 0) bots[index] = { ...bots[index], ...body, flowData: body.flowData || bots[index].flowData, updatedAt: new Date().toISOString() };
      res.end(JSON.stringify(bots[index]));
      return;
    }
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
