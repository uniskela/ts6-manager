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
import { createUploadedPlaylist, refreshPlaylist, replaceUploadedPlaylist } from '../iptv/iptv-service.js';
import { deleteIptvSourceFile } from '../iptv/iptv-storage.js';
import { recordIptvRecent } from '../iptv/iptv-picks.js';

const directory = mkdtempSync(join(tmpdir(), 'iptv-filters-'));
const databaseUrl = `file:${join(directory, 'test.db')}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let serverId: number;
let otherServerId: number;
let playlistId: number;
let secondPlaylistId: number;
let otherPlaylistId: number;
let role = 'admin';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, role: role as 'admin', username: 'tester' }; next(); });
app.locals.prisma = prisma;
app.use('/api/iptv', iptvRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');

async function send(path: string, method = 'GET', body?: unknown) {
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/api/iptv${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
}
const scope = () => `serverConfigId=${serverId}`;

before(() => {
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
  });
});
beforeEach(async () => {
  await prisma.tsServerConfig.deleteMany();
  const data = { name: 'Server', host: 'localhost', apiKey: 'fixture' };
  serverId = (await prisma.tsServerConfig.create({ data })).id;
  otherServerId = (await prisma.tsServerConfig.create({ data })).id;
  playlistId = (await prisma.iptvPlaylist.create({ data: { name: 'News', serverConfigId: serverId } })).id;
  secondPlaylistId = (await prisma.iptvPlaylist.create({ data: { name: 'Sports', serverConfigId: serverId } })).id;
  otherPlaylistId = (await prisma.iptvPlaylist.create({ data: { name: 'Private', serverConfigId: otherServerId } })).id;
  await prisma.iptvChannel.createMany({ data: [
    { playlistId, name: 'Morning News', url: 'https://example.test/1', groupTitle: 'News', tvgCountry: ' US ;ca ', tvgLanguage: 'en, FR', position: 0 },
    { playlistId, name: 'World News', url: 'https://example.test/2', groupTitle: 'News', tvgCountry: 'ca,GB', tvgLanguage: 'FR;en', position: 1 },
    { playlistId: secondPlaylistId, name: 'City Sports', url: 'https://example.test/3', groupTitle: 'Sports', tvgCountry: 'US', tvgLanguage: 'es', position: 0 },
    { playlistId: secondPlaylistId, name: 'Substring', url: 'https://example.test/4', groupTitle: 'Sports', tvgCountry: 'AUS;U S', tvgLanguage: 'french', position: 1 },
    { playlistId: secondPlaylistId, name: 'No metadata', url: 'https://example.test/5', groupTitle: 'Sports', position: 2 },
    { playlistId: otherPlaylistId, name: 'Secret', url: 'https://example.test/6', groupTitle: 'Private', tvgCountry: 'JP', tvgLanguage: 'ja' },
  ] });
  role = 'admin';
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe('IPTV country and language filters against SQLite', () => {
  it('filters groups with exact case insensitive country tokens and correct counts', async () => {
    const response = await send(`/groups?${scope()}&country=uS`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ group: 'News', count: 1 }, { group: 'Sports', count: 1 }]);
  });
  it('splits both delimiters in country and language and combines the filters', async () => {
    const response = await send(`/groups?${scope()}&country=gb;us&language=ES,fr`);
    assert.deepEqual(response.body, [{ group: 'News', count: 2 }, { group: 'Sports', count: 1 }]);
  });
  it('combines filtered group counts with the playlist scope', async () => {
    assert.deepEqual((await send(`/groups?${scope()}&playlistId=${secondPlaylistId}&language=fr`)).body, []);
  });
  it('filters and pages channels before computing totals', async () => {
    const response = await send(`/channels?${scope()}&country=us,gb&language=EN;es&page=2&pageSize=1`);
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 3);
    assert.equal(response.body.channels.length, 1);
    assert.equal(response.body.channels[0].name, 'World News');
  });
  it('combines country and language with playlist, group and search', async () => {
    const response = await send(`/channels?${scope()}&country=ca&language=fr&playlistId=${playlistId}&group=News&search=World`);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.channels[0].name, 'World News');
    assert.equal(response.body.channels[0].tvgCountry, 'ca,GB');
    assert.equal(response.body.channels[0].tvgLanguage, 'FR;en');
  });
  it('never matches substrings, interior whitespace or missing metadata', async () => {
    const country = await send(`/channels?${scope()}&country=us`);
    assert.deepEqual(country.body.channels.map((channel: any) => channel.name), ['Morning News', 'City Sports']);
    const language = await send(`/channels?${scope()}&language=fr`);
    assert.deepEqual(language.body.channels.map((channel: any) => channel.name), ['Morning News', 'World News']);
    assert.equal((await send(`/channels?${scope()}&country=%25`)).body.total, 0);
  });
  it('treats empty query tokens as no filter', async () => {
    assert.equal((await send(`/channels?${scope()}&country=;%20,&language=,;`)).body.total, 5);
  });
  it('matches advertised codes surrounded by Unicode whitespace in every browser view', async () => {
    const channel = await prisma.iptvChannel.findFirstOrThrow({ where: { playlistId, name: 'Morning News' } });
    await prisma.iptvChannel.update({ where: { id: channel.id }, data: { tvgCountry: '\u00a0US\u00a0', tvgLanguage: '\u2003en\u2003' } });
    const values = (await send(`/filters?${scope()}`)).body;
    assert.ok(values.countries.includes('US'));
    assert.ok(values.languages.includes('en'));
    assert.deepEqual((await send(`/groups?${scope()}&country=US&language=en`)).body, [{ group: 'News', count: 1 }]);
    const result = (await send(`/channels?${scope()}&country=US&language=en`)).body;
    assert.equal(result.total, 1);
    assert.equal(result.channels[0].name, 'Morning News');
  });
  it('returns normalized distinct sorted available codes from only this server', async () => {
    const response = await send(`/filters?${scope()}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { countries: ['AUS', 'CA', 'GB', 'U S', 'US'], languages: ['en', 'es', 'fr', 'french'] });
  });
  it('returns empty available values when the server has no metadata', async () => {
    await prisma.iptvChannel.updateMany({ where: { playlist: { serverConfigId: serverId } }, data: { tvgCountry: null, tvgLanguage: null } });
    assert.deepEqual((await send(`/filters?${scope()}`)).body, { countries: [], languages: [] });
  });
  it('never leaks another server values, groups or filtered channels', async () => {
    assert.deepEqual((await send(`/filters?serverConfigId=${otherServerId}`)).body, { countries: ['JP'], languages: ['ja'] });
    assert.deepEqual((await send(`/groups?${scope()}&country=jp`)).body, []);
    assert.equal((await send(`/channels?${scope()}&country=jp`)).body.total, 0);
    assert.equal((await send(`/channels?${scope()}&playlistId=${otherPlaylistId}&language=ja`)).body.total, 0);
  });
  it('rejects viewers and malformed or repeated filter parameters', async () => {
    role = 'viewer';
    for (const route of ['groups', 'channels', 'filters']) assert.equal((await send(`/${route}?${scope()}`)).status, 403);
    role = 'admin';
    for (const query of ['', 'serverConfigId=0', 'serverConfigId=1.5', `${scope()}&serverConfigId=${serverId}`]) assert.equal((await send(`/filters?${query}`)).status, 400);
    for (const route of ['groups', 'channels']) {
      assert.equal((await send(`/${route}?${scope()}&country=us&country=ca`)).status, 400);
      assert.equal((await send(`/${route}?${scope()}&language=en&language=fr`)).status, 400);
    }
  });
  it('keeps exact channel and stable-key lookups scoped while filtering', async () => {
    const channel = await prisma.iptvChannel.findFirstOrThrow({ where: { playlistId, name: 'Morning News' } });
    assert.equal((await send(`/channels?${scope()}&country=ca&channelId=${channel.id}`)).body.total, 1);
    assert.equal((await send(`/channels?${scope()}&country=gb&channelId=${channel.id}`)).body.total, 0);
    assert.equal((await send(`/channels?${scope()}&language=en&channelKey=Morning%20News`)).body.total, 1);
  });
  it('returns channel metadata for favourites and recent as well as unfiltered channels', async () => {
    const channel = await prisma.iptvChannel.findFirstOrThrow({ where: { playlistId, name: 'Morning News' } });
    await send('/favourites', 'PUT', { serverConfigId: serverId, playlistId, channelKey: channel.name });
    await recordIptvRecent(prisma, serverId, channel);
    for (const view of ['favourites', 'recent']) {
      const pick = (await send(`/${view}?${scope()}`)).body[0];
      assert.equal(pick.channel.tvgCountry, ' US ;ca ');
      assert.equal(pick.channel.tvgLanguage, 'en, FR');
    }
    assert.equal((await send(`/channels?${scope()}&channelId=${channel.id}`)).body.channels[0].tvgLanguage, 'en, FR');
  });
});

