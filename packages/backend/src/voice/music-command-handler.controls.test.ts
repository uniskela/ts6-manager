import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MusicCommandHandler } from './music-command-handler.js';
import { PlayQueue } from './playlist/queue.js';
import { BUILTIN_COMMAND_HELP, isReservedChatCommandName } from './chat-commands.js';

function fixture(status = 'connected') {
  const replies: string[] = [];
  const played: any[] = [];
  const seeks: number[] = [];
  const playlists = [{ id: 3, name: 'Rock' }, { id: 4, name: 'Rock live' }];
  const prisma = { playlist: {
    findMany: async ({ where }: any) => {
      assert.equal(where.serverConfigId, 9);
      assert.deepEqual(where.OR, [{ musicBotId: 1 }, { musicBotId: null }]);
      return playlists;
    },
    findFirst: async ({ where }: any) => {
      assert.equal(where.serverConfigId, 9);
      return { name: 'Rock', songs: [{ song: { id: 7, title: 'Track', filePath: '', source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' } }] };
    },
  } } as any;
  const handler = new MusicCommandHandler(prisma, {} as any) as any;
  handler.reply = (_bot: unknown, _id: number, message: string) => replies.push(message);
  const bot = { currentConfig: { id: 1, serverConfigId: 9 }, ts3ClientId: 42,
    queue: new PlayQueue(), status, nowPlaying: null, canSeek: true,
    playbackProgress: { position: 60, duration: 100 },
    play: async (item: any) => played.push(item), seek: async (n: number) => seeks.push(n),
    clearPlayback: () => {},
  };
  const command = (msg: string) => handler.onTextMessage(1, bot, { invokerid: '2', msg });
  return { bot, command, replies, played, seeks, playlists };
}

test('new commands and aliases are reserved and documented', () => {
  for (const name of ['playlist', 'pl', 'repeat', 'seek', 'remove']) {
    assert.ok(isReservedChatCommandName(name.toUpperCase()));
    assert.ok(BUILTIN_COMMAND_HELP.some(h => h.name === name));
  }
});
test('playlist ID/name/alias resolution, bounded lists and ambiguity', async () => {
  const f = fixture();
  await f.command('!pl 3');
  assert.equal(f.played.length, 1);
  assert.equal(f.played[0].sourceUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
  await f.command('!playlist ROCK');
  assert.equal(f.bot.queue.length, 2);
  await f.command('!playlist roc');
  assert.match(f.replies.at(-1)!, /Ambiguous/);
  f.playlists.push({ id: 5, name: 'rock' });
  await f.command('!playlist rock');
  assert.match(f.replies.at(-1)!, /Ambiguous/);
  for (let i = 10; i < 100; i++) f.playlists.push({ id: i, name: 'x'.repeat(200) });
  await f.command('!playlist');
  assert.ok(f.replies.at(-1)!.length < 900);
});
test('playing and paused playlists append without interrupting', async () => {
  for (const status of ['playing', 'paused', 'stopped']) {
    const f = fixture(status);
    await f.command('!playlist 3');
    assert.equal(f.bot.queue.length, 1);
    assert.equal(f.played.length, 0);
  }
});
test('repeat and strict absolute/relative seek parsing, clamping, unseekable sources', async () => {
  const f = fixture();
  await f.command('!repeat'); assert.match(f.replies.at(-1)!, /off/);
  for (const mode of ['track', 'queue', 'off']) {
    await f.command(`!repeat ${mode}`); assert.equal(f.bot.queue.repeat, mode);
  }
  await f.command('!repeat bogus'); assert.match(f.replies.at(-1)!, /Usage/);
  for (const value of ['90', '+30', '-15', '+999', '-999']) await f.command(`!seek ${value}`);
  assert.deepEqual(f.seeks, [90, 90, 45, 100, 0]);
  for (const value of ['1x', 'Infinity', '', '--3']) await f.command(`!seek ${value}`);
  assert.equal(f.seeks.length, 5);
  f.bot.canSeek = false; await f.command('!seek 1');
  assert.match(f.replies.at(-1)!, /cannot be seeked/);
});
test('remove searches only upcoming tracks, refuses ambiguity and removes duplicate IDs by position', async () => {
  const f = fixture();
  const track = (title: string) => ({ id: 'duplicate', title, artist: 'Artist', filePath: '', source: 'local' as const });
  f.bot.queue.addMany([track('Current'), track('Unique'), track('Other')]);
  f.bot.queue.playAt(0);
  await f.command('!remove current'); assert.equal(f.bot.queue.length, 3);
  await f.command('!remove artist'); assert.match(f.replies.at(-1)!, /Multiple/);
  await f.command('!remove UNIQUE');
  assert.deepEqual(f.bot.queue.getAll().map(x => x.title), ['Current', 'Other']);
  await f.command('!queue remove 2junk'); assert.equal(f.bot.queue.length, 2);
  await f.command('!queue play NaN'); assert.equal(f.played.length, 0);
  await f.command('!queue remove 2'); assert.equal(f.bot.queue.current?.title, 'Current');
  await f.command('!queue clear'); assert.equal(f.bot.queue.length, 0);
});


test('idle playlist append resumes existing queue order instead of jumping past queued tracks', async () => {
  const f = fixture();
  f.bot.queue.add({ id: 'existing', title: 'Already queued', filePath: '/tmp/existing.ogg', source: 'local' });
  await f.command('!playlist 3');
  assert.equal(f.bot.queue.length, 2);
  assert.equal(f.played.length, 1);
  assert.equal(f.played[0].title, 'Already queued');
});
