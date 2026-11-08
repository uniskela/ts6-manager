import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PLAYLIST_VOTE_SETTINGS } from '@ts6/common';
import { PlayQueue, type QueueItem } from '../playlist/queue.js';
import { ListenerRemoteService } from '../listener-remote.js';
import { bindPlaylistVoteLifecycle } from '../playlist-vote/lifecycle.js';
import { PlaylistVoteRuntime } from '../playlist-vote/runtime.js';
import { playlistVoteSettingsKey } from '../playlist-vote-settings.js';
import { MusicCommandHandler, resetChatReplyCooldownsForTests } from '../music-command-handler.js';

const requester = 'req-uid';
const peer = 'peer-uid';
const third = 'third-uid';

function item(id: string): QueueItem {
  return { id, title: `T${id}`, filePath: `/secret/${id}.mp3`, source: 'local' };
}

async function fixture(opts: {
  bridge?: 'ok' | 'throw' | null;
  /** Include a third human so 2/3 yes stays open until deadline. */
  threeListeners?: boolean;
} = {}) {
  resetChatReplyCooldownsForTests();
  let now = 1_700_000_000_000;
  const remote = new ListenerRemoteService(() => now);
  const queue = new PlayQueue();
  const historyWrites: Array<{ create?: { url?: string } }> = [];
  const privateReplies: string[] = [];
  const playlist = {
    id: 1,
    name: 'P',
    remoteAccess: 'request' as string,
    songs: [
      { song: { id: 100, title: 'A', artist: null, duration: 1, filePath: '/secret/100.mp3', source: 'local', sourceUrl: null } },
      { song: { id: 101, title: 'B', artist: null, duration: 1, filePath: '/secret/101.mp3', source: 'local', sourceUrl: null } },
    ],
  };
  const electorate = opts.threeListeners ? [requester, peer, third] : [requester, peer];

  const bot: any = {
    currentConfig: { id: 4, serverConfigId: 2, name: 'Music', password: 'x' },
    ts3ClientId: 99,
    status: 'playing',
    nowPlaying: null,
    queue,
    videoSessionInfo: () => null,
    floodHoldActive: false,
    noteIgnoredCommand: () => undefined,
    getCurrentChannelId: () => 8,
    sendTextMessage: (_clid: number, text: string) => { privateReplies.push(text); },
    play: async () => undefined,
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
              thresholdPercent: 100,
              maxRequestSize: 25,
            }),
          };
        }
        return null;
      },
    },
    musicBot: { findUnique: async () => ({ serverConfigId: 2, virtualServerId: 3 }) },
    playlist: {
      findFirst: async () => {
        if (playlist.remoteAccess === 'hidden') return null;
        if (playlist.remoteAccess !== 'request') {
          return { ...playlist, songs: playlist.songs };
        }
        return playlist;
      },
    },
    musicRequest: {
      upsert: async (args: { create?: { url?: string } }) => { historyWrites.push(args); return {}; },
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  const runtime = new PlaylistVoteRuntime(() => bot);
  bindPlaylistVoteLifecycle(remote, runtime);
  const handler: any = new MusicCommandHandler(prisma, manager as any);
  handler.setListenerRemote(remote);
  handler.setPlaylistVoteClock(() => now);
  handler.botChannelConfig.set(4, {
    serverConfigId: 2, virtualServerId: 3, defaultChannel: null, commandChannelIds: [],
  });
  handler.musicBotClidsOnServer = () => new Set([99]);
  if (opts.bridge === null) {
    handler.eventBridge = null;
  } else if (opts.bridge === 'throw') {
    handler.eventBridge = {
      executeCommand: async () => { throw new Error('clientlist offline'); },
    };
  } else {
    const thirdRow = opts.threeListeners
      ? `|clid=3 cid=8 client_type=0 client_unique_identifier=${third}`
      : '';
    handler.eventBridge = {
      executeCommand: async () => (
        `clid=1 cid=8 client_type=0 client_unique_identifier=${requester}`
        + `|clid=2 cid=8 client_type=0 client_unique_identifier=${peer}`
        + thirdRow
        + '|clid=99 cid=8 client_type=0 client_unique_identifier=bot\nerror id=0 msg=ok'
      ),
    };
  }

  const openVote = () => {
    runtime.stash('4', '8', {
      botId: 4, playlistId: 1, maxTracks: 25,
      items: [item('100'), item('101')], refreshedAtMs: now,
    });
    const opened = runtime.machine.openVote({
      botKey: '4', channelId: '8', requesterUid: requester,
      playlist: { id: 1, name: 'P', trackCount: 2 },
      settings: { thresholdPercent: 100, windowMs: 60_000, maxTracks: 25 },
      listenerUids: electorate, nowMs: now,
    });
    assert.equal(opened.ok, true);
    return opened.ok ? opened.vote.id : '';
  };

  const command = (msg: string, who: { clid: string; uid: string }) =>
    handler.onTextMessage(4, bot, { invokerid: who.clid, invokeruid: who.uid, msg });

  return {
    bot, queue, runtime, privateReplies, historyWrites, playlist, openVote, command, handler,
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe('B4 !playlistvote chat ballots', () => {
  it('valid yes reaches threshold and queues once with history', async () => {
    const f = await fixture();
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    assert.match(f.privateReplies.at(-1) ?? '', /queued/i);
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    const blob = JSON.stringify(f.privateReplies);
    assert.ok(!blob.includes(requester));
    assert.ok(!blob.includes(peer));
    assert.ok(!blob.includes('/secret/'));
  });

  it('requester no cancels without queueing', async () => {
    const f = await fixture();
    f.openVote();
    await f.command('!playlistvote no', { clid: '1', uid: requester });
    assert.equal(f.queue.length, 0);
    assert.equal(f.historyWrites.length, 0);
    assert.match(f.privateReplies.at(-1) ?? '', /cancelled/i);
  });

  it('rejects non-listener and stale identity', async () => {
    const f = await fixture();
    f.openVote();
    await f.command('!playlistvote yes', { clid: '9', uid: 'outsider' });
    await f.command('!playlistvote yes', { clid: '2', uid: 'wrong-uid' });
    assert.equal(f.queue.length, 0);
    assert.match(f.privateReplies.join('\n'), /verified listener/i);
  });

  it('hidden playlist cannot queue after deadline chat ballot', async () => {
    const f = await fixture({ threeListeners: true });
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0, '2/3 yes keeps vote open');
    f.playlist.remoteAccess = 'hidden';
    f.advance(61_000);
    await f.command('!playlistvote yes', { clid: '3', uid: third });
    assert.equal(f.queue.length, 0);
    assert.equal(f.historyWrites.length, 0);
    assert.match(f.privateReplies.at(-1) ?? '', /ended/i);
  });

  it('post-deadline still-requestable chat ballot queues once with history', async () => {
    const f = await fixture({ threeListeners: true });
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);
    f.advance(61_000);
    // Drop third so live electorate is 2 with 2 yes at settle.
    f.handler.eventBridge = {
      executeCommand: async () => (
        `clid=1 cid=8 client_type=0 client_unique_identifier=${requester}`
        + `|clid=2 cid=8 client_type=0 client_unique_identifier=${peer}`
        + '|clid=99 cid=8 client_type=0 client_unique_identifier=bot\nerror id=0 msg=ok'
      ),
    };
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
  });

  it('usage validation stays private', async () => {
    const f = await fixture();
    await f.command('!playlistvote maybe', { clid: '2', uid: peer });
    assert.match(f.privateReplies.at(-1) ?? '', /Usage/i);
    assert.equal(f.queue.length, 0);
  });

  it('unavailable listener lookup fails closed', async () => {
    const f = await fixture({ bridge: 'throw' });
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);
    assert.match(f.privateReplies.join('\n'), /Could not verify listeners/i);
  });

  it('bot_unavailable cancels open vote so chat cannot approve', async () => {
    const f = await fixture();
    f.openVote();
    f.runtime.cancelBotUnavailable(4, 1_700_000_000_000);
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);
    assert.match(f.privateReplies.at(-1) ?? '', /No open playlist vote/i);
  });

  it('requester revoke cancels open vote', async () => {
    const f = await fixture();
    f.openVote();
    f.runtime.cancelRequesterRevoked(4, requester, f.now());
    assert.equal(f.runtime.machine.getOpen('4', '8'), undefined);
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);
  });

  // Concurrent remote HTTP vs chat races live in
  // `playlist-vote/cross-interface-race.test.ts` (real routes + restash barriers).
});