describe('IPTV country and language persistence', () => {
  it('stores uploaded attributes and updates them on replacement and next refresh', async () => {
    const content = '#EXTM3U\n#EXTINF:-1 tvg-country="US;CA" tvg-language="en,fr",Uploaded\nhttps://example.test/upload\n';
    const uploaded = await createUploadedPlaylist(prisma, { name: 'Upload', serverConfigId: serverId, fileBuffer: Buffer.from(content) });
    try {
      let channel = await prisma.iptvChannel.findFirstOrThrow({ where: { playlistId: uploaded.id } });
      assert.equal(channel.tvgCountry, 'US;CA');
      assert.equal(channel.tvgLanguage, 'en,fr');
      await replaceUploadedPlaylist(prisma, { playlistId: uploaded.id, fileBuffer: Buffer.from(content.replace('US;CA', 'FI').replace('en,fr', 'fi')) });
      channel = await prisma.iptvChannel.findFirstOrThrow({ where: { playlistId: uploaded.id } });
      assert.equal(channel.tvgCountry, 'FI');
      assert.equal(channel.tvgLanguage, 'fi');
      await prisma.iptvChannel.updateMany({ where: { playlistId: uploaded.id }, data: { tvgCountry: null, tvgLanguage: null } });
      await refreshPlaylist(prisma, uploaded.id);
      channel = await prisma.iptvChannel.findFirstOrThrow({ where: { playlistId: uploaded.id } });
      assert.equal(channel.tvgCountry, 'FI');
      assert.equal(channel.tvgLanguage, 'fi');
    } finally {
      const playlist = await prisma.iptvPlaylist.findUniqueOrThrow({ where: { id: uploaded.id } });
      if (playlist.sourcePath) deleteIptvSourceFile(playlist.sourcePath);
    }
  });
});
