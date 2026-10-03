import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { PrismaClient } from '../../generated/prisma/index.js';
import { iptvRoutes } from './iptv.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { recordIptvRecent } from '../iptv/iptv-picks.js';
import { refreshPlaylist } from '../iptv/iptv-service.js';
import { writeIptvSourceFile, deleteIptvSourceFile } from '../iptv/iptv-storage.js';

const directory = mkdtempSync(join(tmpdir(), 'iptv-picks-'));
const databaseUrl = `file:${join(directory, 'test.db')}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let serverId: number;
let otherServerId: number;
let playlistId: number;
let otherPlaylistId: number;
let channel: Awaited<ReturnType<typeof prisma.iptvChannel.create>>;
let role = 'admin';
let streamFails = false;
let streaming = false;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, role: role as 'admin', username: 'tester' }; next(); });
app.locals.prisma = prisma;
app.locals.voiceBotManager = {
  getBot: () => ({ id: 1, currentConfig: { serverConfigId: serverId }, videoStreaming: streaming,
    setVideoSource: async () => { if (streamFails) throw new Error('Stream failed'); } }),
  assertVideoCanStart: () => {},
  off: () => {},
  startVideoStream: async () => { if (streamFails) throw new Error('Stream failed'); },
};
app.use('/api/iptv', iptvRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');

async function send(path: string, method = 'GET', body?: unknown) {
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/api/iptv${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
function pickBody() { return { serverConfigId: serverId, playlistId, channelKey: 'station-1' }; }

before(async () => {
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
  });
});
beforeEach(async () => {
  await prisma.tsServerConfig.deleteMany();
  await prisma.adminAuditEvent.deleteMany();
  const data = { name: 'Server', host: 'localhost', apiKey: 'fixture' };
  serverId = (await prisma.tsServerConfig.create({ data })).id;
  otherServerId = (await prisma.tsServerConfig.create({ data })).id;
  playlistId = (await prisma.iptvPlaylist.create({ data: { name: 'TV', serverConfigId: serverId } })).id;
  otherPlaylistId = (await prisma.iptvPlaylist.create({ data: { name: 'Private', serverConfigId: otherServerId } })).id;
  channel = await prisma.iptvChannel.create({ data: { playlistId, name: 'Station One', tvgId: 'station-1', url: 'https://example.test/live' } });
  role = 'admin'; streamFails = false; streaming = false;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe('IPTV favourites and recent', () => {
  it('keeps a favourite after a real playlist refresh recreates channel IDs', async () => {
    assert.equal((await send('/favourites', 'PUT', pickBody())).status, 200);
    const path = writeIptvSourceFile('#EXTM3U\n#EXTINF:-1 tvg-id="station-1",Station One\nhttps://example.test/live\n', 'fixture.m3u');
    try {
      await prisma.iptvPlaylist.update({ where: { id: playlistId }, data: { sourceType: 'upload', sourcePath: path } });
      await refreshPlaylist(prisma, playlistId);
      const response = await send(`/favourites?serverConfigId=${serverId}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.length, 1);
      assert.equal(response.body[0].channelKey, 'station-1');
      assert.notEqual(response.body[0].channel.id, channel.id);
      assert.equal(response.body[0].channel.name, 'Station One');
    } finally { deleteIptvSourceFile(path); }
  });

  it('returns a missing channel with its saved name and supports Remove', async () => {
    await send('/favourites', 'PUT', pickBody());
    await recordIptvRecent(prisma, serverId, channel);
    await prisma.iptvChannel.delete({ where: { id: channel.id } });
    const response = await send(`/favourites?serverConfigId=${serverId}`);
    assert.equal(response.body[0].name, 'Station One');
    assert.equal(response.body[0].channel, null);
    assert.equal((await send('/favourites', 'DELETE', { ...pickBody(), removeRecent: true })).status, 200);
    assert.deepEqual((await send(`/recent?serverConfigId=${serverId}`)).body, []);
  });

  it('uses the name key only for a channel without tvg-id', async () => {
    await prisma.iptvChannel.update({ where: { id: channel.id }, data: { tvgId: null } });
    assert.equal((await send('/favourites', 'PUT', { ...pickBody(), channelKey: channel.name })).status, 200);
    assert.equal((await send('/favourites', 'PUT', { ...pickBody(), channelKey: 'missing' })).status, 404);
  });

  it('does not resolve a missing tvg-id to another channel bearing that name', async () => {
    await send('/favourites', 'PUT', pickBody());
    await prisma.iptvChannel.delete({ where: { id: channel.id } });
    await prisma.iptvChannel.create({ data: { playlistId, name: 'station-1', tvgId: 'different-id', url: 'https://example.test/live' } });
    assert.equal((await send(`/favourites?serverConfigId=${serverId}`)).body[0].channel, null);
    assert.equal((await send('/favourites', 'PUT', pickBody())).status, 404);
  });

  it('repeated starts update one stable pick without clearing its favourite', async () => {
    await send('/favourites', 'PUT', pickBody());
    await recordIptvRecent(prisma, serverId, channel);
    const previous = (await send(`/recent?serverConfigId=${serverId}`)).body[0].lastStreamedAt;
    await recordIptvRecent(prisma, serverId, channel);
    const recent = (await send(`/recent?serverConfigId=${serverId}`)).body;
    assert.equal(recent.length, 1);
    assert.equal(recent[0].favourite, true);
    assert.ok(recent[0].lastStreamedAt > previous);
    assert.equal(await prisma.iptvChannelPick.count(), 1);
  });

  it('resolves a large favourites list without exceeding SQLite query limits', async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({ playlistId, name: `Favourite ${i}`, tvgId: `favourite-${i}`, url: 'https://example.test/live' }));
    await prisma.iptvChannel.createMany({ data: rows });
    await prisma.iptvChannelPick.createMany({ data: rows.map((row) => ({ serverConfigId: serverId, playlistId, channelKey: row.tvgId, name: row.name, favourite: true })) });
    const response = await send(`/favourites?serverConfigId=${serverId}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1100);
    assert.ok(response.body.every((pick: any) => pick.channel?.channelKey === pick.channelKey));
  });

  it('caps recent at 20 per server while retaining an aged favourite', async () => {
    await send('/favourites', 'PUT', pickBody());
    await recordIptvRecent(prisma, serverId, channel);
    for (let i = 0; i < 21; i++) {
      const next = await prisma.iptvChannel.create({ data: { playlistId, name: `Channel ${i}`, url: 'https://example.test/live' } });
      await recordIptvRecent(prisma, serverId, next);
    }
    const recent = (await send(`/recent?serverConfigId=${serverId}`)).body;
    assert.equal(recent.length, 20);
    assert.equal(recent[0].name, 'Channel 20');
    assert.ok(recent.every((pick: any) => pick.channelKey !== 'station-1'));
    const favourite = (await send(`/favourites?serverConfigId=${serverId}`)).body[0];
    assert.equal(favourite.channelKey, 'station-1');
    assert.equal(favourite.lastStreamedAt, null);
    assert.equal(await prisma.iptvChannelPick.count({ where: { serverConfigId: serverId } }), 21);
  });

  it('removing a favourite preserves its recent entry', async () => {
    await send('/favourites', 'PUT', pickBody());
    await recordIptvRecent(prisma, serverId, channel);
    await send('/favourites', 'DELETE', pickBody());
    assert.deepEqual((await send(`/favourites?serverConfigId=${serverId}`)).body, []);
    assert.equal((await send(`/recent?serverConfigId=${serverId}`)).body[0].favourite, false);
  });

  it('records successful POST stream starts and source changes; ignores failed starts', async () => {
    assert.equal((await send('/stream', 'POST', { botId: 1, channelId: channel.id })).status, 200);
    assert.equal((await send(`/recent?serverConfigId=${serverId}`)).body[0].channelKey, 'station-1');
    await prisma.iptvChannelPick.deleteMany();
    streaming = true;
    assert.equal((await send('/stream', 'POST', { botId: 1, channelId: channel.id })).status, 200);
    assert.equal((await send(`/recent?serverConfigId=${serverId}`)).body.length, 1);
    await prisma.iptvChannelPick.deleteMany();
    streaming = false; streamFails = true;
    assert.equal((await send('/stream', 'POST', { botId: 1, channelId: channel.id })).status, 500);
    assert.deepEqual((await send(`/recent?serverConfigId=${serverId}`)).body, []);
  });

  it('never lists another server picks or accepts its playlist', async () => {
    await send('/favourites', 'PUT', pickBody());
    await recordIptvRecent(prisma, serverId, channel);
    assert.deepEqual((await send(`/favourites?serverConfigId=${otherServerId}`)).body, []);
    assert.deepEqual((await send(`/recent?serverConfigId=${otherServerId}`)).body, []);
    assert.equal((await send('/favourites', 'PUT', { ...pickBody(), serverConfigId: otherServerId })).status, 404);
    assert.equal((await send('/favourites', 'DELETE', { ...pickBody(), serverConfigId: otherServerId })).status, 404);
    const foreign = await prisma.iptvChannel.create({ data: { playlistId: otherPlaylistId, name: 'Private', url: 'https://example.test/live' } });
    assert.equal((await send('/stream', 'POST', { botId: 1, channelId: foreign.id })).status, 404);
  });

  it('rejects viewers and malformed scoped pick parameters', async () => {
    role = 'viewer';
    assert.equal((await send(`/favourites?serverConfigId=${serverId}`)).status, 403);
    assert.equal((await send(`/recent?serverConfigId=${serverId}`)).status, 403);
    assert.equal((await send('/favourites', 'PUT', pickBody())).status, 403);
    assert.equal((await send('/favourites', 'DELETE', pickBody())).status, 403);
    role = 'admin';
    assert.equal((await send('/favourites')).status, 400);
    assert.equal((await send('/recent?serverConfigId=1.5')).status, 400);
    assert.equal((await send('/favourites', 'PUT', { ...pickBody(), playlistId: -1 })).status, 400);
    assert.equal((await send('/favourites', 'DELETE', { ...pickBody(), channelKey: '' })).status, 400);
  });

  it('cascades picks when either playlist or server is deleted', async () => {
    await send('/favourites', 'PUT', pickBody());
    await prisma.iptvPlaylist.delete({ where: { id: playlistId } });
    assert.equal(await prisma.iptvChannelPick.count(), 0);
    const foreign = await prisma.iptvChannel.create({ data: { playlistId: otherPlaylistId, name: 'Private', url: 'https://example.test/live' } });
    await recordIptvRecent(prisma, otherServerId, foreign);
    await prisma.tsServerConfig.delete({ where: { id: otherServerId } });
    assert.equal(await prisma.iptvChannelPick.count(), 0);
  });
});
