import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PLAYLIST_VOTE_SETTINGS } from '@ts6/common';
import { PlayQueue, type QueueItem } from '../playlist/queue.js';
import { ListenerRemoteService } from '../listener-remote.js';
import { bindPlaylistVoteLifecycle } from '../playlist-vote/lifecycle.js';
import {
  DEADLINE_SETTLE_GRACE_MS,
  PlaylistVoteRuntime,
} from '../playlist-vote/runtime.js';
import { settleExpiredPlaylistVote } from '../playlist-vote/approval-settle.js';
import { playlistVoteSettingsKey } from '../playlist-vote-settings.js';
import { mediaCommandPermissionsKey } from '../media-command-permissions.js';
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
  settingsEnabled?: boolean;
  maxRequestSize?: number;
  playlistAccess?: string;
  bypassGroups?: number[];
  queueGroups?: number[];
  onlyRequester?: boolean;
} = {}) {
  resetChatReplyCooldownsForTests();
  let now = 1_700_000_000_000;
  const remote = new ListenerRemoteService(() => now);
  const queue = new PlayQueue();
  const historyWrites: Array<{ create?: { url?: string } }> = [];
  const privateReplies: string[] = [];
  const channelMessages: string[] = [];
  const playlist = {
    id: 1,
    name: 'P',
    remoteAccess: opts.playlistAccess ?? 'request',
    songs: [
      { song: { id: 100, title: 'A', artist: null, duration: 1, filePath: '/secret/100.mp3', source: 'local', sourceUrl: null } },
      { song: { id: 101, title: 'B', artist: null, duration: 1, filePath: '/secret/101.mp3', source: 'local', sourceUrl: null } },
    ],
  };
  const electorate = opts.onlyRequester ? [requester] : opts.threeListeners ? [requester, peer, third] : [requester, peer];

  const bot: any = {
    currentConfig: { id: 4, serverConfigId: 2, name: 'Music', password: 'x' },
    ts3ClientId: 99,
    status: 'playing',
    nowPlaying: null,
    stopGeneration: 0,
    queue,
    videoSessionInfo: () => null,
    floodHoldActive: false,
    noteIgnoredCommand: () => undefined,
    getCurrentChannelId: () => 8,
    sendChannelMessage: (text: string) => { channelMessages.push(text); },
    sendTextMessage: (_clid: number, text: string) => { privateReplies.push(text); },
    play: async () => undefined,
  };
  let liveBot: any = bot;
  const manager = {
    getBot: () => liveBot,
    getBotsForServer: async () => [{ bot: liveBot }],
    replaceBot: (next: any) => { liveBot = next; },
  };

  const prisma: any = {
    appSetting: {
      findUnique: async ({ where: { key } }: { where: { key: string } }) => {
        if (key === playlistVoteSettingsKey(2, 3)) {
          return {
            value: JSON.stringify({
              ...DEFAULT_PLAYLIST_VOTE_SETTINGS,
              enabled: opts.settingsEnabled ?? true,
              thresholdPercent: 100,
              maxRequestSize: opts.maxRequestSize ?? 25,
            }),
          };
        }
        if (key === mediaCommandPermissionsKey(2, 3) && opts.bypassGroups) {
          return { value: JSON.stringify({
            playback: { mode: 'everyone' },
            queue: opts.queueGroups ? { mode: 'server_groups', serverGroupIds: opts.queueGroups } : { mode: 'everyone' },
            video: { mode: 'everyone' },
            playlistBypass: { mode: 'server_groups', serverGroupIds: opts.bypassGroups },
          }) };
        }
        return null;
      },
    },
    musicBot: { findUnique: async () => ({ serverConfigId: 2, virtualServerId: 3 }) },
    playlist: {
      findMany: async () => [{ id: playlist.id, name: playlist.name }],
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
    const peerRow = opts.onlyRequester ? '' : `|clid=2 cid=8 client_type=0 client_unique_identifier=${peer}`;
    handler.eventBridge = {
      executeCommand: async (_configId: number, _sid: number, cmd: string) => cmd.startsWith('clientinfo')
        ? `clid=1 cid=8 client_type=0 client_unique_identifier=${requester} client_servergroups=6\nerror id=0 msg=ok`
        : `clid=1 cid=8 client_type=0 client_unique_identifier=${requester}`
          + peerRow
          + thirdRow
          + '|clid=99 cid=8 client_type=0 client_unique_identifier=bot\nerror id=0 msg=ok',
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
    bot, queue, runtime, privateReplies, channelMessages, historyWrites, playlist, openVote, command, handler,
    manager, prisma,
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

type ChatFixture = Awaited<ReturnType<typeof fixture>>;

/** Drop the third listener so the live channel is requester+peer only. */
function shrinkElectorateToTwo(f: ChatFixture): void {
  f.handler.eventBridge = {
    executeCommand: async () => (
      `clid=1 cid=8 client_type=0 client_unique_identifier=${requester}`
      + `|clid=2 cid=8 client_type=0 client_unique_identifier=${peer}`
      + '|clid=99 cid=8 client_type=0 client_unique_identifier=bot\nerror id=0 msg=ok'
    ),
  };
}

function assertNoQueueOrHistory(f: ChatFixture): void {
  assert.equal(f.queue.length, 0);
  assert.equal(f.historyWrites.length, 0);
  assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
}

function assertStoppedBeforeLoad(f: ChatFixture): void {
  assertNoQueueOrHistory(f);
  assert.match(f.privateReplies.at(-1) ?? '', /Playback was stopped before the playlist was loaded/i);
}

describe('B4 !playlistvote chat ballots', () => {
  it('routes chat !playlist through the shared vote and records history after approval', async () => {
    const f = await fixture();
    await f.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(f.queue.length, 0);
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 1);
    assert.match(f.channelMessages[0] ?? '', /2 tracks/);
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
  });

  it('keeps direct chat playlist queueing when voting is disabled', async () => {
    const f = await fixture({ settingsEnabled: false });
    await f.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(f.queue.length, 2);
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    assert.equal(f.historyWrites.length, 2);
  });

  it('refuses oversized or non-requestable chat playlists before opening a vote', async () => {
    const large = await fixture({ maxRequestSize: 1 });
    await large.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(large.queue.length, 0);
    assert.equal(large.runtime.machine.listOpenForBot('4').length, 0);
    assert.match(large.privateReplies.at(-1) ?? '', /limited to 1 tracks/);

    const browseOnly = await fixture({ playlistAccess: 'browse' });
    await browseOnly.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(browseOnly.queue.length, 0);
    assert.equal(browseOnly.runtime.machine.listOpenForBot('4').length, 0);
    assert.match(browseOnly.privateReplies.at(-1) ?? '', /does not allow/);
  });

  it('allows only explicitly selected live server groups to bypass the vote', async () => {
    const permitted = await fixture({ bypassGroups: [6] });
    await permitted.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(permitted.queue.length, 2);
    assert.equal(permitted.runtime.machine.listOpenForBot('4').length, 0);
    assert.match(permitted.privateReplies.at(-1) ?? '', /without a vote/);

    const denied = await fixture({ bypassGroups: [7] });
    await denied.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(denied.queue.length, 0);
    assert.equal(denied.runtime.machine.listOpenForBot('4').length, 1);

    const queueDenied = await fixture({ bypassGroups: [6], queueGroups: [7] });
    await queueDenied.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(queueDenied.queue.length, 0, 'bypass never waives queue permission');
    assert.equal(queueDenied.runtime.machine.listOpenForBot('4').length, 0);
  });

  it('requires the requester to match a live channel identity and auto-queues for one listener', async () => {
    const forged = await fixture();
    await forged.command('!playlist P', { clid: '1', uid: 'stale-uid' });
    assert.equal(forged.queue.length, 0);
    assert.equal(forged.runtime.machine.listOpenForBot('4').length, 0);

    const alone = await fixture({ onlyRequester: true });
    await alone.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(alone.queue.length, 2);
    assert.equal(alone.runtime.machine.listOpenForBot('4').length, 0);
    assert.equal(alone.historyWrites.length, 2);
  });

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

  it('lazy settle without a chat deadline timer still queues once when threshold is met', async () => {
    // Remote-style open (no chat timer). Chat-opened votes use the R2-1 timer path below.
    const f = await fixture({ threeListeners: true });
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);
    f.advance(61_000);
    // Drop third so live electorate is 2 with 2 yes at settle.
    shrinkElectorateToTwo(f);
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
  // `listener-remote.playlist-requests.test.ts` (B4 cross-interface describe) (real routes + restash barriers).
});

describe('R2-1 chat deadline settlement', () => {
  it('settles a quiet chat vote at the deadline without further traffic', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 1);
    assert.equal(f.queue.length, 0);

    f.advance(60_000);
    await f.runtime.runDueChatDeadlineSettlements(f.now());

    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    assert.equal(f.queue.length, 0);
    assert.equal(f.historyWrites.length, 0);
    assert.match(f.channelMessages.join('\n'), /Playlist vote failed:.*"P".*not enough yes votes/i);

    // Exactly once: a second due pass and a late ballot do nothing.
    const announces = f.channelMessages.length;
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);
    assert.equal(f.historyWrites.length, 0);
    assert.equal(f.channelMessages.length, announces);
  });

  it('fails closed when deadline listener lookup is unavailable', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    f.handler.eventBridge = {
      executeCommand: async () => { throw new Error('clientlist offline'); },
    };
    f.advance(60_000);
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    assert.equal(f.queue.length, 0);
    assert.equal(f.historyWrites.length, 0);
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    assert.match(f.channelMessages.join('\n'), /playlist unavailable/i);
  });

  it('does not approve a delayed callback against a later smaller electorate', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);

    // Far past the grace window; shrink the live channel to 2/2 yes.
    f.advance(10 * 60_000);
    shrinkElectorateToTwo(f);
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    assert.equal(f.queue.length, 0, 'delayed settle must fail closed');
    assertNoQueueOrHistory(f);

    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);
  });

  it('passes at the deadline when the live electorate meets threshold', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);

    f.advance(60_000);
    shrinkElectorateToTwo(f);
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    assert.match(f.channelMessages.join('\n'), /Playlist vote passed/i);

    // Cooldown / exactly-once: timer+ballot concurrency cannot double-queue.
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
  });

  it('cancels a pending deadline timer when the vote is cancelled', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    f.runtime.cancelBotUnavailable(4, f.now());
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    f.advance(60_000);
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    assert.equal(f.queue.length, 0);
    assert.equal(f.historyWrites.length, 0);
  });

  it('arms failed-requester cooldown after a quiet deadline failure', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    f.advance(60_000);
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    resetChatReplyCooldownsForTests();
    await f.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    assert.match(f.privateReplies.at(-1) ?? '', /Too many playlist requests/i);
  });
});

