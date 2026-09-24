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
let adminActionScenario = 'normal';
let adminActionRequests = [];
let virtualServerListRequests = 0;
let channelScenario = 'normal';
let channelsEnabled = false;
let channelRequests = [];
let iptvScenario = 'empty';
let docsScenario = false;
let logsScenario = 'normal';
let logsRequests = [];
let channelRows = [
  { cid: '1', pid: '0', channel_name: 'Lobby', channel_topic: '', total_clients: '1', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec_quality: '7', channel_icon_id: '0' },
  { cid: '2', pid: '1', channel_name: 'Support', channel_topic: '', total_clients: '1', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec_quality: '7', channel_icon_id: '0' },
  { cid: '3', pid: '2', channel_name: 'Nested support', channel_topic: '', total_clients: '0', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec_quality: '7', channel_icon_id: '0' },
  { cid: '4', pid: '0', channel_name: 'Diagnostics', channel_topic: '', total_clients: '0', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec_quality: '7', channel_icon_id: '0' },
];
const channelClients = [
  { clid: 101, cid: 1, client_nickname: 'Alice', client_type: 0, client_away: 0, client_input_hardware: 1, client_output_hardware: 1 },
  { clid: 102, cid: 1, client_nickname: 'serveradmin', client_type: 1, client_away: 0, client_input_hardware: 1, client_output_hardware: 1 },
  { clid: 103, cid: 1, client_nickname: 'TS6-WebUI Query', client_type: 1, client_away: 0, client_input_hardware: 1, client_output_hardware: 1 },
  { clid: 104, cid: 2, client_nickname: 'Music Bot', client_type: 0, client_away: 0, client_input_hardware: 1, client_output_hardware: 1 },
];
let testRole = 'admin';
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

const docsBots = [
  {
    id: 1,
    name: 'Welcome & Support Router',
    description: 'Greets new visitors and routes support requests.',
    enabled: true,
    serverConfigId: 1,
    virtualServerId: 1,
    flowData: {
      nodes: [
        { id: 'join', type: 'trigger_event', label: 'Client Joined', config: { eventName: 'notifycliententerview' }, x: 40, y: 120 },
        { id: 'needs-help', type: 'condition', label: 'Needs Help?', config: { expression: 'event.channel_id == 2' }, x: 270, y: 120 },
        { id: 'welcome', type: 'action_message', label: 'Send Welcome', config: { message: 'Welcome to the demo server!' }, x: 510, y: 40 },
        { id: 'delay', type: 'delay', label: 'Brief Delay', config: { seconds: 2 }, x: 510, y: 220 },
        { id: 'support-log', type: 'log', label: 'Log Support Visit', config: { message: 'Support visitor greeted' }, x: 750, y: 40 },
        { id: 'general-log', type: 'log', label: 'Log General Visit', config: { message: 'General visitor joined' }, x: 750, y: 220 },
      ],
      edges: [
        { id: 'join-condition', source: 'join', sourcePort: 'out', target: 'needs-help', targetPort: 'in' },
        { id: 'condition-welcome', source: 'needs-help', sourcePort: 'true', target: 'welcome', targetPort: 'in' },
        { id: 'condition-delay', source: 'needs-help', sourcePort: 'false', target: 'delay', targetPort: 'in' },
        { id: 'welcome-log', source: 'welcome', sourcePort: 'out', target: 'support-log', targetPort: 'in' },
        { id: 'delay-log', source: 'delay', sourcePort: 'out', target: 'general-log', targetPort: 'in' },
      ],
    },
    updatedAt: '2026-09-21T00:00:00.000Z',
  },
];

const docsMusicBots = [
  {
    id: 7,
    name: 'Aurora Radio',
    serverConfigId: 1,
    serverConfig: { id: 1, name: 'Demo Voice Lab', host: 'demo.invalid' },
    nickname: 'Aurora DJ',
    serverPassword: null,
    defaultChannel: 'Music Lounge',
    commandChannelIds: ['5'],
    virtualServerId: 1,
    channelPassword: null,
    voicePort: 9987,
    volume: 62,
    autoStart: true,
    status: 'playing',
    nowPlaying: { id: 'demo-track-1', title: 'Neon Skyline', artist: 'Demo Ensemble', duration: 248, source: 'local' },
    createdAt: '2026-09-20T00:00:00.000Z',
  },
];

