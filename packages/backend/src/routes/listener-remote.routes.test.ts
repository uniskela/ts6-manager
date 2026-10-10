import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import express from 'express';
import { listenerRemoteAdminRoutes, listenerRemoteRoutes, listenerRemoteIpGuard } from './listener-remote.routes.js';
import { ListenerRemoteService } from '../voice/listener-remote.js';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { PlayQueue, type QueueItem } from '../voice/playlist/queue.js';

const binding = { botId: 4, serverConfigId: 2, virtualServerId: 3, channelId: 8, clid: 9, uid: 'listener-secret-identity' };
const mediaUrl = 'https://8.8.8.8/media?id=secret-request';
const item: QueueItem = {
  id: 'song-11', title: 'Visible title', artist: 'Visible artist', duration: 123,
  filePath: '/private/music/credential.mp3', source: 'url', sourceUrl: mediaUrl,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(role?: 'admin' | 'viewer' | 'operator', fullApp = false) {
  let now = 1_000_000;
  const remote = new ListenerRemoteService(() => now);
  const queue = new PlayQueue();
  queue.add(item);
  const state = {
    uid: binding.uid, channelId: binding.channelId, groups: '7',
    policy: null as string | null, botChannel: binding.channelId,
    botServer: binding.serverConfigId, databaseServer: binding.serverConfigId,
    virtualServer: binding.virtualServerId, botStatus: 'playing',
    missingSong: false, failAudit: false,
  };
  const audit: Record<string, unknown>[] = [];
  const songQueries: unknown[] = [];
  const settingQueries: unknown[] = [];
  let downloads = 0;
  const bot = {
    currentConfig: { serverConfigId: binding.serverConfigId, name: 'Music bot', password: 'bot-secret' },
    ts3ClientId: 99,
    get status() { return state.botStatus; },
    getCurrentChannelId: () => state.botChannel,
    nowPlaying: item, queue,
  };
  Object.defineProperty(bot.currentConfig, 'serverConfigId', { get: () => state.botServer });
  const app = fullApp ? (await import('../app.js')).createApp() : express();
  app.set('trust proxy', false);
  if (!fullApp) app.use(express.json());
  app.locals.listenerRemote = remote;
  app.locals.voiceBotManager = { getBot: () => bot, getBotsForServer: async () => [{ bot }] };
  app.locals.eventBridge = { executeCommand: async (server: number, virtualServer: number, cmd: string) => {
    assert.equal(server, binding.serverConfigId);
    assert.equal(virtualServer, binding.virtualServerId);
    if (cmd.startsWith('clientinfo')) {
      return `client_unique_identifier=${state.uid} client_servergroups=${state.groups} client_type=0\nerror id=0 msg=ok`;
    }
    assert.equal(cmd, 'clientlist -uid');
    return `clid=${binding.clid} cid=${state.channelId} client_unique_identifier=${state.uid} client_type=0\nerror id=0 msg=ok`;
  } };
  app.locals.prisma = {
    appSetting: { findUnique: async (query: unknown) => {
      settingQueries.push(query);
      return state.policy === null ? null : { value: state.policy };
    } },
    musicBot: { findUnique: async () => ({ serverConfigId: state.databaseServer, virtualServerId: state.virtualServer }) },
    song: {
      findMany: async (query: unknown) => {
        songQueries.push(query);
        return [{ id: 11, title: item.title, artist: item.artist, duration: item.duration }];
      },
      findFirst: async (query: unknown) => {
        songQueries.push(query);
        return state.missingSong ? null : { ...item, id: 11 };
      },
    },
    adminAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.failAudit) throw new Error('db-credential-must-not-leak');
        audit.push(data);
        return { id: 'audit-event' };
      },
      updateMany: async (query: Record<string, unknown>) => { audit.push(query); return { count: 1 }; },
    },
  };
  app.locals.mediaUrlPipelineDeps = {
    resolveSpotify: async (url: string) => url,
    resolveAppleMusic: async () => ({ tracks: [] }),
    resolveSpotifyCollection: async () => null,
    appleTrackToYouTube: async () => null,
    expandYouTube: async () => null,
    downloadTrack: async () => { downloads++; return item; },
  };
  if (!fullApp) app.use('/api/listener-remote', listenerRemoteIpGuard, listenerRemoteRoutes);
  if (!fullApp) app.use('/api/listener-remote-admin', (req, _res, next) => {
    if (role) (req as any).user = { id: 1, username: 'administrator', role };
    next();
  }, listenerRemoteAdminRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, options: { method?: string; body?: unknown; rawBody?: string; session?: string; headers?: Record<string, string>; admin?: boolean } = {}) => fetch(`${base}/listener-remote${options.admin ? '-admin' : ''}${path}`, {
    method: options.method ?? (options.body === undefined && options.rawBody === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined && options.rawBody === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.session ? { Authorization: `Bearer ${options.session}` } : {}), ...options.headers,
    },
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const exchange = async () => {
    const issued = remote.issue(binding);
    const response = await request('/exchange', { body: { token: issued.token } });
    assert.equal(response.status, 200);
    const data = await response.json() as { session: string; expiresAt: string; botId: number };
    return { ...data, token: issued.token };
  };
  return {
    remote, request, exchange, queue, app, state, audit, songQueries, settingQueries,
    get downloads() { return downloads; }, advance: (ms: number) => { now += ms; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
      server.closeAllConnections();
    }),
  };
}