describe('R2-2 stop-generation continuity', () => {
  it('refuses bypass queueDirect after Stop during async lookup', async () => {
    const f = await fixture({ bypassGroups: [6] });
    const original = f.handler.eventBridge.executeCommand;
    f.handler.eventBridge = {
      executeCommand: async (...args: unknown[]) => {
        f.bot.stopGeneration += 1;
        return original(...args);
      },
    };
    await f.command('!playlist P', { clid: '1', uid: requester });
    assertStoppedBeforeLoad(f);
  });

  it('refuses openVote after bot replacement during async lookup', async () => {
    const f = await fixture();
    const original = f.handler.eventBridge.executeCommand;
    f.handler.eventBridge = {
      executeCommand: async (...args: unknown[]) => {
        f.manager.replaceBot({ ...f.bot, stopGeneration: f.bot.stopGeneration + 1 });
        return original(...args);
      },
    };
    await f.command('!playlist P', { clid: '1', uid: requester });
    assertStoppedBeforeLoad(f);
  });

  it('refuses openVote after queue clear bumps stopGeneration during clientlist', async () => {
    const f = await fixture();
    let sawClientlist = false;
    const original = f.handler.eventBridge.executeCommand;
    f.handler.eventBridge = {
      executeCommand: async (configId: number, sid: number, cmd: string) => {
        if (cmd.startsWith('clientlist')) {
          sawClientlist = true;
          f.bot.stopGeneration += 1;
        }
        return original(configId, sid, cmd);
      },
    };
    await f.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(sawClientlist, true);
    assertStoppedBeforeLoad(f);
  });
});

