import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { PlayQueue } from './playlist/queue.js';
import { BUILTIN_COMMAND_HELP, isReservedChatCommandName } from './chat-commands.js';

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-'));
process.env.MUSIC_DIR = musicDir;
const { MusicCommandHandler } = await import('./music-command-handler.js');
after(() => fs.rmSync(musicDir, { recursive: true, force: true }));

const row = (id: number, overrides: object = {}) => ({
  id, serverConfigId: 9, musicBotId: 1, title: `Request ${id}`, source: 'youtube',
  url: `https://8.8.8.8/media/${id}`, status: 'available', requestedAt: new Date('2026-10-11T12:30:00Z'), ...overrides,
});

function fixture(rows = [row(1)], status = 'connected', policy: object | null = null) {
  const replies: string[] = [], enqueued: string[] = [], played: any[] = [], saved: any[] = [], marked: number[] = [];
  let moves = 0;
  const queries: any[] = [];
  const matches = (item: ReturnType<typeof row>, where: any) => item.serverConfigId === where.serverConfigId
    && (!where.OR || where.OR.some((part: any) => part.musicBotId === item.musicBotId))
    && (where.id == null || where.id === item.id);
  const select = (where: any) => rows.filter(item => matches(item, where)).sort((a, b) =>
    b.requestedAt.getTime() - a.requestedAt.getTime() || b.id - a.id);
  const prisma: any = {
    appSetting: { findUnique: async () => policy ? { value: JSON.stringify(policy) } : null },
    musicBot: { findUnique: async () => ({ serverConfigId: 9, virtualServerId: 2 }) },
    musicRequest: {
      findMany: async (args: any) => { queries.push(args); return args.skip == null ? select(args.where).slice(0, args.take) : select(args.where).slice(args.skip); },
      findFirst: async (args: any) => { queries.push(args); return select(args.where)[0] ?? null; },
      update: async ({ where }: any) => { marked.push(where.id); },
      deleteMany: async () => {},
    },
  };
  const bot: any = {
    currentConfig: { id: 1, serverConfigId: 9 }, ts3ClientId: 42, queue: new PlayQueue(), status,
    getCurrentChannelId: () => 5, assertMusicCanStart: () => {},
    play: async (item: any) => { played.push(item); }, playStream: async (item: any) => { played.push(item); },
  };
  const manager: any = { getBot: () => bot };
  const handler: any = new MusicCommandHandler(prisma, manager);
  handler.botChannelConfig.set(1, { serverConfigId: 9, virtualServerId: 2 });
  handler.reply = async (_bot: unknown, _id: number, message: string) => { replies.push(message); };
  handler.joinChannelForCommand = async () => { moves++; };
  handler.chatMusicSwitch = () => ({ replaceSessionIds: ['own-video'] });
  handler.saveMusicRequest = (_bot: unknown, item: unknown) => { saved.push(item); };
  handler.enqueueMediaUrl = async (_id: number, _bot: unknown, _clid: number, url: string) => { enqueued.push(url); };
  const command = (msg: string) => handler.onTextMessage(1, bot, { invokerid: '2', msg });
  return { command, bot, handler, manager, prisma, replies, enqueued, played, saved, marked, queries, moves: () => moves };
}

test('history and again are reserved and included in built-in help', () => {
  for (const name of ['history', 'again']) {
    assert.ok(isReservedChatCommandName(name));
    assert.ok(BUILTIN_COMMAND_HELP.some(entry => entry.name === name));
  }
});

test('history lists ten recent scoped requests with safe titles, sources and UTC times', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1));
  rows.push(row(99, { musicBotId: 0, title: '<img src=x> [URL]bad[/URL]\n**fake**', source: 'radio', status: 'unavailable' }));
  rows.push(row(100, { musicBotId: 2 }), row(101, { serverConfigId: 10 }));
  const f = fixture(rows);
  await f.command('!history');
  const listQuery = f.queries.find(query => query.take === 10);
  assert.deepEqual(listQuery.where, { serverConfigId: 9, OR: [{ musicBotId: 1 }, { musicBotId: 0 }] });
  assert.deepEqual(f.queries[0].where, { serverConfigId: 9, musicBotId: 0 });
  const text = f.replies[0];
  assert.equal(text.split('\n').filter(line => line.startsWith('#')).length, 10);
  assert.match(text, /#99 .*radio.*2026-10-11 12:30 UTC \(unavailable\)/);
  assert.match(text, /&lt;img src=x&gt;/);
  assert.doesNotMatch(text, /\[URL\]|<img|\*\*fake\*\*|https:\/\/|#100|#101/);
  assert.equal(f.moves(), 0);
});

test('again defaults to latest and replays the stored reference without searching a title', async () => {
  const f = fixture([row(1), row(2, { title: 'Misleading search title', musicBotId: 0 })]);
  f.handler.findSong = () => { throw new Error('history must not search titles'); };
  await f.command('!again');
  await f.command('!again 1');
  assert.deepEqual(f.enqueued, ['https://8.8.8.8/media/2', 'https://8.8.8.8/media/1']);
});