function restrict(f: Awaited<ReturnType<typeof fixture>>, groups: number[] = []) {
  f.state.policy = JSON.stringify({ ...defaultMediaCommandPermissions(), queue: { mode: 'server_groups', serverGroupIds: groups } });
}

async function using(fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, role?: 'admin' | 'viewer' | 'operator') {
  const f = await fixture(role);
  try { await fn(f); } finally { await f.close(); }
}

describe('listener remote HTTP security boundary', () => {
  it('exchanges a private credential once, with no identity in the response and no cache/referrer leakage', async () => using(async f => {
    const token = f.remote.issue(binding).token;
    const responses = await Promise.all([
      f.request('/exchange', { body: { token } }), f.request('/exchange', { body: { token } }),
    ]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
    const success = responses.find(r => r.status === 200)!;
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.equal(success.headers.get('referrer-policy'), 'no-referrer');
    const data = await success.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), ['botId', 'expiresAt', 'session']);
    assert.equal(data.botId, binding.botId);
    assert.match(String(data.session), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(data).includes(binding.uid));
    assert.equal((await f.request('/exchange', { body: { token } })).status, 401);
  }));

  it('projects safe state and library fields without paths, source URLs or bot configuration', async () => using(async f => {
    const { session } = await f.exchange();
    const response = await f.request('/state', { session });
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.deepEqual(data.nowPlaying, { id: item.id, title: item.title, artist: item.artist, duration: item.duration });
    assert.deepEqual(data.upNext, [data.nowPlaying]);
    assert.deepEqual(data.bot, { id: binding.botId, name: 'Music bot', status: 'playing' });
    for (const secret of [item.filePath, item.sourceUrl!, binding.uid, 'bot-secret', session]) {
      assert.ok(!JSON.stringify(data).includes(secret));
    }
    const library = await f.request('/library?search=Visible&page=2', { session });
    assert.equal(library.status, 200);
    const songs = await library.json() as any;
    assert.equal(songs.pageSize, 25);
    assert.deepEqual(f.songQueries[0], {
      where: { serverConfigId: 2, OR: [{ title: { contains: 'Visible' } }, { artist: { contains: 'Visible' } }] },
      select: { id: true, title: true, artist: true, duration: true }, orderBy: { id: 'asc' }, skip: 25, take: 25,
    });
  }));

  it('applies the scoped shared policy to every read and write, and reflects subsequent policy changes', async () => using(async f => {
    const { session } = await f.exchange();
    restrict(f, [7]);
    assert.equal((await f.request('/queue', { session, body: { songId: 11 } })).status, 200);
    restrict(f, [8]);
    for (const [path, body] of [['/queue', { songId: 11 }], ['/requests', { url: mediaUrl }]] as const) {
      assert.equal((await f.request(path, { session, body })).status, 403);
    }
    const restrictedState = await f.request('/state', { session });
    assert.equal(restrictedState.status, 200);
    assert.deepEqual((await restrictedState.json() as any).permissions, { searchLibrary: true, addToQueue: false, requestUrl: false });
    assert.equal((await f.request('/library', { session })).status, 200);
    assert.equal(f.queue.length, 2);
    assert.equal(f.downloads, 0);
    assert.ok(f.settingQueries.length > 0);
    for (const query of f.settingQueries) assert.deepEqual(query, { where: { key: 'media_command_permissions:2:3' } });
    f.state.policy = '{malformed';
    assert.equal((await f.request('/queue', { session, body: { songId: 11 } })).status, 403);
  }));

  it('scopes song lookup to the bound server and refuses missing or foreign songs', async () => using(async f => {
    const { session } = await f.exchange();
    f.state.missingSong = true;
    assert.equal((await f.request('/queue', { session, body: { songId: 22 } })).status, 404);
    assert.deepEqual(f.songQueries, [{ where: { id: 22, serverConfigId: 2 } }]);
    assert.equal(f.queue.length, 1);
    assert.ok(f.audit.some(row => (row.data as any)?.outcome === 'failure'));
  }));

  it('revokes access on live channel departure, identity reuse, bot movement or scope change', async () => {
    const changes = [
      { channelId: 10 }, { uid: 'different-uid' }, { botChannel: 10 },
      { botServer: 5 }, { databaseServer: 5 }, { virtualServer: 6 }, { botStatus: 'disconnected' },
    ];
    for (const change of changes) await using(async f => {
      const { session } = await f.exchange();
      Object.assign(f.state, change);
      assert.equal((await f.request('/state', { session })).status, 401, JSON.stringify(change));
      // Returning to the channel cannot resurrect the departed session.
      Object.assign(f.state, { channelId: 8, uid: binding.uid, botChannel: 8, botServer: 2, databaseServer: 2, virtualServer: 3, botStatus: 'playing' });
      assert.equal((await f.request('/state', { session })).status, 401);
    });
  });

  it('expires sessions, supports explicit logout and does not authorize administration with listener credentials', async () => {
    await using(async f => {
      const { session } = await f.exchange();
      assert.equal((await f.request('/bots/4/revoke', { admin: true, session, body: {} })).status, 401);
      assert.equal((await f.request('/session', { method: 'DELETE', session })).status, 200);
      assert.equal((await f.request('/state', { session })).status, 401);
    });
    await using(async f => {
      const { session } = await f.exchange();
      f.advance(15 * 60_000 + 1);
      assert.equal((await f.request('/state', { session })).status, 401);
    });
    for (const role of ['viewer', 'operator'] as const) await using(async f => {
      const { session } = await f.exchange();
      assert.equal((await f.request('/bots/4/revoke', { admin: true, session, body: {} })).status, 403);
      assert.equal((await f.request('/state', { session })).status, 200);
    }, role);
  });

  it('allows audited admin revocation of one listener and all listeners of a bot', async () => using(async f => {
    const first = await f.exchange();
    const otherBinding = { ...binding, uid: 'other-listener', clid: 10 };
    const otherToken = f.remote.issue(otherBinding).token;
    const response = await f.request('/bots/4/revoke', { admin: true, body: { uid: binding.uid } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revoked: 1 });
    assert.equal((await f.request('/state', { session: first.session })).status, 401);
    assert.equal((await f.request('/bots/4/revoke', { admin: true, body: {} })).status, 200);
    assert.equal((await f.request('/exchange', { body: { token: otherToken } })).status, 401);
    assert.ok(f.audit.some(row => row.action === 'listener.remote.revoke'));
    assert.ok(!JSON.stringify(f.audit).includes(binding.uid));
  }, 'admin'));

  it('rejects SSRF destinations and embedded credentials before resolving or downloading', async () => {
    const urls = [
      'http://127.0.0.1/media', 'http://localhost/media', 'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/media', 'http://[::1]/media', 'http://[fe80::1]/media',
      'https://user:secret@8.8.8.8/media', 'file:///private/music',
    ];
    for (const url of urls) await using(async f => {
      const { session } = await f.exchange();
      assert.equal((await f.request('/requests', { session, body: { url } })).status, 400, url);
      assert.equal(f.downloads, 0);
      assert.equal(f.queue.length, 1);
      assert.ok(f.audit.some(row => (row.data as any)?.outcome === 'failure'));
    });
  });

  it('sanitizes resolver and audit-storage failures, and records successful actions without credential material', async () => using(async f => {
    const { session, token } = await f.exchange();
    let attempts = 0;
    f.app.locals.mediaUrlPipelineDeps.downloadTrack = async () => { attempts++; throw new Error(`resolver credential ${token} ${mediaUrl}`); };
    const failed = await f.request('/requests', { session, body: { url: mediaUrl } });
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'Listener remote is unavailable.', code: 'unavailable' });
    assert.ok(f.audit.some(row => (row.data as any)?.outcome === 'failure'));
    f.state.failAudit = true;
    const auditBlocked = await f.request('/requests', { session, body: { url: mediaUrl } });
    assert.equal(auditBlocked.status, 503);
    assert.equal(attempts, 1);
    const unavailable = await f.request('/queue', { session, body: { songId: 11 } });
    assert.equal(unavailable.status, 503);
    assert.ok(!(await unavailable.text()).includes('db-credential'));
    assert.equal(f.queue.length, 1);
    f.state.failAudit = false;
    f.app.locals.mediaUrlPipelineDeps.downloadTrack = async () => item;
    assert.equal((await f.request('/requests', { session, body: { url: mediaUrl } })).status, 200);
    assert.equal(f.queue.length, 2);
    assert.equal(f.audit[0].action, 'listener.remote.request');
    assert.equal(f.audit[0].actorUsername, `listener:${createHash('sha256').update(binding.uid).digest('hex')}`);
    const encoded = JSON.stringify(f.audit);
    for (const secret of [session, token, mediaUrl, binding.uid, item.filePath]) assert.ok(!encoded.includes(secret));
    assert.ok(f.audit.some(row => (row.data as any)?.outcome === 'success'));
  }));

  it('rechecks revocation, departure and permissions after an asynchronous download before queue insertion', async () => {
    for (const change of ['revoke', 'departure', 'policy'] as const) await using(async f => {
      const { session } = await f.exchange();
      const started = deferred<void>();
      const download = deferred<QueueItem>();
      f.app.locals.mediaUrlPipelineDeps.downloadTrack = () => { started.resolve(); return download.promise; };
      const pending = f.request('/requests', { session, body: { url: mediaUrl } });
      await started.promise;
      if (change === 'revoke') f.remote.revoke(binding.botId, binding.uid);
      if (change === 'departure') f.state.channelId = 10;
      if (change === 'policy') restrict(f);
      download.resolve(item);
      assert.equal((await pending).status, change === 'policy' ? 403 : 401);
      assert.equal(f.queue.length, 1, change);
      assert.ok(!f.audit.some(row => (row.data as any)?.outcome === 'success'));
    });
  });

  it('strictly validates input and never accepts browser-supplied identity, scope, membership or URL fields', async () => using(async f => {
    const { session, token } = await f.exchange();
    const attempts = [
      ['/exchange', { token, uid: binding.uid }], ['/queue', { songId: '11' }], ['/queue', { songId: -1 }],
      ['/queue', { songId: 11, botId: 999 }], ['/queue', { songId: 11, serverGroupIds: [7] }],
      ['/requests', { url: mediaUrl, channelId: 8 }], ['/requests', { url: 'not a URL' }],
    ] as const;
    for (const [path, body] of attempts) assert.equal((await f.request(path, { session, body })).status, 400);
    for (const path of ['/library?page=0', '/library?page=1.5', '/library?serverConfigId=999', '/library?search=a&search=b']) {
      assert.equal((await f.request(path, { session })).status, 400);
    }
    assert.equal(f.queue.length, 1);
    assert.equal(f.audit.length, 0);
    assert.equal((await f.request('/state', { headers: { Authorization: 'Bearer malformed' } })).status, 401);
    assert.equal((await f.request(`/state?session=${session}`)).status, 401);
  }));

  it('mounts public exchange before JWT auth in the real app and sanitizes malformed or oversized JSON', async () => {
    const musicDir = await mkdtemp(join(tmpdir(), 'ts6-remote-test-'));
    const previousMusicDir = process.env.MUSIC_DIR;
    process.env.MUSIC_DIR = musicDir;
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(undefined, true);
      const { session, token } = await f.exchange();
      const state = await f.request('/state', { session });
      assert.equal(state.status, 200);
      assert.equal(state.headers.get('ratelimit-limit'), '120');
      assert.equal((await f.request('/bots/4/revoke', { admin: true, session, body: {} })).status, 401);
      let remaining = 0;
      for (const rawBody of [`{"token":"${token}"`, JSON.stringify({ token, padding: 'x'.repeat(5000) })]) {
        const response = await f.request('/exchange', { rawBody });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { error: 'Invalid listener request.', code: 'invalid_request' });
        remaining = Number(response.headers.get('ratelimit-remaining'));
      }
      assert.equal(f.queue.length, 1);
      assert.equal(f.audit.length, 0);
      // Advance only the credential clock to exercise Express's limiter independently.
      f.advance(60_001);
      const endpoints = [['/state', 'GET'], ['/library', 'GET'], ['/queue', 'POST'], ['/requests', 'POST'], ['/session', 'DELETE']];
      for (let n = 0; n < remaining; n++) {
        const [path, method] = endpoints[n % endpoints.length];
        const response = await f.request(path, { method });
        assert.notEqual(response.status, 429);
      }
      for (const [path, method] of endpoints) {
        const response = await f.request(path, { method, headers: { 'X-Forwarded-For': '203.0.113.42' } });
        assert.equal(response.status, 429);
        const retryAfter = Number(response.headers.get('retry-after'));
        assert.ok(retryAfter > 0 && retryAfter <= 60);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        if (path === '/state') assert.equal(response.headers.get('ratelimit-remaining'), '0');
        assert.deepEqual(await response.json(), { error: 'Too many remote requests', code: 'rate_limited' });
      }
    } finally {
      await f?.close();
      if (previousMusicDir === undefined) delete process.env.MUSIC_DIR;
      else process.env.MUSIC_DIR = previousMusicDir;
      await rm(musicDir, { recursive: true, force: true });
    }
  });

  it('limits expensive URL requests per session before resolution and resets the quota after one minute', async () => using(async f => {
    const { session } = await f.exchange();
    for (let n = 0; n < 5; n++) {
      assert.equal((await f.request('/requests', { session, body: { url: mediaUrl } })).status, 200);
    }
    assert.equal(f.downloads, 5);
    const limited = await f.request('/requests', { session, body: { url: mediaUrl } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(f.downloads, 5);
    assert.equal(f.queue.length, 6);
    f.advance(60_001);
    assert.equal((await f.request('/requests', { session, body: { url: mediaUrl } })).status, 200);
    assert.equal(f.downloads, 6);
  }));

  it('limits exchange IPs using the transport peer, ignoring spoofed forwarding headers by default', async () => using(async f => {
    for (let n = 0; n < 10; n++) {
      const response = await f.request(n % 2 ? '/EXCHANGE' : '/exchange/', { body: { token: String(n).repeat(43) }, headers: { 'X-Forwarded-For': `203.0.113.${n + 1}` } });
      assert.notEqual(response.status, 429);
    }
    const limited = await f.request('/exchange', { body: { token: 'B'.repeat(43) }, headers: { 'X-Forwarded-For': '198.51.100.42' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(f.queue.length, 1);
  }));

  it('bounds concurrent URL work per bot and releases the slot after failure', async () => using(async f => {
    const { session } = await f.exchange();
    const started = deferred<void>();
    const download = deferred<QueueItem>();
    f.app.locals.mediaUrlPipelineDeps.downloadTrack = () => { started.resolve(); return download.promise; };
    const first = f.request('/requests', { session, body: { url: mediaUrl } });
    await started.promise;
    assert.equal((await f.request('/requests', { session, body: { url: mediaUrl } })).status, 429);
    download.resolve(item);
    assert.equal((await first).status, 200);
    f.app.locals.mediaUrlPipelineDeps.downloadTrack = async () => { throw new Error('resolver failed'); };
    assert.equal((await f.request('/requests', { session, body: { url: mediaUrl } })).status, 503);
    f.app.locals.mediaUrlPipelineDeps.downloadTrack = async () => item;
    assert.equal((await f.request('/requests', { session, body: { url: mediaUrl } })).status, 200);
  }));
});