const docsPlaybackState = {
  status: 'playing',
  nowPlaying: { id: 'demo-track-1', title: 'Neon Skyline', artist: 'Demo Ensemble', duration: 248, source: 'local' },
  position: 96,
  duration: 248,
  volume: 62,
  queue: [
    { id: 'demo-track-2', title: 'Morning Circuit', artist: 'Sample Collective', duration: 213, source: 'local' },
    { id: 'demo-track-3', title: 'Quiet Orbit', artist: 'Studio Fixtures', duration: 187, source: 'local' },
    { id: 'demo-track-4', title: 'Northern Lights', artist: 'Demo Ensemble', duration: 242, source: 'local' },
  ],
  currentIndex: 0,
  shuffle: false,
  repeat: 'queue',
  isStreaming: false,
};

const docsIptvChannels = [
  { id: 501, playlistId: 41, name: 'Community News', url: 'https://media.example.test/live/community-news.m3u8', logo: null, groupTitle: 'Community', tvgId: 'demo-news', position: 1 },
  { id: 502, playlistId: 41, name: 'Local Events', url: 'https://media.example.test/live/local-events.m3u8', logo: null, groupTitle: 'Community', tvgId: 'demo-events', position: 2 },
  { id: 503, playlistId: 41, name: 'Science Lab', url: 'https://media.example.test/live/science-lab.m3u8', logo: null, groupTitle: 'Learning', tvgId: 'demo-science', position: 3 },
  { id: 504, playlistId: 41, name: 'History Workshop', url: 'https://media.example.test/live/history-workshop.m3u8', logo: null, groupTitle: 'Learning', tvgId: 'demo-history', position: 4 },
  { id: 505, playlistId: 41, name: 'Ambient Sessions', url: 'https://media.example.test/live/ambient-sessions.m3u8', logo: null, groupTitle: 'Music', tvgId: 'demo-ambient', position: 5 },
  { id: 506, playlistId: 41, name: 'Demo Concert Hall', url: 'https://media.example.test/live/concert-hall.m3u8', logo: null, groupTitle: 'Music', tvgId: 'demo-concert', position: 6 },
];

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

