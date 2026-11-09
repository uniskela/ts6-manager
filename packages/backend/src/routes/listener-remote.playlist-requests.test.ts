import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import express from 'express';
import { DEFAULT_PLAYLIST_VOTE_SETTINGS } from '@ts6/common';
import { listenerRemoteRoutes, listenerRemoteIpGuard } from './listener-remote.routes.js';
import { ListenerRemoteService } from '../voice/listener-remote.js';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { MusicCommandHandler, resetChatReplyCooldownsForTests } from '../voice/music-command-handler.js';
import { PlayQueue, type QueueItem } from '../voice/playlist/queue.js';
import { playlistVoteSettingsKey } from '../voice/playlist-vote-settings.js';
import { bindPlaylistVoteLifecycle } from '../voice/playlist-vote/lifecycle.js';
import { PlaylistVoteRuntime } from '../voice/playlist-vote/runtime.js';
import { BOT_COOLDOWN_MS } from '../voice/playlist-vote/state-machine.js';

async function assertOk(response: Response, label = 'response'): Promise<void> {
  if (response.status === 200) return;
  assert.fail(`${label} ${response.status}: ${await response.text()}`);
}

const binding = { botId: 4, serverConfigId: 2, virtualServerId: 3, channelId: 8, clid: 9, uid: 'listener-secret-identity' };
const peer = { clid: 10, uid: 'other-listener-uid' };

type PlaylistRow = {
  id: number;
  name: string;
  remoteAccess: 'hidden' | 'browse' | 'request';
  serverConfigId: number | null;
  songs: Array<{
    id: number;
    position: number;
    song: {
      id: number;
      title: string;
      artist: string | null;
      duration: number | null;
      filePath: string;
      source: string;
      sourceUrl: string | null;
      serverConfigId: number;
    };
  }>;
};

function song(id: number, serverConfigId = 2): PlaylistRow['songs'][number]['song'] {
  return {
    id, title: `Song ${id}`, artist: `Artist ${id}`, duration: 30,
    filePath: `/secret/${id}.mp3`, source: 'local', sourceUrl: null, serverConfigId,
  };
}

function link(id: number, position: number, track: PlaylistRow['songs'][number]['song']): PlaylistRow['songs'][number] {
  return { id, position, song: track };
}