describe('R2-3 sole-listener queue-full reply', () => {
  it('does not claim a vote started when sole-listener open fails as queue_full', async () => {
    const f = await fixture({ onlyRequester: true });
    f.queue.addMany(Array.from({ length: 499 }, (_, i) => item(`pad-${i}`)));
    await f.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(f.queue.length, 499, 'nothing from the playlist was queued');
    assert.equal(f.historyWrites.length, 0);
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    assert.match(f.channelMessages.join('\n'), /queue full/i);
    assert.match(f.privateReplies.at(-1) ?? '', /The queue is full/i);
    assert.ok(!(f.privateReplies.at(-1) ?? '').includes('vote started'));
  });
});

describe('R2D deadline settlement safety', () => {
  it('fail-closes when playlist reload throws at the deadline (R2D-1)', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 1);

    const originalFind = f.prisma.playlist.findFirst.bind(f.prisma.playlist);
    f.prisma.playlist.findFirst = async () => {
      throw new Error('db unavailable during restash');
    };

    f.advance(60_000);
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    f.prisma.playlist.findFirst = originalFind;

    assertNoQueueOrHistory(f);
    assert.match(f.channelMessages.join('\n'), /playlist unavailable/i);

    const announces = f.channelMessages.length;
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    assert.equal(f.channelMessages.length, announces, 'result announced exactly once');
  });

  it('does not mutate a cancelled or replaced vote after a settlement exception (R2D-1)', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    const open = f.runtime.machine.getOpen('4', '8');
    assert.ok(open);

    f.runtime.cancelChatDeadlineSettlement('4', '8');
    let settleCalls = 0;
    f.runtime.scheduleChatDeadlineSettlement({
      botKey: '4',
      channelId: '8',
      voteId: open.id,
      deadlineMs: open.deadlineMs,
      getNow: () => f.now(),
      settle: async () => {
        settleCalls += 1;
        f.runtime.cancelBotUnavailable(4, f.now());
        throw new Error('settle blew up after cancel');
      },
    });

    f.advance(60_000);
    const before = f.channelMessages.length;
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    assert.equal(settleCalls, 1);
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    assert.equal(f.queue.length, 0);
    assert.equal(f.historyWrites.length, 0);
    // cancelBotUnavailable already announced cancelled; exception must not add a failed result.
    assert.equal(
      f.channelMessages.slice(before).filter((m) => /failed/i.test(m)).length,
      0,
    );
  });

  it('treats a slow listener lookup past grace as unavailable (R2D-2)', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);

    f.handler.eventBridge = {
      executeCommand: async () => {
        // Lookup begins on time but finishes beyond the grace window.
        f.advance(DEADLINE_SETTLE_GRACE_MS + 1);
        return (
          `clid=1 cid=8 client_type=0 client_unique_identifier=${requester}`
          + `|clid=2 cid=8 client_type=0 client_unique_identifier=${peer}`
          + '|clid=99 cid=8 client_type=0 client_unique_identifier=bot\nerror id=0 msg=ok'
        );
      },
    };

    f.advance(60_000);
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    assertNoQueueOrHistory(f);
    assert.match(f.channelMessages.join('\n'), /playlist unavailable/i);
  });

  it('allows a timely verified electorate to pass at the deadline (R2D-2)', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0);

    f.advance(60_000);
    shrinkElectorateToTwo(f);
    await f.runtime.runDueChatDeadlineSettlements(f.now());
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    assert.match(f.channelMessages.join('\n'), /Playlist vote passed/i);
  });

  it('timer and ballot concurrency cannot double-queue (R2D)', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    f.advance(60_000);
    shrinkElectorateToTwo(f);

    await Promise.all([
      f.runtime.runDueChatDeadlineSettlements(f.now()),
      f.command('!playlistvote yes', { clid: '2', uid: peer }),
    ]);
    assert.equal(f.queue.length, 2);
    assert.equal(f.historyWrites.length, 2);
    const passAnnounces = f.channelMessages.filter((m) => /Playlist vote passed/i.test(m));
    assert.equal(passAnnounces.length, 1);
  });

  it('fires the real unref deadline timer without runDue (R2D)', async () => {
    const f = await fixture({ threeListeners: true });
    await f.command('!playlist P', { clid: '1', uid: requester });
    const open = f.runtime.machine.getOpen('4', '8');
    assert.ok(open);

    // Fake clock past the vote deadline; replace the 60s wall timer with delay-0 setTimeout.
    f.advance(60_000);
    f.runtime.cancelChatDeadlineSettlement('4', '8');
    f.runtime.scheduleChatDeadlineSettlement({
      botKey: '4',
      channelId: '8',
      voteId: open.id,
      deadlineMs: open.deadlineMs,
      getNow: () => f.now(),
      settle: async (nowMs) => {
        await settleExpiredPlaylistVote({
          runtime: f.runtime,
          botId: 4,
          channelId: 8,
          serverConfigId: 2,
          listenerUids: [requester, peer, third],
          maxTracks: 25,
          nowMs,
          announceBot: f.bot,
          loadPlaylist: async () => f.playlist as any,
        });
      },
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('real timer did not fire')), 200);
      const poll = setInterval(() => {
        if (f.runtime.machine.listOpenForBot('4').length === 0) {
          clearInterval(poll);
          clearTimeout(t);
          resolve();
        }
      }, 5);
    });

    assertNoQueueOrHistory(f);
    assert.match(f.channelMessages.join('\n'), /not enough yes votes/i);
  });
});