const initialVirtualServers = {
  1: [
    { virtualserver_id: 1, virtualserver_name: 'Operations Voice', virtualserver_status: 'online', virtualserver_clientsonline: 18, virtualserver_queryclientsonline: 1, virtualserver_maxclients: 32, virtualserver_port: 9987, virtualserver_uptime: 183845 },
    { virtualserver_id: 11, virtualserver_name: 'Operations Staging', virtualserver_status: 'online', virtualserver_clientsonline: 2, virtualserver_queryclientsonline: 0, virtualserver_maxclients: 16, virtualserver_port: 9988, virtualserver_uptime: 3600 },
  ],
  2: [
    { virtualserver_id: 2, virtualserver_name: 'Backup Voice', virtualserver_status: 'online', virtualserver_clientsonline: 1, virtualserver_queryclientsonline: 0, virtualserver_maxclients: 4, virtualserver_port: 9987, virtualserver_uptime: 95 },
    { virtualserver_id: 22, virtualserver_name: 'Backup Staging', virtualserver_status: 'online', virtualserver_clientsonline: 0, virtualserver_queryclientsonline: 0, virtualserver_maxclients: 8, virtualserver_port: 9988, virtualserver_uptime: 120 },
  ],
};
let virtualServers = structuredClone(initialVirtualServers);

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
    dataSource: {
      webquery: { status: 'current', fetchedAt: '2026-09-24T00:00:00.000Z' },
      metrics: { status: 'disabled' },
    },
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
    dataSource: {
      webquery: { status: 'current', fetchedAt: '2026-09-24T00:00:00.000Z' },
      metrics: { status: 'disabled' },
    },
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
      adminActionScenario = 'normal';
      adminActionRequests = [];
      virtualServerListRequests = 0;
      virtualServers = structuredClone(initialVirtualServers);
      channelScenario = 'normal';
      channelsEnabled = false;
      channelRequests = [];
      iptvScenario = 'empty';
      docsScenario = false;
      logsScenario = 'normal';
      logsRequests = [];
      channelRows = structuredClone([
        { cid: '1', pid: '0', channel_name: 'Lobby', channel_topic: '', total_clients: '1', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec_quality: '7', channel_icon_id: '0' },
        { cid: '2', pid: '1', channel_name: 'Support', channel_topic: '', total_clients: '1', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec_quality: '7', channel_icon_id: '0' },
        { cid: '3', pid: '2', channel_name: 'Nested support', channel_topic: '', total_clients: '0', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec_quality: '7', channel_icon_id: '0' },
        { cid: '4', pid: '0', channel_name: 'Diagnostics', channel_topic: '', total_clients: '0', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec_quality: '7', channel_icon_id: '0' },
      ]);
      testRole = 'admin';
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
    if (url.pathname === '/__test/admin-actions' && url.searchParams.has('scenario')) {
      adminActionScenario = url.searchParams.get('scenario') || 'normal';
      adminActionRequests = [];
    }
    if (url.pathname === '/__test/channels' && url.searchParams.has('scenario')) {
      channelScenario = url.searchParams.get('scenario') || 'normal';
      channelsEnabled = true;
      channelRequests = [];
    }
    if (url.pathname === '/__test/iptv' && url.searchParams.has('scenario')) {
      iptvScenario = url.searchParams.get('scenario') || 'empty';
    }
    if (url.pathname === '/__test/logs' && url.searchParams.has('scenario')) {
      logsScenario = url.searchParams.get('scenario') || 'normal';
      logsRequests = [];
    }
    if (url.pathname === '/__test/docs') {
      docsScenario = url.searchParams.has('on');
      bots = structuredClone(docsScenario ? docsBots : initialBots);
    }
    if (url.pathname === '/__test/auth' && url.searchParams.has('role')) {
      testRole = url.searchParams.get('role') === 'viewer' ? 'viewer' : 'admin';
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ mutations, dashboardScenario, dashboardRequests, permissionScenario, permissionRequests, botScenario, botUpdateRequests, adminActionScenario, adminActionRequests, virtualServerListRequests, channelScenario, channelRequests, logsScenario, logsRequests }));
    return;
  }
  if (/^\/(api|ws)(\/|$)/.test(url.pathname)) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') mutations++;
    if (unavailable) { res.writeHead(503); res.end('{"error":"unavailable"}'); return; }

    const clientAction = url.pathname.match(/^\/api\/servers\/(\d+)\/vs\/(\d+)\/clients\/(\d+)\/(kick|ban|poke)$/);
    const virtualServerAction = url.pathname.match(/^\/api\/servers\/(\d+)\/virtual-servers\/(\d+)\/(start|stop)$/);
    if (allowTestAuth && req.method === 'POST' && (clientAction || virtualServerAction)) {
      const match = clientAction || virtualServerAction;
      const action = match[4] || match[3];
      const body = await readJson(req);
      adminActionRequests.push({
        method: req.method,
        path: url.pathname,
        configId: Number(match[1]),
        sid: clientAction ? Number(match[2]) : Number(match[2]),
        targetId: clientAction ? Number(match[3]) : Number(match[2]),
        action,
        body,
      });
      if (adminActionScenario === `${action}-slow`) await new Promise(resolve => setTimeout(resolve, 1500));
      if (adminActionScenario === `${action}-failure`) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: `insufficient permission to ${action}`, details: 'Check the ServerQuery permission assigned to this account' }));
        return;
      }
      if (virtualServerAction) {
        const configId = Number(match[1]);
        const sid = Number(match[2]);
        virtualServers[configId] = (virtualServers[configId] || []).map(server => (
          server.virtualserver_id === sid
            ? { ...server, virtualserver_status: action === 'stop' ? 'offline' : 'online' }
            : server
        ));
      }
      res.end(JSON.stringify({ success: true }));
      return;
    }

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
        user: { id: 1, username: testRole, displayName: testRole === 'admin' ? 'Administrator' : 'Viewer', role: testRole },
      }
      : url.pathname === '/api/auth/login' ? { error: 'Invalid credentials' }
      : url.pathname === '/api/auth/me' && allowTestAuth ? {
        user: { id: 1, username: testRole, displayName: testRole === 'admin' ? 'Administrator' : 'Viewer', role: testRole },
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
      : url.pathname === '/api/iptv/playlists' && allowTestAuth
        ? (docsScenario || iptvScenario === 'populated' ? [{
            id: 41,
            name: docsScenario ? 'Demo Community Channels' : 'Local News & Events',
            sourceType: 'url',
            url: 'https://media.example.test/fixtures/community.m3u',
            originalFilename: null,
            serverConfigId: 1,
            autoRefreshMinutes: 30,
            lastRefreshedAt: '2026-09-21T01:23:45.000Z',
            lastError: null,
            channelCount: docsScenario ? docsIptvChannels.length : 1234,
            createdAt: '2026-09-20T00:00:00.000Z',
          }] : [])
      : /^\/api\/iptv\/playlists\/\d+\/groups$/.test(url.pathname) && allowTestAuth
        ? (docsScenario ? ['Community', 'Learning', 'Music'] : [])
      : /^\/api\/iptv\/playlists\/\d+\/channels$/.test(url.pathname) && allowTestAuth
        ? (docsScenario
            ? { total: docsIptvChannels.length, page: 1, pageSize: 24, channels: docsIptvChannels }
            : { total: 1234, page: 1, pageSize: 24, channels: [] })
      : url.pathname === '/api/music-bots' && allowTestAuth ? (docsScenario ? docsMusicBots : [])
      : url.pathname === '/api/music-bots/7/state' && allowTestAuth && docsScenario ? docsPlaybackState
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
        ? (() => {
            virtualServerListRequests++;
            if (dashboardScenario === 'no-selection') return [];
            const configId = Number(url.pathname.split('/')[3]);
            return virtualServers[configId] || [];
          })()
      : /^\/api\/servers\/\d+\/vs\/\d+\/permissions$/.test(url.pathname) && allowTestAuth ? permissionDefinitions
      : /^\/api\/servers\/\d+\/vs\/\d+\/server-groups$/.test(url.pathname) && allowTestAuth ? permissionEntities['server-groups']
      : /^\/api\/servers\/\d+\/vs\/\d+\/channel-groups$/.test(url.pathname) && allowTestAuth ? permissionEntities['channel-groups']
      : /^\/api\/servers\/\d+\/vs\/\d+\/channels$/.test(url.pathname) && allowTestAuth && channelsEnabled
        ? (() => {
            if (channelScenario === 'refresh-failure') {
              res.statusCode = 503;
              return { error: 'Channel refresh failed', details: 'The last successful channel tree is still available' };
            }
            return channelRows;
          })()
      : /^\/api\/servers\/\d+\/vs\/\d+\/channels\/\d+$/.test(url.pathname) && allowTestAuth && channelsEnabled
        ? channelRows.find((channel) => channel.cid === url.pathname.split('/').pop()) || { error: 'Channel not found' }
      : /^\/api\/servers\/\d+\/vs\/\d+\/clients$/.test(url.pathname) && allowTestAuth && channelsEnabled
        ? channelClients
      : /^\/api\/servers\/\d+\/vs\/\d+\/clients\/database$/.test(url.pathname) && allowTestAuth ? permissionEntities.database
      : /^\/api\/servers\/\d+\/vs\/\d+\/clients$/.test(url.pathname) && allowTestAuth
        ? (dataTableScenario === 'normal' ? permissionEntities.clients : dataTableRows(dataTableClients))
      : /^\/api\/servers\/\d+\/vs\/\d+\/complaints$/.test(url.pathname) && allowTestAuth
        ? dataTableRows(dataTableComplaints)
      : /^\/api\/servers\/(\d+)\/vs\/(\d+)\/logs$/.test(url.pathname) && allowTestAuth
        ? (() => {
            const match = url.pathname.match(/^\/api\/servers\/(\d+)\/vs\/(\d+)\/logs$/);
            const configId = Number(match[1]);
            const sid = Number(match[2]);
            const lines = Math.min(100, Math.max(1, Number(url.searchParams.get('lines') || 100) || 100));
            const instance = url.searchParams.get('instance') === '1';
            const beginPos = url.searchParams.get('begin_pos');
            logsRequests.push({
              configId,
              sid,
              lines,
              instance,
              beginPos: beginPos || null,
            });
            if (logsScenario === 'initial-failure') {
              res.statusCode = 503;
              return { error: 'TeamSpeak logview unavailable', details: 'WebQuery logview timed out' };
            }
            if (logsScenario === 'refresh-failure') {
              res.statusCode = 503;
              return { error: 'Log refresh failed', details: 'The last successful page is still available' };
            }
            const vsRows = Array.from({ length: 120 }, (_, index) => {
              const lastPos = String(1200 - index);
              if (index === 0) {
                return { lastPos, sourceText: '2026-03-15 12:00:05.123456|INFO    |VirtualServer |1  |Virtual server started successfully.' };
              }
              if (index === 1) {
                return { lastPos, sourceText: '2026-03-15 12:00:04.123456|WARNING |VirtualServer |1  |Client Sample User connected.' };
              }
              if (index === 2) {
                return { lastPos, sourceText: '2026-03-15 12:00:03.123456|ERROR   |VirtualServer |1  |Failed to open channel file transfer.' };
              }
              if (index === 3) {
                return { lastPos, sourceText: '2026-03-15 12:00:02.123456|DEBUG   |VirtualServer |1  |Permission cache refreshed.' };
              }
              if (index === 4) {
                return { lastPos, sourceText: 'not a structured line — Unicode ✓ and a very long path /var/log/teamspeak/virtualserver_1.log that must wrap without overflowing the page on narrow screens' };
              }
              if (index === 5) {
                return { lastPos, sourceText: '2026-03-15 12:00:00.000000|NOTICE  |VirtualServer |1  |Unrecognized level stays Unknown.' };
              }
              return {
                lastPos,
                sourceText: `2026-03-14 12:00:00.000000|INFO    |VirtualServer |1  |Older fixture row ${index}`,
              };
            });
            const instanceRows = [
              { lastPos: '300', sourceText: '2026-03-15 11:59:00.000000|INFO    |ServerLibPriv |   |TeamSpeak instance started.' },
              { lastPos: '200', sourceText: '2026-03-15 11:58:00.000000|WARNING |Accounting    |   |License check deferred.' },
              { lastPos: '100', sourceText: '2026-03-15 11:57:00.000000|INFO    |Query         |   |WebQuery listener ready.' },
            ];
            let rows = instance ? instanceRows : vsRows;
            if (beginPos && /^\d+$/.test(beginPos)) {
              const cursor = BigInt(beginPos);
              rows = rows.filter((row) => BigInt(row.lastPos) < cursor);
            }
            if (logsScenario === 'empty') rows = [];
            const pageRows = rows.slice(0, lines);
            const hasMore = rows.length > pageRows.length;
            const nextBeginPos = hasMore && pageRows.length
              ? pageRows[pageRows.length - 1].lastPos
              : null;
            return {
              entries: pageRows.map((row) => ({ sourceText: row.sourceText, lastPos: row.lastPos })),
              context: {
                configId,
                sid,
                instance,
                reverse: true,
                lines,
                beginPos: beginPos || null,
              },
              fetchedAt: '2026-09-24T12:00:00.000Z',
              fileSize: instance ? '300' : '500',
              nextBeginPos,
            };
          })()
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
            if (dashboardScenario === 'long-name') {
              return {
                ...base,
                serverName: 'Operations Voice with an intentionally long server name that must wrap without overflowing the page header',
              };
            }
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
    const channelMove = url.pathname.match(/^\/api\/servers\/(\d+)\/vs\/(\d+)\/channels\/(\d+)\/move$/) && req.method === 'POST' && allowTestAuth && channelsEnabled;
    if (channelMove) {
      const [, configId, sid, cid] = url.pathname.match(/^\/api\/servers\/(\d+)\/vs\/(\d+)\/channels\/(\d+)\/move$/);
      const body = await readJson(req);
      channelRequests.push({ method: req.method, configId: Number(configId), sid: Number(sid), cid: Number(cid), body });
      if (channelScenario === 'move-failure') { res.statusCode = 503; res.end('{"error":"TeamSpeak rejected this channel move"}'); return; }
      const channel = channelRows.find((row) => row.cid === cid);
      if (channel) channel.pid = String(body.cpid);
      res.end('{"success":true}');
      return;
    }
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
