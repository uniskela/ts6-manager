/**
 * Cross-interface races: real remote HTTP ballots/settles vs chat `!playlistvote`
 * against one shared PlaylistVoteRuntime. Barriers use the playlist restash gate
 * (no timing sleeps). Never manually enqueue after the runtime commits.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import express from 'express';
import { DEFAULT_PLAYLIST_VOTE_SETTINGS } from '@ts6/common';
import { listenerRemoteIpGuard, listenerRemoteRoutes } from '../../routes/listener-remote.routes.js';
import { ListenerRemoteService } from '../listener-remote.js';
import { MusicCommandHandler, resetChatReplyCooldownsForTests } from '../music-command-handler.js';
import { PlayQueue, type QueueItem } from '../playlist/queue.js';
import { playlistVoteSettingsKey } from '../playlist-vote-settings.js';
import { bindPlaylistVoteLifecycle } from './lifecycle.js';
import { PlaylistVoteRuntime } from './runtime.js';
import { BOT_COOLDOWN_MS } from './state-machine.js';

const requester = { clid: 9, uid: 'listener-secret-identity' };
const peer = { clid: 10, uid: 'other-listener-uid' };
const third = { clid: 11, uid: 'third-listener-uid' };
const binding = {
  botId: 4, serverConfigId: 2, virtualServerId: 3, channelId: 8, ...requester,
};

type PlaylistRow = {
  id: number;
  name: string;
  remoteAccess: 'hidden' | 'browse' | 'request';
  serverConfigId: number | null;
  songs: Array<{
    id: number;
    position: number;
    song: {
      id: number; title: string; artist: string | null; duration: number | null;
      filePath: string; source: string; sourceUrl: string | null; serverConfigId: number;
    };
  }>;
};

function song(id: number): PlaylistRow['songs'][number]['song'] {
  return {
    id, title: `Song ${id}`, artist: `Artist ${id}`, duration: 30,
    filePath: `/secret/${id}.mp3`, source: 'local', sourceUrl: null, serverConfigId: 2,
  };
}

function link(id: number, position: number, track: PlaylistRow['songs'][number]['song']) {
  return { id, position, song: track };
}

function requestable(id: number, name: string, trackIds: number[]): PlaylistRow {
  return {
    id, name, remoteAccess: 'request', serverConfigId: 2,
    songs: trackIds.map((trackId, i) => link(trackId, i, song(trackId))),
  };
}

async function fixture(opts: {
  thresholdPercent?: number;
  /** Drop third from live clientlist (deadline electorate shrink). */
  dropThird?: boolean;
} = {}) {
  resetChatReplyCooldownsForTests();
  let voteNow = 1_700_000_000_000;
  let remoteNow = 1_700_000_000_000;
  const remote = new ListenerRemoteService(() => remoteNow);
  const queue = new PlayQueue();
  const historyWrites: Array<{ create?: { url?: string; title?: string } }> = [];
  const privateReplies: string[] = [];
  const playlists = new Map<number, PlaylistRow>();
  const seed = (row: PlaylistRow) => { playlists.set(row.id, row); return row; };
  let dropThird = opts.dropThird === true;
  let authUid = requester.uid;
  const thresholdPercent = opts.thresholdPercent ?? 50;

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
    const humans = [
      `clid=${requester.clid} cid=8 client_unique_identifier=${requester.uid} client_type=0`,
      `clid=${peer.clid} cid=8 client_unique_identifier=${peer.uid} client_type=0`,
      ...(dropThird
        ? []
        : [`clid=${third.clid} cid=8 client_unique_identifier=${third.uid} client_type=0`]),
    ];
    return `${humans.join('|')}|clid=99 cid=8 client_type=0 client_unique_identifier=bot\nerror id=0 msg=ok`;
  };

  const bot: any = {
    currentConfig: { id: 4, serverConfigId: 2, name: 'Music', password: 'x' },
    ts3ClientId: 99,
    status: 'connected',
    nowPlaying: null as QueueItem | null,
    queue,
    videoSessionInfo: () => null,
    floodHoldActive: false,
    noteIgnoredCommand: () => undefined,
    getCurrentChannelId: () => 8,
    sendTextMessage: (_clid: number, text: string) => { privateReplies.push(text); },
    play: async (item: QueueItem) => { bot.nowPlaying = item; bot.status = 'playing'; },
    playStream: async (item: QueueItem) => { bot.nowPlaying = item; bot.status = 'playing'; },
  };
  const manager = { getBot: () => bot, getBotsForServer: async () => [{ bot }] };

  const prisma: any = {
    appSetting: {
      findUnique: async ({ where: { key } }: { where: { key: string } }) => {
        if (key === playlistVoteSettingsKey(2, 3)) {
          return {
            value: JSON.stringify({
              ...DEFAULT_PLAYLIST_VOTE_SETTINGS,
              enabled: true,
              thresholdPercent,
              maxRequestSize: 25,
            }),
          };
        }
        return null;
      },
    },
    musicBot: { findUnique: async () => ({ serverConfigId: 2, virtualServerId: 3 }) },
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
        return {
          id: row.id,
          name: row.name,
          remoteAccess: row.remoteAccess,
          songs: row.songs
            .filter((s) => s.song.serverConfigId === 2)
            .sort((a, b) => a.position - b.position || a.id - b.id)
            .map((s) => ({ song: { ...s.song } })),
        };
      },
    },
    adminAuditEvent: {
      create: async ({ data }: { data: unknown }) => ({ id: 'a1', ...(data as object) }),
      updateMany: async () => ({ count: 1 }),
    },
    musicRequest: {
      createMany: async () => ({ count: 0 }),
      upsert: async (args: { create?: { url?: string; title?: string } }) => {
        historyWrites.push(args);
        return {};
      },
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  const runtime = new PlaylistVoteRuntime(() => bot);
  bindPlaylistVoteLifecycle(remote, runtime);

  const bridge = {
    executeCommand: async (_s: number, _v: number, cmd: string) => {
      if (cmd.startsWith('clientinfo')) {
        return `client_unique_identifier=${authUid} client_servergroups=7 client_type=0\nerror id=0 msg=ok`;
      }
      assert.equal(cmd, 'clientlist -uid');
      return clientlistBody();
    },
  };

  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.locals.listenerRemote = remote;
  app.locals.voiceBotManager = manager;
  app.locals.playlistVotes = runtime;
  app.locals.playlistVoteClock = () => voteNow;
  app.locals.prisma = prisma;
  app.locals.eventBridge = bridge;
  app.use('/api/listener-remote', listenerRemoteIpGuard, listenerRemoteRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/listener-remote`;

  const handler: any = new MusicCommandHandler(prisma, manager as any);
  handler.setListenerRemote(remote);
  handler.setPlaylistVoteClock(() => voteNow);
  handler.botChannelConfig.set(4, {
    serverConfigId: 2, virtualServerId: 3, defaultChannel: null, commandChannelIds: [],
  });
  handler.musicBotClidsOnServer = () => new Set([99]);
  // EventBridge signature is (serverConfigId, virtualServerId, cmd) — ignore ids.
  handler.eventBridge = {
    executeCommand: async () => clientlistBody(),
  };

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

  const exchangeAs = async (who: { clid: number; uid: string }) => {
    authUid = who.uid;
    const issued = remote.issue({ ...binding, clid: who.clid, uid: who.uid });
    const exchanged = await fetch(`${base}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: issued.token }),
    });
    if (exchanged.status !== 200) {
      assert.fail(`exchange ${exchanged.status}: ${await exchanged.text()}`);
    }
    return (await exchanged.json()) as { session: string };
  };

  const openVote = async (playlistId = 1) => {
    const { session } = await exchangeAs(requester);
    authUid = requester.uid;
    const opened = await request('/playlist-requests', { session, body: { playlistId } });
    if (opened.status !== 200) {
      assert.fail(`openVote ${opened.status}: ${await opened.text()}`);
    }
    const body = await opened.json() as {
      outcome: string; vote: { id: string; yes: number; needed: number; listeners: number };
    };
    assert.equal(body.outcome, 'vote');
    return { session, voteId: body.vote.id, vote: body.vote };
  };

  const chatYes = (who: { clid: number; uid: string }) =>
    handler.onTextMessage(4, bot, {
      invokerid: String(who.clid), invokeruid: who.uid, msg: '!playlistvote yes',
    });

  const remoteYes = async (who: { clid: number; uid: string }, voteId: string) => {
    const { session } = await exchangeAs(who);
    authUid = who.uid;
    return request(`/votes/${voteId}/ballot`, {
      session, method: 'PUT', body: { choice: 'yes' },
    });
  };

  const asUid = (uid: string) => { authUid = uid; };

  const assertApprovedOnce = (trackIds: string[]) => {
    assert.deepEqual(
      queue.getAll().filter((t) => trackIds.includes(t.id)).map((t) => t.id),
      trackIds,
    );
    assert.equal(
      queue.getAll().filter((t) => trackIds.includes(t.id)).length,
      trackIds.length,
      'no duplicate approved tracks',
    );
    assert.equal(historyWrites.length, trackIds.length);
    assert.deepEqual(
      historyWrites.map((row) => row.create?.url).sort(),
      trackIds.map((id) => `/secret/${id}.mp3`).sort(),
    );
    assert.equal(runtime.machine.getOpen('4', '8'), undefined);
    const blob = JSON.stringify(privateReplies);
    assert.ok(!blob.includes(requester.uid));
    assert.ok(!blob.includes(peer.uid));
    assert.ok(!blob.includes(third.uid));
    assert.ok(!blob.includes('/secret/'));
  };

  return {
    bot, queue, runtime, historyWrites, privateReplies, seed, openVote, chatYes, remoteYes,
    request, exchangeAs, assertApprovedOnce, asUid, armPlaylistReadGate, waitPlaylistReadEntered,
    releasePlaylistReadGate,
    setDropThird: (v: boolean) => { dropThird = v; },
    advance: (ms: number) => { voteNow += ms; remoteNow += ms; },
    now: () => voteNow,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function using(
  opts: Parameters<typeof fixture>[0],
  fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture(opts);
  try {
    await fn(f);
  } finally {
    f.releasePlaylistReadGate();
    await f.close();
  }
}

describe('B4 cross-interface remote/chat races', () => {
  it('chat wins while remote HTTP ballot is parked in restash', async () => using({}, async (f) => {
    f.seed(requestable(1, 'Race', [100, 101]));
    const { voteId } = await f.openVote();
    assert.equal(f.queue.length, 0);

    f.queue.add({ id: 'old', title: 'Already queued', filePath: '/secret/old.mp3', source: 'local' });
    f.bot.status = 'connected';

    f.armPlaylistReadGate();
    const remoteInFlight = f.remoteYes(third, voteId);
    await f.waitPlaylistReadEntered();

    await f.chatYes(peer);
    f.assertApprovedOnce(['100', '101']);
    assert.deepEqual(f.queue.getAll().map((t) => t.id), ['old', '100', '101']);
    assert.equal(f.queue.index, 0, 'idle start keeps existing head');
    assert.equal(f.bot.nowPlaying?.id, 'old');
    assert.ok(!f.historyWrites.some((row) => row.create?.url === '/secret/old.mp3'));

    f.releasePlaylistReadGate();
    const remoteRes = await remoteInFlight;
    assert.ok([404, 409].includes(remoteRes.status), `loser status ${remoteRes.status}`);
    assert.equal(f.queue.length, 3);
    assert.equal(f.historyWrites.length, 2);
  }));

  it('remote HTTP wins while chat ballot is parked in restash', async () => using({}, async (f) => {
    f.seed(requestable(1, 'Race', [100, 101]));
    const { voteId } = await f.openVote();

    f.armPlaylistReadGate();
    const chatInFlight = f.chatYes(peer);
    await f.waitPlaylistReadEntered();

    const remoteRes = await f.remoteYes(third, voteId);
    if (remoteRes.status !== 200) {
      assert.fail(`remote win ${remoteRes.status}: ${await remoteRes.text()}`);
    }
    assert.equal((await remoteRes.json() as { vote: { status: string } }).vote.status, 'passed');
    f.assertApprovedOnce(['100', '101']);

    f.releasePlaylistReadGate();
    await chatInFlight;
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
  }));

  it('deadline /state settle races chat ballot; queues history at most once', async () => using(
    { thresholdPercent: 100 },
    async (f) => {
      f.seed(requestable(1, 'Race', [100, 101]));
      const { session, voteId } = await f.openVote();
      // Peer yes keeps vote open (2/3 at 100%).
      assert.equal((await f.remoteYes(peer, voteId)).status, 200);
      assert.equal(f.queue.length, 0);

      f.advance(61_000);
      f.setDropThird(true); // live electorate 2 with 2 yes → deadline pass
      f.asUid(requester.uid); // /state session is requester; clientinfo must match

      f.armPlaylistReadGate();
      const stateSettle = f.request('/state', { session });
      await f.waitPlaylistReadEntered();

      await f.chatYes(peer); // concurrent post-deadline settle path
      f.releasePlaylistReadGate();
      assert.equal((await stateSettle).status, 200);

      f.assertApprovedOnce(['100', '101']);
      assert.equal(f.queue.length, 2);
      // Replay chat must not double history.
      await f.chatYes(peer);
      assert.equal(f.queue.length, 2);
      assert.equal(f.historyWrites.length, 2);
    },
  ));

  it('parked deadline settle for cancelled A cannot consume successor B (chat approves B)', async () => using(
    { thresholdPercent: 50 },
    async (f) => {
      f.seed(requestable(1, 'A', [100, 101]));
      f.seed(requestable(2, 'B', [200, 201, 202]));
      const { session, voteId: voteA } = await f.openVote(1);

      f.advance(61_000);
      f.armPlaylistReadGate();
      const settleA = f.request(`/votes/${voteA}`, { session, method: 'DELETE' });
      await f.waitPlaylistReadEntered();

      f.runtime.cancelBotUnavailable(4, f.now());
      assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
      assert.equal(f.queue.length, 0);

      f.advance(BOT_COOLDOWN_MS);
      const openedB = await f.request('/playlist-requests', { session, body: { playlistId: 2 } });
      if (openedB.status !== 200) {
        assert.fail(`open B ${openedB.status}: ${await openedB.text()}`);
      }
      const { vote: voteB } = await openedB.json() as { vote: { id: string } };
      assert.notEqual(voteB.id, voteA);

      f.releasePlaylistReadGate();
      assert.equal((await settleA).status, 404);
      assert.equal(f.queue.length, 0);

      const stillB = f.runtime.machine.getOpen('4', '8');
      assert.ok(stillB);
      assert.equal(stillB.id, voteB.id);

      await f.chatYes(peer);
      f.assertApprovedOnce(['200', '201', '202']);
      assert.equal(f.queue.length, 3);
    },
  ));
});