describe('Kody: expired !playlist lazy settlement', () => {
  it('reports a queued expired vote without trying to reopen it during cooldown', async () => {
    // Remote-style vote has no chat deadline timer; the next !playlist settles it.
    const f = await fixture({ threeListeners: true });
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    assert.equal(f.queue.length, 0, '2/3 yes does not pass yet');

    f.advance(60_000);
    shrinkElectorateToTwo(f);
    await f.command('!playlist P', { clid: '1', uid: requester });

    assert.equal(f.queue.length, 2, 'expired vote queued the playlist once');
    assert.equal(f.historyWrites.length, 2, 'history recorded once per track');
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0, 'no new vote opened');
    assert.match(f.privateReplies.at(-1) ?? '', /Playlist vote passed.*queued/i);
    assert.doesNotMatch(f.privateReplies.at(-1) ?? '', /Too many playlist requests/i);
    assert.equal(
      f.channelMessages.filter((m) => /Playlist vote passed/i.test(m)).length,
      1,
      'one pass announcement',
    );
  });

  it('reports an expired failed vote accurately without opening a replacement', async () => {
    const f = await fixture({ threeListeners: true });
    f.openVote();
    f.advance(60_000);
    await f.command('!playlist P', { clid: '1', uid: requester });

    assertNoQueueOrHistory(f);
    assert.match(f.channelMessages.join('\n'), /Playlist vote failed/i);
    assert.match(f.privateReplies.at(-1) ?? '', /That playlist vote failed/i);
    assert.doesNotMatch(f.privateReplies.at(-1) ?? '', /Too many playlist requests/i);
  });

  it('keeps late lazy settlement fail-closed and never reopens the expired vote', async () => {
    const f = await fixture({ threeListeners: true });
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    f.advance(60_000 + DEADLINE_SETTLE_GRACE_MS + 1);
    shrinkElectorateToTwo(f);
    await f.command('!playlist P', { clid: '1', uid: requester });

    assertNoQueueOrHistory(f);
    assert.match(f.channelMessages.join('\n'), /playlist unavailable/i);
    assert.match(f.privateReplies.at(-1) ?? '', /That playlist vote failed/i);
  });
});