test('again refuses foreign server/bot IDs and malformed IDs without playback', async () => {
  const f = fixture([row(1, { serverConfigId: 10 }), row(2, { musicBotId: 2 })]);
  for (const cmd of ['!again 1', '!again 2', '!again']) await f.command(cmd);
  assert.deepEqual(f.enqueued, []);
  assert.equal(f.moves(), 0);
  assert.ok(f.replies.every(message => /Request not found/.test(message)));
  const queryCount = f.queries.length;
  for (const id of ['-1', '0', '1x', '1.5', '9007199254740992']) await f.command(`!again ${id}`);
  assert.equal(f.queries.length, queryCount);
  assert.match(f.replies.at(-1)!, /Usage/);
});

test('again validates private URLs and missing files and marks requests unavailable', async () => {
  const f = fixture([row(1, { url: 'http://127.0.0.1/private' }), row(2, { source: 'local', url: 'missing.ogg' })]);
  await f.command('!again 1');
  await f.command('!again 2');
  assert.deepEqual(f.marked, [1, 2]);
  assert.deepEqual(f.enqueued, []);
  assert.equal(f.bot.queue.length, 0);
  assert.ok(f.replies.every(message => message === 'This media is no longer available.'));
});

test('again marks definite removed-source failures without mislabeling connection or tool errors', async () => {
  for (const message of ['This video is unavailable', 'HTTP Error 404', 'yt-dlp not found', 'Bot is not connected']) {
    const f = fixture();
    f.handler.enqueueMediaUrl = async () => { throw new Error(message); };
    await f.command('!again');
    const unavailable = message === 'This video is unavailable' || message === 'HTTP Error 404';
    assert.deepEqual(f.marked, unavailable ? [1] : []);
    assert.equal(f.replies[0], unavailable ? 'This media is no longer available.' : `Error: ${message}`);
  }
});

test('radio and saved playlist commands record accepted canonical items with metadata', async () => {
  const f = fixture();
  f.prisma.radioStation = { findMany: async () => [{ id: 3, name: 'Station', genre: 'Jazz', url: 'https://8.8.8.8/radio' }] };
  await f.command('!radio 3');
  assert.equal(f.saved[0].streamUrl, 'https://8.8.8.8/radio');
  f.prisma.playlist = {
    findMany: async () => [{ id: 7, name: 'Saved playlist' }],
    findFirst: async () => ({ name: 'Saved playlist', songs: [{ song: {
      id: 11, title: 'Saved song', artist: 'Artist', duration: 120, filePath: 'song.ogg', source: 'local', sourceUrl: null,
    } }] }),
  };
  await f.command('!playlist 7');
  assert.equal(f.saved[1].filePath, 'song.ogg');
  assert.equal(f.saved[1].artist, 'Artist');
  assert.equal(f.saved[1].duration, 120);
});

test('local and radio replays use normal start guards and queue while playing or paused', async () => {
  fs.writeFileSync(path.join(musicDir, 'track.ogg'), 'fixture');
  for (const source of ['local', 'radio']) for (const status of ['connected', 'playing', 'paused']) {
    const f = fixture([row(1, { source, url: source === 'local' ? 'track.ogg' : 'https://8.8.8.8/radio' })], status);
    let guarded = 0;
    f.bot.assertMusicCanStart = (ids: string[]) => { assert.deepEqual(ids, ['own-video']); guarded++; };
    await f.command('!again');
    assert.equal(f.bot.queue.length, 1);
    assert.equal(f.played.length, status === 'connected' ? 1 : 0);
    assert.equal(guarded, status === 'connected' ? 1 : 0);
    assert.equal(f.saved.length, 1);
    assert.match(f.replies[0], status === 'connected' ? /Now playing/ : /Queued/);
  }
  const conflict = fixture([row(1, { source: 'radio', url: 'https://8.8.8.8/radio' })]);
  conflict.bot.assertMusicCanStart = () => { throw new Error('A stream is starting'); };
  await conflict.command('!again');
  assert.equal(conflict.bot.queue.length, 0);
  assert.equal(conflict.saved.length, 0);
  assert.equal(conflict.played.length, 0);
  assert.deepEqual(conflict.marked, []);
});

test('again is gated by playback roles while history remains readable', async () => {
  const restricted = { playback: { mode: 'server_groups', serverGroupIds: [] }, queue: { mode: 'everyone' }, video: { mode: 'everyone' } };
  const f = fixture([row(1)], 'connected', restricted);
  f.bot.sendTextMessage = () => {};
  await f.command('!again');
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.enqueued, []);
  await f.command('!history');
  assert.match(f.replies[0], /Recent requests/);
});

test('stop, bot replacement and server changes discard a pending history replay', async () => {
  for (const change of ['stop', 'replace', 'server', 'virtual-server']) {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.prisma.musicRequest.findFirst = () => new Promise(done => { resolve = done; });
    const replay = f.command('!again');
    await new Promise(done => setImmediate(done));
    assert.ok(resolve);
    if (change === 'stop') {
      f.bot.stopAudio = () => {};
      await f.command('!stop');
    } else if (change === 'replace') f.manager.getBot = () => ({ ...f.bot });
    else if (change === 'server') f.bot.currentConfig.serverConfigId = 10;
    else f.handler.botChannelConfig.get(1).virtualServerId = 3;
    resolve(row(1));
    await replay;
    assert.deepEqual(f.enqueued, [], change);
    assert.equal(f.moves(), 0, change);
  }
});