async function fixture(opts: { peers?: Array<{ clid: number; uid: string }> } = {}) {
  resetChatReplyCooldownsForTests();
  // Separate clocks so session TTL can elapse without forcing the 60s vote window closed.
  let voteNow = 1_700_000_000_000;
  let remoteNow = 1_700_000_000_000;
  const remote = new ListenerRemoteService(() => remoteNow);
  const queue = new PlayQueue();
  let peers = [...(opts.peers ?? [])];
  const privateReplies: string[] = [];
  const state = {
    uid: binding.uid, channelId: binding.channelId, groups: '7',
    policy: null as string | null, botChannel: binding.channelId,
    botServer: binding.serverConfigId, databaseServer: binding.serverConfigId,
    virtualServer: binding.virtualServerId, botStatus: 'playing' as string,
    voteSettings: null as string | null,
    /** Fail clientlist (electorate) while auth still uses clientinfo. */
    failElectorate: false,
  };
  let clientlistCalls = 0;
  const playlists = new Map<number, PlaylistRow>();
  const seed = (row: PlaylistRow) => { playlists.set(row.id, row); return row; };
  const audit: Array<{ action: string }> = [];
  const historyWrites: Array<{ create?: { url?: string; title?: string; musicBotId?: number } }> = [];
  /** Next playlist findFirst parks until `releasePlaylistReadGate` (deferred restash). */
  let deferNextPlaylistRead = false;
  let playlistReadWait: Promise<void> | null = null;
  let releasePlaylistReads: (() => void) | null = null;
  let signalPlaylistReadEntered: (() => void) | null = null;
  let playlistReadEntered: Promise<void> | null = null;
  const armPlaylistReadGate = () => {
    deferNextPlaylistRead = true;
    playlistReadEntered = new Promise<void>((resolve) => { signalPlaylistReadEntered = resolve; });
    playlistReadWait = new Promise<void>((resolve) => { releasePlaylistReads = resolve; });
  };
  const waitPlaylistReadEntered = () => {
    assert.ok(playlistReadEntered, 'armPlaylistReadGate first');
    return playlistReadEntered;
  };
  const releasePlaylistReadGate = () => {
    releasePlaylistReads?.();
    releasePlaylistReads = null;
    playlistReadWait = null;
    deferNextPlaylistRead = false;
  };

  const clientlistBody = () => {
    if (state.channelId !== binding.channelId) return 'error id=0 msg=ok';
    const rows = [
      `clid=${binding.clid} cid=${binding.channelId} client_unique_identifier=${binding.uid} client_type=0`,
      ...peers.map((p) => `clid=${p.clid} cid=${binding.channelId} client_unique_identifier=${p.uid} client_type=0`),
    ];
    return `${rows.join('|')}\nerror id=0 msg=ok`;
  };

  const bot: any = {
    currentConfig: { id: binding.botId, serverConfigId: binding.serverConfigId, name: 'Music bot', password: 'bot-secret' },
    ts3ClientId: 99, stopGeneration: 0,
    get status() { return state.botStatus; },
    set status(value: string) { state.botStatus = value; },
    getCurrentChannelId: () => state.botChannel,
    nowPlaying: null as QueueItem | null,
    queue,
    videoSessionInfo: () => null,
    floodHoldActive: false,
    noteIgnoredCommand: () => undefined,
    sendTextMessage: (_clid: number, text: string) => { privateReplies.push(text); },
    play: async (item: QueueItem) => { bot.nowPlaying = item; state.botStatus = 'playing'; },
    playStream: async (item: QueueItem) => { bot.nowPlaying = item; state.botStatus = 'playing'; },
  };
  Object.defineProperty(bot.currentConfig, 'serverConfigId', { get: () => state.botServer });

  const runtime = new PlaylistVoteRuntime(() => bot);
  bindPlaylistVoteLifecycle(remote, runtime);
  const voiceBotManager = { getBot: () => bot, getBotsForServer: async () => [{ bot }] };
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.locals.listenerRemote = remote;
  app.locals.voiceBotManager = voiceBotManager;
  app.locals.playlistVotes = runtime;
  app.locals.playlistVoteClock = () => voteNow;
  app.locals.eventBridge = {
    executeCommand: async (server: number, virtualServer: number, cmd: string) => {
      assert.equal(server, binding.serverConfigId);
      assert.equal(virtualServer, binding.virtualServerId);
      if (cmd.startsWith('clientinfo')) {
        return `cid=${state.channelId} client_unique_identifier=${state.uid} client_servergroups=${state.groups} client_type=0\nerror id=0 msg=ok`;
      }
      assert.equal(cmd, 'clientlist -uid');
      clientlistCalls += 1;
      if (state.failElectorate) throw new Error('clientlist offline');
      return clientlistBody();
    },
  };
  app.locals.prisma = {
    appSetting: {
      findUnique: async ({ where: { key } }: { where: { key: string } }) => {
        if (key === playlistVoteSettingsKey(2, 3)) {
          return state.voteSettings === null ? null : { value: state.voteSettings };
        }
        if (key.startsWith('media_command_permissions:')) {
          return state.policy === null ? null : { value: state.policy };
        }
        return null;
      },
    },
    musicBot: { findUnique: async () => ({ serverConfigId: state.databaseServer, virtualServerId: state.virtualServer }) },
    playlist: {
      findFirst: async (query: { where: Record<string, unknown> }) => {
        if (deferNextPlaylistRead && playlistReadWait) {
          deferNextPlaylistRead = false;
          signalPlaylistReadEntered?.();
          signalPlaylistReadEntered = null;
          await playlistReadWait;
        }
        const id = query.where.id as number;
        const row = playlists.get(id);
        if (!row) return null;
        const access = query.where.remoteAccess as { in: string[] } | undefined;
        if (access && !access.in.includes(row.remoteAccess)) return null;
        const or = query.where.OR as Array<{ serverConfigId: number | null }> | undefined;
        if (or && !or.some((clause) => clause.serverConfigId === row.serverConfigId)) return null;
        return {
          id: row.id,
          name: row.name,
          remoteAccess: row.remoteAccess,
          songs: row.songs
            .filter((s) => s.song.serverConfigId === binding.serverConfigId)
            .sort((a, b) => a.position - b.position || a.id - b.id)
            .map((s) => ({ song: { ...s.song } })),
        };
      },
    },
    adminAuditEvent: {
      create: async ({ data }: { data: { action: string } }) => {
        audit.push({ action: data.action });
        return { id: `a${audit.length}`, ...data };
      },
      updateMany: async () => ({ count: 1 }),
    },
    musicRequest: {
      createMany: async () => ({ count: 0 }),
      upsert: async (args: { create?: { url?: string; title?: string; musicBotId?: number } }) => {
        historyWrites.push(args);
        return {};
      },
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(app.locals.prisma),
  };

  app.use('/api/listener-remote', listenerRemoteIpGuard, listenerRemoteRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/listener-remote`;

  const handler: any = new MusicCommandHandler(app.locals.prisma, voiceBotManager as any);
  handler.setListenerRemote(remote);
  handler.setPlaylistVoteClock(() => voteNow);
  handler.botChannelConfig.set(binding.botId, {
    serverConfigId: binding.serverConfigId,
    virtualServerId: binding.virtualServerId,
    defaultChannel: null,
    commandChannelIds: [],
  });
  handler.musicBotClidsOnServer = () => new Set([99]);
  handler.eventBridge = { executeCommand: async () => clientlistBody() };

  const request = (path: string, options: {
    session?: string; method?: string; body?: unknown;
  } = {}) => fetch(`${base}${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: {
      ...(options.session ? { Authorization: `Bearer ${options.session}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const exchangeAs = async (who: { botId: number; serverConfigId: number; virtualServerId: number; channelId: number; clid: number; uid: string }) => {
    const previous = state.uid;
    state.uid = who.uid;
    const issued = remote.issue(who);
    const exchanged = await fetch(`${base}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: issued.token }),
    });
    if (exchanged.status !== 200) {
      assert.fail(`exchange ${exchanged.status}: ${await exchanged.text()}`);
    }
    const body = await exchanged.json() as { session: string };
    state.uid = previous;
    return body;
  };

  const chatYes = (who: { clid: number; uid: string }) =>
    handler.onTextMessage(binding.botId, bot, {
      invokerid: String(who.clid), invokeruid: who.uid, msg: '!playlistvote yes',
    });

  return {
    remote, request, exchangeAs, state, seed, bot, queue, audit, historyWrites, runtime,
    privateReplies, chatYes,
    now: () => voteNow,    advance: (ms: number) => { voteNow += ms; remoteNow += ms; },
    /** Elapse credential TTL without closing an open vote window. */
    advanceRemote: (ms: number) => { remoteNow += ms; },
    setPeers: (next: Array<{ clid: number; uid: string }>) => { peers = [...next]; },
    resetClientlistCalls: () => { clientlistCalls = 0; },
    armPlaylistReadGate,
    waitPlaylistReadEntered,
    releasePlaylistReadGate,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function using(
  peers: Array<{ clid: number; uid: string }>,
  fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture({ peers });
  try {
    await fn(f);
  } finally {
    f.releasePlaylistReadGate();
    await f.close();
  }
}

function enableVoting(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<typeof DEFAULT_PLAYLIST_VOTE_SETTINGS> = {}) {
  f.state.voteSettings = JSON.stringify({
    ...DEFAULT_PLAYLIST_VOTE_SETTINGS,
    enabled: true,
    thresholdPercent: 100,
    maxRequestSize: 25,
    ...overrides,
  });
}

function requestable(tracks = 2): PlaylistRow {
  return {
    id: 1, name: 'Requestable', remoteAccess: 'request', serverConfigId: 2,
    songs: Array.from({ length: tracks }, (_, i) => link(i + 1, i, song(100 + i))),
  };
}

/** Open a whole-playlist vote as the requester (voting on, requestable playlist 1). */
async function openVoteAsRequester(
  f: Awaited<ReturnType<typeof fixture>>,
  tracks = 2,
): Promise<{ session: string; vote: { id: string } }> {
  enableVoting(f);
  f.seed(requestable(tracks));
  const { session } = await f.exchangeAs(binding);
  const opened = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
  await assertOk(opened);
  const { vote } = await opened.json() as { vote: { id: string } };
  return { session, vote };
}

async function asPeer(f: Awaited<ReturnType<typeof fixture>>) {
  const peerAuth = await f.exchangeAs({ ...binding, clid: peer.clid, uid: peer.uid });
  f.state.uid = peer.uid;
  return peerAuth;
}

const third = { clid: 11, uid: 'third-listener-uid' };

/** Open vote, peer yes (still open), optional access change, shrink electorate, cross deadline. */
async function openNearPassThenDeadline(
  f: Awaited<ReturnType<typeof fixture>>,
  access: 'request' | 'browse' | 'hidden' = 'request',
) {
  enableVoting(f, { thresholdPercent: 100 });
  f.seed(requestable(2));
  const { session } = await f.exchangeAs(binding);
  const opened = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
  await assertOk(opened);
  const { vote } = await opened.json() as { vote: { id: string } };
  const peerAuth = await asPeer(f);
  await assertOk(await f.request(`/votes/${vote.id}/ballot`, {
    session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
  }));
  assert.equal(f.queue.length, 0, '2/3 yes keeps the vote open');
  if (access !== 'request') {
    f.seed({
      id: 1, name: 'Requestable', remoteAccess: access, serverConfigId: 2,
      songs: [link(1, 0, song(100)), link(2, 1, song(101))],
    });
  }
  f.setPeers([peer]); // deadline electorate 2 with 2 yes — would pass on stale stash
  f.advance(61_000);
  return { session, vote, peerAuth };
}

function olderQueuedTrack(): QueueItem {
  return { id: 'old', title: 'Already queued', filePath: '/secret/old.mp3', source: 'local' };
}

/** Idle head starts; history is the approved playlist only (not older queued songs). */
function assertIdleHeadStartPlaylistHistory(f: Awaited<ReturnType<typeof fixture>>): void {
  assert.equal(f.queue.length, 3);
  assert.equal(f.queue.index, 0);
  assert.equal(f.bot.nowPlaying?.title, 'Already queued');
  assert.deepEqual(f.queue.getAll().map((t) => t.title), ['Already queued', 'Song 100', 'Song 101']);
  assert.equal(f.historyWrites.length, 2);
  assert.deepEqual(
    f.historyWrites.map((row) => row.create?.url).sort(),
    ['/secret/100.mp3', '/secret/101.mp3'],
  );
  assert.ok(!f.historyWrites.some((row) => row.create?.url === '/secret/old.mp3'));
}

describe('B3 whole-playlist propose/vote', () => {
  it('queues directly when voting is off (all-or-nothing)', async () => using([], async (f) => {
    f.seed(requestable(3));
    const { session } = await f.exchangeAs(binding);
    const response = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, outcome: 'queued', trackCount: 3 });
    assert.equal(f.queue.length, 3);
    assert.ok(f.audit.some((row) => row.action === 'listener.remote.playlist_request'));
    const serialized = JSON.stringify(await (await f.request('/state', { session })).json());
    assert.ok(!serialized.includes(binding.uid));
    assert.ok(!serialized.includes('/secret/'));
  }));

  it('voting-off idle with older queued tracks starts the head; history is only the playlist', async () => using([], async (f) => {
    f.state.botStatus = 'connected';
    f.queue.add(olderQueuedTrack());
    f.seed(requestable(2));
    const { session } = await f.exchangeAs(binding);
    assert.equal((await f.request('/playlist-requests', { session, body: { playlistId: 1 } })).status, 200);
    assertIdleHeadStartPlaylistHistory(f);
  }));

  it('voting-off while playing appends without restarting', async () => using([], async (f) => {
    f.state.botStatus = 'playing';
    f.bot.nowPlaying = { id: 'cur', title: 'Now', filePath: '/secret/cur.mp3', source: 'local' };
    f.queue.add(f.bot.nowPlaying);
    f.queue.playAt(0);
    f.seed(requestable(2));
    const { session } = await f.exchangeAs(binding);
    await assertOk(await f.request('/playlist-requests', { session, body: { playlistId: 1 } }));
    assert.equal(f.queue.length, 3);
    assert.equal(f.queue.index, 0);
    assert.equal(f.bot.nowPlaying?.title, 'Now');
  }));

  it('refuses browse-only and oversized / empty playlists', async () => using([], async (f) => {
    f.seed({ id: 1, name: 'Browse', remoteAccess: 'browse', serverConfigId: 2, songs: [link(1, 0, song(1))] });
    f.seed({ id: 2, name: 'Empty', remoteAccess: 'request', serverConfigId: 2, songs: [] });
    f.seed({
      id: 3, name: 'Huge', remoteAccess: 'request', serverConfigId: 2,
      songs: Array.from({ length: 26 }, (_, i) => link(i + 1, i, song(i + 1))),
    });
    const { session } = await f.exchangeAs(binding);
    assert.equal((await f.request('/playlist-requests', { session, body: { playlistId: 1 } })).status, 409);
    assert.equal((await f.request('/playlist-requests', { session, body: { playlistId: 99 } })).status, 404);
    assert.equal((await f.request('/playlist-requests', { session, body: { playlistId: 2 } })).status, 422);
    const huge = await f.request('/playlist-requests', { session, body: { playlistId: 3 } });
    assert.equal(huge.status, 422);
    assert.equal((await huge.json() as { code: string }).code, 'request_too_large');
    assert.equal(f.queue.length, 0);
  }));

  it('opens a vote when voting is on with multiple listeners', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable(2));
    const { session } = await f.exchangeAs(binding);
    const response = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(response);
    const body = await response.json() as {
      ok: true; outcome: 'vote'; created: boolean;
      vote: { id: string; status: string; yes: number; listeners: number; ownBallot: string; isRequester: boolean };
    };
    assert.equal(body.outcome, 'vote');
    assert.equal(body.created, true);
    assert.equal(body.vote.status, 'open');
    assert.equal(body.vote.yes, 1);
    assert.equal(body.vote.listeners, 2);
    assert.equal(body.vote.ownBallot, 'yes');
    assert.equal(body.vote.isRequester, true);
    assert.equal(body.vote.id.length, 22);
    assert.equal(f.queue.length, 0);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(binding.uid));
    assert.ok(!serialized.includes(peer.uid));
  }));

  it('auto-queues for a sole listener when voting is on', async () => using([], async (f) => {
    enableVoting(f);
    f.seed(requestable(2));
    const { session } = await f.exchangeAs(binding);
    const response = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, outcome: 'queued', trackCount: 2 });
    assert.equal(f.queue.length, 2);
  }));

  it('passes on threshold and queues atomically once', async () => using([peer], async (f) => {
    const { vote } = await openVoteAsRequester(f);
    const peerAuth = await asPeer(f);
    const ballot = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    await assertOk(ballot);
    const ballotBody = await ballot.json() as { vote: { status: string; reason: string | null } };
    assert.equal(ballotBody.vote.status, 'passed');
    assert.equal(ballotBody.vote.reason, 'approved');
    assert.equal(f.queue.length, 2);

    const replay = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    assert.equal(replay.status, 404);
    assert.equal(f.queue.length, 2);
  }));
});

