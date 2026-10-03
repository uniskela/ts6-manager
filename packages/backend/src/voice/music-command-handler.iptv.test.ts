import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '../../generated/prisma/index.js';
import { MusicCommandHandler } from './music-command-handler.js';

let directory: string;
let prisma: PrismaClient;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ts6-chat-iptv-'));
  const url = `file:${join(directory, 'test.db')}`;
  execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'], {
    cwd: resolve('.'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
  });
  prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.tsServerConfig.create({ data: { id: 1, name: 'Chat server', host: 'localhost', apiKey: 'test' } });
  await prisma.iptvPlaylist.create({ data: { id: 1, name: 'Chat playlist', serverConfigId: 1 } });
});
after(async () => { await prisma?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

function fixture(videoStreaming: boolean, fail = false) {
  const replies: string[] = [];
  const bot = {
    currentConfig: { id: 1, serverConfigId: 1 }, videoStreaming,
    musicSessionInfo: () => null,
    setVideoSource: async () => { if (fail) throw new Error('Stream refused'); },
  };
  const manager = { startVideoStream: async () => { if (fail) throw new Error('Stream refused'); } };
  const handler = new MusicCommandHandler(prisma, manager as any) as any;
  handler.reply = (_bot: unknown, _id: number, message: string) => replies.push(message);
  return { tv: (name: string) => handler.handleTv(bot, 2, name), replies };
}

for (const switching of [false, true]) {
  test(`!tv records a recent after a successful ${switching ? 'source switch' : 'start'}`, async () => {
    const name = switching ? 'Switch channel' : 'Start channel';
    const channel = await prisma.iptvChannel.create({ data: { playlistId: 1, name, tvgId: switching ? null : 'start-key', url: 'https://example.com/live' } });
    const f = fixture(switching);
    await f.tv(name);
    const pick = await prisma.iptvChannelPick.findUnique({ where: { serverConfigId_playlistId_channelKey: { serverConfigId: 1, playlistId: 1, channelKey: switching ? name : 'start-key' } } });
    assert.ok(pick?.lastStreamedAt, 'the successful chat stream must persist its recent');
    assert.equal(pick.name, name);
    assert.equal(pick.favourite, false);
    assert.match(f.replies.at(-1)!, /streaming|stream started/);
    await prisma.iptvChannel.delete({ where: { id: channel.id } });
  });
}

test('!tv does not record a recent when a start fails', async () => {
  await prisma.iptvChannel.create({ data: { playlistId: 1, name: 'Failed channel', url: 'https://example.com/fail' } });
  const f = fixture(false, true);
  await f.tv('Failed channel');
  assert.equal(await prisma.iptvChannelPick.count({ where: { channelKey: 'Failed channel' } }), 0);
  assert.match(f.replies.at(-1)!, /Failed to start stream/);
});

test('!tv never streams or records a matching channel from another server', async () => {
  await prisma.tsServerConfig.create({ data: { id: 2, name: 'Other server', host: 'localhost', apiKey: 'test' } });
  await prisma.iptvPlaylist.create({ data: { id: 2, name: 'Private playlist', serverConfigId: 2 } });
  await prisma.iptvChannel.create({ data: { playlistId: 2, name: 'Private channel', url: 'https://example.com/private' } });
  const f = fixture(false);
  await f.tv('Private channel');
  assert.match(f.replies.at(-1)!, /No channel matching/);
  assert.equal(await prisma.iptvChannelPick.count({ where: { channelKey: 'Private channel' } }), 0);
});