describe('Kody: concurrent and unrelated expired playlist settlement', () => {
  it('recognises a passed vote settled concurrently by another worker', async () => {
    const f = await fixture({ threeListeners: true });
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    f.advance(60_000);
    shrinkElectorateToTwo(f);

    const originalFind = f.prisma.playlist.findFirst.bind(f.prisma.playlist);
    let selections = 0;
    let releaseLookup!: () => void;
    let lookupReached!: () => void;
    const lookupWaiting = new Promise<void>((resolve) => { lookupReached = resolve; });
    const lookupReleased = new Promise<void>((resolve) => { releaseLookup = resolve; });
    f.prisma.playlist.findFirst = async (args: any) => {
      // Hold the second select (restash) to reproduce another settler closing
      // this vote during the awaited lookup.
      if (args.select && ++selections === 2) {
        lookupReached();
        await lookupReleased;
      }
      return originalFind(args);
    };

    const pendingRequest = f.command('!playlist P', { clid: '1', uid: requester });
    await lookupWaiting;
    const concurrent = await settleExpiredPlaylistVote({
      runtime: f.runtime,
      botId: 4,
      channelId: 8,
      serverConfigId: 2,
      listenerUids: [requester, peer],
      maxTracks: 25,
      nowMs: f.now(),
      announceBot: f.bot,
      loadPlaylist: async () => f.playlist as any,
      onQueued: async (start) => {
        for (const item of start.items) {
          await f.prisma.musicRequest.upsert({ create: { url: item.id } });
        }
      },
    });
    assert.equal(concurrent.queued, true);
    releaseLookup();
    await pendingRequest;

    assert.equal(f.queue.length, 2, 'queued only once');
    assert.equal(f.historyWrites.length, 2, 'history recorded only once');
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    assert.match(f.privateReplies.at(-1) ?? '', /Playlist vote passed.*queued/i);
    assert.doesNotMatch(f.privateReplies.at(-1) ?? '', /vote failed|vote has ended|Too many playlist requests/i);
    assert.equal(f.channelMessages.filter((m) => /Playlist vote passed/i.test(m)).length, 1);
  });

  it('does not claim someone else\'s expired vote queued the caller\'s different playlist', async () => {
    const f = await fixture({ threeListeners: true });
    f.openVote();
    await f.command('!playlistvote yes', { clid: '2', uid: peer });
    f.advance(60_000);
    shrinkElectorateToTwo(f);

    const anotherPlaylist = { ...f.playlist, id: 2, name: 'X' };
    f.prisma.playlist.findMany = async () => [{ id: 1, name: 'P' }, { id: 2, name: 'X' }];
    const originalFind = f.prisma.playlist.findFirst.bind(f.prisma.playlist);
    f.prisma.playlist.findFirst = async (args: any) =>
      args.where?.id === 2 ? anotherPlaylist : originalFind(args);

    await f.command('!playlist X', { clid: '2', uid: peer });

    assert.equal(f.queue.length, 2, 'only the earlier vote for P was settled');
    assert.equal(f.historyWrites.length, 2);
    assert.equal(f.runtime.machine.listOpenForBot('4').length, 0);
    assert.match(f.privateReplies.at(-1) ?? '', /Your playlist was not queued/i);
    assert.doesNotMatch(f.privateReplies.at(-1) ?? '', /Playlist vote passed.*queued|Too many playlist requests/i);
    assert.equal(f.channelMessages.filter((m) => /Playlist vote passed/i.test(m)).length, 1);
  });
});