describe('B3 R2 security matrix', () => {
  it('permission bypass: queue group required to propose', async () => using([], async (f) => {
    f.seed(requestable());
    f.state.policy = JSON.stringify({
      ...defaultMediaCommandPermissions(),
      queue: { mode: 'server_groups', serverGroupIds: [99] },
    });
    const { session } = await f.exchangeAs(binding);
    const denied = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    assert.equal(denied.status, 403);
    assert.equal(f.queue.length, 0);
  }));

  it('identity recycling: stale clid/uid fails live check', async () => using([], async (f) => {
    f.seed(requestable());
    const { session } = await f.exchangeAs(binding);
    f.state.channelId = 999;
    const response = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    assert.equal(response.status, 401);
    assert.equal(f.queue.length, 0);
  }));

  it('vote_running blocks concurrent foreign propose; same requester+playlist is idempotent', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable());
    f.seed({ id: 2, name: 'Other', remoteAccess: 'request', serverConfigId: 2, songs: [link(9, 0, song(9))] });
    const { session } = await f.exchangeAs(binding);
    const first = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(first);
    const firstBody = await first.json() as { vote: { id: string }; created: boolean };
    const again = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(again);
    const againBody = await again.json() as { vote: { id: string }; created: boolean };
    assert.equal(againBody.created, false);
    assert.equal(againBody.vote.id, firstBody.vote.id);

    const other = await f.request('/playlist-requests', { session, body: { playlistId: 2 } });
    assert.equal(other.status, 409);
    assert.equal((await other.json() as { code: string }).code, 'vote_running');
  }));

  it('playlist visibility change fails approval queue', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable(2));
    const { session } = await f.exchangeAs(binding);
    const opened = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(opened);
    const { vote } = await opened.json() as { vote: { id: string } };

    f.seed({
      id: 1, name: 'Requestable', remoteAccess: 'hidden', serverConfigId: 2,
      songs: [link(1, 0, song(100)), link(2, 1, song(101))],
    });

    const peerAuth = await f.exchangeAs({ ...binding, clid: peer.clid, uid: peer.uid });
    f.state.uid = peer.uid;
    const ballot = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    await assertOk(ballot);
    const body = await ballot.json() as { vote: { status: string; reason: string | null } };
    assert.equal(body.vote.status, 'failed');
    assert.equal(body.vote.reason, 'playlist_unavailable');
    assert.equal(f.queue.length, 0);
  }));

  it('queue_full refuses without partial enqueue', async () => using([], async (f) => {
    f.seed(requestable(3));
    for (let i = 0; i < 4998; i++) f.queue.add({ id: `fill-${i}`, title: 'x', filePath: `/x/${i}`, source: 'local' });
    const { session } = await f.exchangeAs(binding);
    const response = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'queue_full');
    assert.equal(f.queue.length, 4998);
  }));

  it('requester cancel and foreign cancel permission', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable());
    const { session } = await f.exchangeAs(binding);
    const opened = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(opened);
    const { vote } = await opened.json() as { vote: { id: string } };

    const peerAuth = await f.exchangeAs({ ...binding, clid: peer.clid, uid: peer.uid });
    f.state.uid = peer.uid;
    const foreign = await f.request(`/votes/${vote.id}`, { session: peerAuth.session, method: 'DELETE' });
    assert.equal(foreign.status, 403);

    f.state.uid = binding.uid;
    const cancel = await f.request(`/votes/${vote.id}`, { session, method: 'DELETE' });
    await assertOk(cancel);
    assert.ok(f.audit.some((row) => row.action === 'listener.remote.vote_cancel'));
    assert.equal(f.queue.length, 0);
  }));

  it('bot restart drops open votes (onRestart)', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable());
    const { session } = await f.exchangeAs(binding);
    const opened = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(opened);
    assert.equal((await opened.json() as { vote: { status: string } }).vote.status, 'open');
    f.runtime.onRestart();
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    const state = await (await f.request('/state', { session })).json() as { vote: null };
    assert.equal(state.vote, null);
  }));

  it('state exposes settings and never voter UIDs', async () => using([peer], async (f) => {
    enableVoting(f, { thresholdPercent: 80, maxRequestSize: 10 });
    f.seed(requestable());
    const { session } = await f.exchangeAs(binding);
    await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    const state = await (await f.request('/state', { session })).json() as {
      playlistRequests: { voting: boolean; thresholdPercent: number; windowSeconds: number; maxTracks: number };
      limits: { maxRequestSeconds: number };
      vote: Record<string, unknown> | null;
      permissions: Record<string, boolean>;
    };
    assert.deepEqual(state.playlistRequests, { voting: true, thresholdPercent: 80, windowSeconds: 60, maxTracks: 10 });
    assert.equal(state.limits.maxRequestSeconds, 900);
    assert.equal(state.permissions.vote, true);
    assert.equal(state.permissions.requestPlaylist, true);
    const text = JSON.stringify(state);
    assert.ok(!text.includes(binding.uid));
    assert.ok(!text.includes(peer.uid));
  }));

  it('rejected Playlist B propose does not corrupt Playlist A pending tracks', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable(2));
    f.seed({
      id: 2, name: 'Other', remoteAccess: 'request', serverConfigId: 2,
      songs: [link(20, 0, song(200)), link(21, 1, song(201)), link(22, 2, song(202))],
    });
    const { session } = await f.exchangeAs(binding);
    const opened = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(opened);
    const { vote } = await opened.json() as { vote: { id: string } };

    const conflict = await f.request('/playlist-requests', { session, body: { playlistId: 2 } });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code, 'vote_running');
    assert.equal(f.queue.length, 0);
    assert.equal(f.runtime.machine.getOpen('4', '8')?.playlist.id, 1);

    // Same-request idempotent retry must also leave A's stash intact.
    const again = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(again);
    assert.equal((await again.json() as { created: boolean }).created, false);

    const peerAuth = await f.exchangeAs({ ...binding, clid: peer.clid, uid: peer.uid });
    f.state.uid = peer.uid;
    const ballot = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    await assertOk(ballot);
    const body = await ballot.json() as { vote: { status: string; reason: string | null } };
    assert.equal(body.vote.status, 'passed');
    assert.equal(body.vote.reason, 'approved');
    assert.equal(f.queue.length, 2, 'Playlist A queued exactly once');
    assert.deepEqual(f.queue.getAll().map((item) => item.id), ['100', '101']);
  }));

  it('expired vote is terminalised on the next propose without a /state poll', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable(2));
    f.seed({ id: 2, name: 'Other', remoteAccess: 'request', serverConfigId: 2, songs: [link(9, 0, song(9))] });
    const { session } = await f.exchangeAs(binding);
    const opened = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(opened);
    assert.ok(f.runtime.machine.getOpen('4', '8'));

    f.advance(61_000);
    const after = await f.request('/playlist-requests', { session, body: { playlistId: 2 } });
    // Deadline close arms the bot cooldown; a new open may 429, but must not leave A open.
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    assert.ok(after.status === 429 || after.status === 200);
    assert.equal(f.queue.length, 0);
  }));

  it('clientlist failure does not invalidate concurrent remote sessions (presence is clientinfo)', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable(2));
    const a = await f.exchangeAs(binding);
    const b = await f.exchangeAs({ ...binding, clid: peer.clid, uid: peer.uid });
    f.state.failElectorate = true;
    f.state.uid = binding.uid;
    assert.equal((await f.request('/state', { session: a.session })).status, 200);
    f.state.uid = peer.uid;
    assert.equal((await f.request('/state', { session: b.session })).status, 200);
    // Ballot still needs the electorate roster — that path stays fail-closed.
    assert.equal((await f.request(`/votes/AAAAAAAAAAAAAAAAAAAAAA/ballot`, {
      session: b.session, method: 'PUT', body: { choice: 'yes' },
    })).status, 503);
  }));

  it('peer leave or reconnect does not invalidate the other remote session', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable(2));
    const a = await f.exchangeAs(binding);
    const b = await f.exchangeAs({ ...binding, clid: peer.clid, uid: peer.uid });

    // Peer leaves the channel view — only that clid grant is revoked.
    assert.equal(f.remote.revokeClient(binding.serverConfigId, binding.virtualServerId, peer.clid), undefined);
    f.state.uid = binding.uid;
    assert.equal((await f.request('/state', { session: a.session })).status, 200);
    f.state.uid = peer.uid;
    assert.equal((await f.request('/state', { session: b.session })).status, 401);

    // Peer reconnects under a new clid with a fresh grant; A stays valid.
    const reconnected = { ...binding, clid: peer.clid + 50, uid: peer.uid };
    const b2 = await f.exchangeAs(reconnected);
    f.state.uid = binding.uid;
    assert.equal((await f.request('/state', { session: a.session })).status, 200);
    f.state.uid = peer.uid;
    assert.equal((await f.request('/state', { session: b2.session })).status, 200);
  }));

  it('listener lookup failure refuses ballots and fails the vote at deadline (not empty electorate)', async () => using([peer], async (f) => {
    const { session, vote } = await openVoteAsRequester(f);
    const peerAuth = await asPeer(f);
    f.resetClientlistCalls();
    f.state.failElectorate = true;
    const ballot = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    assert.equal(ballot.status, 503);
    assert.equal(f.queue.length, 0);
    assert.ok(f.runtime.machine.getOpen('4', '8'), 'vote stays open until deadline when lookup fails mid-window');

    f.advance(61_000);
    f.state.uid = binding.uid;
    f.resetClientlistCalls();
    // Auth succeeds via clientinfo; electorate clientlist fails → tick with null, not [].
    const stateRes = await f.request('/state', { session });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json() as { vote: { status: string; reason: string | null } | null };
    assert.equal(state.vote?.status, 'failed');
    assert.equal(state.vote?.reason, 'listeners_unavailable');
    assert.equal(f.queue.length, 0);

    // Contrast on B2: genuine empty electorate is deadline/closeSilent, never listeners_unavailable.
    // Use a distinct botKey so prior cooldowns on bot "4" do not rate-limit this check.
    const openedEmpty = f.runtime.machine.openVote({
      botKey: 'contrast', channelId: '8', requesterUid: binding.uid,
      playlist: { id: 1, name: 'Requestable', trackCount: 2 },
      settings: { thresholdPercent: 100, windowMs: 60_000, maxTracks: 25 },
      listenerUids: [binding.uid, peer.uid], nowMs: f.now(),
    });
    assert.equal(openedEmpty.ok, true);
    f.advance(61_000);
    const emptyTick = f.runtime.machine.tickDeadline({
      botKey: 'contrast', channelId: '8', listenerUids: [], nowMs: f.now(),
    });
    assert.deepEqual(emptyTick, []);
    assert.equal(f.runtime.machine.getOpen('contrast', '8'), undefined);
    assert.equal(f.queue.length, 0);
  }));

  it('post-deadline cancel after hide does not queue', async () => using([peer, third], async (f) => {
    const { session, vote } = await openNearPassThenDeadline(f, 'hidden');
    f.state.uid = binding.uid;
    const cancel = await f.request(`/votes/${vote.id}`, { session, method: 'DELETE' });
    assert.equal(cancel.status, 404);
    assert.equal(f.queue.length, 0);
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
  }));

  it('post-deadline withdraw after hide does not queue', async () => using([peer, third], async (f) => {
    const { vote, peerAuth } = await openNearPassThenDeadline(f, 'hidden');
    f.state.uid = peer.uid;
    const withdraw = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'DELETE',
    });
    assert.equal(withdraw.status, 404);
    assert.equal(f.queue.length, 0);
  }));

  it('post-deadline cancel after remoteAccess demotion does not queue', async () => using([peer, third], async (f) => {
    const { session, vote } = await openNearPassThenDeadline(f, 'browse');
    f.state.uid = binding.uid;
    const cancel = await f.request(`/votes/${vote.id}`, { session, method: 'DELETE' });
    assert.equal(cancel.status, 404);
    assert.equal(f.queue.length, 0);
  }));

  it('post-deadline cancel of still-requestable playlist may pass once after re-read', async () => using([peer, third], async (f) => {
    const { session, vote } = await openNearPassThenDeadline(f);
    f.state.uid = binding.uid;
    const cancel = await f.request(`/votes/${vote.id}`, { session, method: 'DELETE' });
    assert.equal(cancel.status, 404);
    assert.equal(f.queue.length, 2, 'eligible deadline pass still queues exactly once');
    assert.equal(f.historyWrites.length, 2, 'deadline queue records exact track snapshot once');
    assert.deepEqual(
      f.historyWrites.map((row) => row.create?.url).sort(),
      ['/secret/100.mp3', '/secret/101.mp3'],
    );
  }));

  it('deadline settle via /state records history once; repeat settle does not duplicate', async () => using([peer, third], async (f) => {
    const { session } = await openNearPassThenDeadline(f);
    f.state.uid = binding.uid;
    await assertOk(await f.request('/state', { session }));
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    await assertOk(await f.request('/state', { session }));
    assert.equal(f.queue.length, 2, 'exactly-once queue');
    assert.equal(f.historyWrites.length, 2, 'no duplicate history on re-settle');
  }));

  it('deadline settle on idle bot with older queued tracks starts head; history is only approved playlist', async () => using([peer, third], async (f) => {
    const { session } = await openNearPassThenDeadline(f);
    f.state.uid = binding.uid;
    f.state.botStatus = 'connected';
    f.bot.nowPlaying = null;
    f.queue.add(olderQueuedTrack());
    await assertOk(await f.request('/state', { session }));
    assertIdleHeadStartPlaylistHistory(f);
  }));

  it('post-deadline hide does not write request history', async () => using([peer, third], async (f) => {
    const { session, vote } = await openNearPassThenDeadline(f, 'hidden');
    f.state.uid = binding.uid;
    const cancel = await f.request(`/votes/${vote.id}`, { session, method: 'DELETE' });
    assert.equal(cancel.status, 404);
    assert.equal(f.queue.length, 0);
    assert.equal(f.historyWrites.length, 0);
  }));

  it('bot_unavailable cancels open vote and clears stash without queueing', async () => using([peer], async (f) => {
    const { session, vote } = await openVoteAsRequester(f);
    assert.ok(f.runtime.machine.getOpen('4', '8'));
    f.runtime.cancelBotUnavailable(binding.botId, f.now());
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    f.advance(61_000);
    f.state.uid = binding.uid;
    const ballot = await f.request(`/votes/${vote.id}/ballot`, {
      session, method: 'PUT', body: { choice: 'yes' },
    });
    assert.equal(ballot.status, 404);
    assert.equal(f.queue.length, 0);
  }));

  it('requester revoke cancels open vote; peer cannot approve afterward', async () => using([peer], async (f) => {
    const { session, vote } = await openVoteAsRequester(f);
    assert.equal(f.remote.revoke(binding.botId, binding.uid), 1);
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    const peerAuth = await asPeer(f);
    const ballot = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    assert.equal(ballot.status, 404);
    assert.equal(f.queue.length, 0);
    // Original requester session is dead.
    f.state.uid = binding.uid;
    const state = await f.request('/state', { session });
    assert.equal(state.status, 401);
  }));

  it('bot-wide revoke cancels open votes for that bot only', async () => using([peer], async (f) => {
    await openVoteAsRequester(f);
    const other = f.runtime.machine.openVote({
      botKey: '99', channelId: '8', requesterUid: 'other-req',
      playlist: { id: 9, name: 'X', trackCount: 1 },
      settings: { thresholdPercent: 100, windowMs: 60_000, maxTracks: 25 },
      listenerUids: ['other-req', peer.uid], nowMs: f.now(),
    });
    assert.equal(other.ok, true);
    f.remote.revoke(binding.botId);
    f.runtime.cancelAllRevoked(binding.botId, f.now());
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    assert.ok(f.runtime.machine.getOpen('99', '8'), 'unrelated bot vote untouched');
    assert.equal(f.queue.length, 0);
  }));

  it('session expiry alone does not cancel a vote while requester stays in channel', async () => using([peer], async (f) => {
    const { session, vote } = await openVoteAsRequester(f);
    assert.ok(f.runtime.machine.getOpen('4', '8'));
    // Session TTL is 15 minutes; advance credential clock only (vote window stays open).
    f.advanceRemote(15 * 60_000 + 1);
    f.remote.checkIp('127.0.0.1', false);
    assert.ok(f.runtime.machine.getOpen('4', '8'), 'expired credentials must not cancel the vote (#442)');
    // Requester session is dead; peer can still approve.
    const peerAuth = await asPeer(f);
    const ballot = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    await assertOk(ballot);
    assert.equal((await ballot.json() as { vote: { status: string } }).vote.status, 'passed');
    assert.equal(f.queue.length, 2);
    f.state.uid = binding.uid;
    assert.equal((await f.request('/state', { session })).status, 401);
  }));

  it('replacement !remote link does not cancel an open vote', async () => using([peer], async (f) => {
    await openVoteAsRequester(f);
    assert.ok(f.runtime.machine.getOpen('4', '8'));
    const again = f.remote.issue(binding);
    assert.ok(again.token);
    assert.ok(f.runtime.machine.getOpen('4', '8'), '!remote replacement must not cancel (#442)');
    assert.equal(f.queue.length, 0);
  }));

  it('channel departure revokeClient cancels the requester vote', async () => using([peer], async (f) => {
    const { vote } = await openVoteAsRequester(f);
    f.remote.revokeClient(binding.serverConfigId, binding.virtualServerId, binding.clid);
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    const peerAuth = await asPeer(f);
    const ballot = await f.request(`/votes/${vote.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    assert.equal(ballot.status, 404);
    assert.equal(f.queue.length, 0);
  }));

  it('delayed settle for cancelled A cannot tick or clear successor B pending', async () => using([peer], async (f) => {
    enableVoting(f);
    f.seed(requestable(2));
    f.seed({
      id: 2, name: 'Successor', remoteAccess: 'request', serverConfigId: 2,
      songs: [link(20, 0, song(200)), link(21, 1, song(201)), link(22, 2, song(202))],
    });
    const { session } = await f.exchangeAs(binding);
    const openedA = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(openedA);
    const { vote: voteA } = await openedA.json() as { vote: { id: string } };
    assert.equal(voteA.id.length, 22);

    // Unrelated bot/channel vote must stay untouched through the race.
    const unrelated = f.runtime.machine.openVote({
      botKey: '99', channelId: '7', requesterUid: 'other-req',
      playlist: { id: 9, name: 'X', trackCount: 1 },
      settings: { thresholdPercent: 100, windowMs: 60_000, maxTracks: 25 },
      listenerUids: ['other-req', peer.uid], nowMs: f.now(),
    });
    assert.equal(unrelated.ok, true);
    const unrelatedId = unrelated.ok ? unrelated.vote.id : '';

    f.advance(61_000);
    f.armPlaylistReadGate();
    f.state.uid = binding.uid;
    const settleA = f.request(`/votes/${voteA.id}`, { session, method: 'DELETE' });
    await f.waitPlaylistReadEntered();

    // Terminate A while its approval-time re-read is parked.
    f.runtime.cancelBotUnavailable(binding.botId, f.now());
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    assert.equal(f.queue.length, 0);

    f.advance(BOT_COOLDOWN_MS);
    const openedB = await f.request('/playlist-requests', { session, body: { playlistId: 2 } });
    await assertOk(openedB);
    const { vote: voteB } = await openedB.json() as { vote: { id: string } };
    assert.notEqual(voteB.id, voteA.id);
    assert.ok(f.runtime.machine.getOpen('4', '8'));
    const pendingKey = `4${'\0'}8`;
    const pendingBefore = (f.runtime as unknown as {
      pending: Map<string, { items: QueueItem[]; playlistId: number }>;
    }).pending.get(pendingKey);
    assert.ok(pendingBefore);
    assert.equal(pendingBefore.playlistId, 2);
    assert.equal(pendingBefore.items.length, 3);

    f.releasePlaylistReadGate();
    const settleRes = await settleA;
    assert.equal(settleRes.status, 404);
    assert.equal(f.queue.length, 0, 'cancelled A must not queue');

    const stillB = f.runtime.machine.getOpen('4', '8');
    assert.ok(stillB);
    assert.equal(stillB.id, voteB.id, 'A settle must not tick B');
    const pendingAfter = (f.runtime as unknown as {
      pending: Map<string, { items: QueueItem[]; playlistId: number }>;
    }).pending.get(pendingKey);
    assert.ok(pendingAfter, 'failed A settle must not clear B pending');
    assert.equal(pendingAfter.playlistId, 2);
    assert.equal(pendingAfter.items.length, 3);

    assert.equal(f.runtime.machine.getOpen('99', '7')?.id, unrelatedId);

    const peerAuth = await asPeer(f);
    const ballot = await f.request(`/votes/${voteB.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    await assertOk(ballot);
    assert.equal((await ballot.json() as { vote: { status: string } }).vote.status, 'passed');
    assert.equal(f.queue.length, 3, 'B queues exactly once');
    assert.deepEqual(
      f.queue.getAll().map((item) => item.id),
      ['200', '201', '202'],
    );

    const replay = await f.request(`/votes/${voteB.id}/ballot`, {
      session: peerAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    assert.equal(replay.status, 404);
    assert.equal(f.queue.length, 3);
  }));
});

describe('B4 cross-interface remote/chat races', () => {
  async function openFiftyPercentVote(f: Awaited<ReturnType<typeof fixture>>) {
    enableVoting(f, { thresholdPercent: 50 });
    f.seed(requestable(2));
    const { session } = await f.exchangeAs(binding);
    const opened = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(opened);
    const body = await opened.json() as {
      vote: { id: string; yes: number; needed: number; listeners: number };
    };
    assert.equal(body.vote.listeners, 3);
    assert.equal(body.vote.needed, 2);
    assert.equal(body.vote.yes, 1);
    return { session, voteId: body.vote.id };
  }

  function assertApprovedOnce(f: Awaited<ReturnType<typeof fixture>>, trackIds: string[]) {
    assert.deepEqual(
      f.queue.getAll().filter((t) => trackIds.includes(t.id)).map((t) => t.id),
      trackIds,
    );
    assert.equal(f.historyWrites.length, trackIds.length);
    assert.deepEqual(
      f.historyWrites.map((row) => row.create?.url).sort(),
      trackIds.map((id) => `/secret/${id}.mp3`).sort(),
    );
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    const blob = JSON.stringify(f.privateReplies);
    assert.ok(!blob.includes(binding.uid));
    assert.ok(!blob.includes(peer.uid));
    assert.ok(!blob.includes(third.uid));
    assert.ok(!blob.includes('/secret/'));
  }

  it('chat wins while remote HTTP ballot is parked in restash', async () => using([peer, third], async (f) => {
    const { voteId } = await openFiftyPercentVote(f);
    f.state.botStatus = 'connected';
    f.bot.nowPlaying = null;
    f.queue.add(olderQueuedTrack());

    f.armPlaylistReadGate();
    const thirdAuth = await f.exchangeAs({ ...binding, clid: third.clid, uid: third.uid });
    f.state.uid = third.uid;
    const remoteInFlight = f.request(`/votes/${voteId}/ballot`, {
      session: thirdAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    await f.waitPlaylistReadEntered();

    await f.chatYes(peer);
    assertApprovedOnce(f, ['100', '101']);
    assert.deepEqual(f.queue.getAll().map((t) => t.id), ['old', '100', '101']);
    assert.equal(f.queue.index, 0);
    assert.equal(f.bot.nowPlaying?.id, 'old');

    f.releasePlaylistReadGate();
    const remoteRes = await remoteInFlight;
    assert.ok([404, 409].includes(remoteRes.status), `loser status ${remoteRes.status}`);
    assert.equal(f.queue.length, 3);
    assert.equal(f.historyWrites.length, 2);
  }));

  it('remote HTTP wins while chat ballot is parked in restash', async () => using([peer, third], async (f) => {
    const { voteId } = await openFiftyPercentVote(f);

    f.armPlaylistReadGate();
    const chatInFlight = f.chatYes(peer);
    await f.waitPlaylistReadEntered();

    const thirdAuth = await f.exchangeAs({ ...binding, clid: third.clid, uid: third.uid });
    f.state.uid = third.uid;
    const remoteRes = await f.request(`/votes/${voteId}/ballot`, {
      session: thirdAuth.session, method: 'PUT', body: { choice: 'yes' },
    });
    await assertOk(remoteRes);
    assert.equal((await remoteRes.json() as { vote: { status: string } }).vote.status, 'passed');
    assertApprovedOnce(f, ['100', '101']);

    f.releasePlaylistReadGate();
    await chatInFlight;
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
  }));

  it('deadline /state settle races chat ballot; queues history at most once', async () => using([peer, third], async (f) => {
    const { session, vote } = await openNearPassThenDeadline(f);
    f.state.uid = binding.uid;

    f.armPlaylistReadGate();
    const stateSettle = f.request('/state', { session });
    await f.waitPlaylistReadEntered();

    await f.chatYes(peer);
    f.releasePlaylistReadGate();
    await assertOk(await stateSettle);

    assertApprovedOnce(f, ['100', '101']);
    await f.chatYes(peer);
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    void vote;
  }));

  it('parked deadline settle for cancelled A cannot consume successor B (chat approves B)', async () => using([peer, third], async (f) => {
    enableVoting(f, { thresholdPercent: 50 });
    f.seed(requestable(2));
    f.seed({
      id: 2, name: 'Successor', remoteAccess: 'request', serverConfigId: 2,
      songs: [link(20, 0, song(200)), link(21, 1, song(201)), link(22, 2, song(202))],
    });
    const { session } = await f.exchangeAs(binding);
    const openedA = await f.request('/playlist-requests', { session, body: { playlistId: 1 } });
    await assertOk(openedA);
    const { vote: voteA } = await openedA.json() as { vote: { id: string } };

    f.advance(61_000);
    f.armPlaylistReadGate();
    const settleA = f.request(`/votes/${voteA.id}`, { session, method: 'DELETE' });
    await f.waitPlaylistReadEntered();

    f.runtime.cancelBotUnavailable(binding.botId, f.now());
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);

    f.advance(BOT_COOLDOWN_MS);
    const openedB = await f.request('/playlist-requests', { session, body: { playlistId: 2 } });
    await assertOk(openedB);
    const { vote: voteB } = await openedB.json() as { vote: { id: string } };
    assert.notEqual(voteB.id, voteA.id);

    f.releasePlaylistReadGate();
    assert.equal((await settleA).status, 404);
    assert.equal(f.queue.length, 0);
    assert.equal(f.runtime.machine.getOpen('4', '8')?.id, voteB.id);

    await f.chatYes(peer);
    assertApprovedOnce(f, ['200', '201', '202']);
    assert.equal(f.queue.length, 3);
  }));
});
