import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { iptvRoutes } from './iptv.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

type Channel = { id: number; playlistId: number; name: string; logo: string | null; groupTitle: string | null; tvgId: string | null; position: number; url: string };
const playlists = [
  { id: 10, name: 'News', serverConfigId: 1 },
  { id: 11, name: 'Sports', serverConfigId: 1 },
  { id: 20, name: 'Other server', serverConfigId: 2 },
];
const channels: Channel[] = [
  { id: 1, playlistId: 10, name: 'Morning News', logo: 'news.png', groupTitle: 'News', tvgId: 'morning', position: 0, url: 'https://one' },
  { id: 2, playlistId: 10, name: 'World News', logo: null, groupTitle: 'News', tvgId: null, position: 1, url: 'https://two' },
  { id: 3, playlistId: 11, name: 'City Sports', logo: null, groupTitle: 'Sports', tvgId: 'city', position: 0, url: 'https://three' },
  { id: 4, playlistId: 20, name: 'Secret News', logo: null, groupTitle: 'News', tvgId: 'secret', position: 0, url: 'https://four' },
];

/** Apply the route's Prisma where shape to the in-memory test fixture. */
function matches(row: Channel, where: any): boolean {
  if (where.OR && !where.OR.some((condition: any) => matches(row, condition))) return false;
  if (where.playlistId !== undefined && row.playlistId !== where.playlistId) return false;
  const playlist = playlists.find((p) => p.id === row.playlistId)!;
  if (where.playlist?.serverConfigId !== undefined && playlist.serverConfigId !== where.playlist.serverConfigId) return false;
  if (where.groupTitle !== undefined) {
    if (typeof where.groupTitle === 'object' && 'not' in where.groupTitle) {
      if (row.groupTitle === where.groupTitle.not) return false;
    } else if (row.groupTitle !== where.groupTitle) return false;
  }
  if (where.name?.contains && !row.name.toLowerCase().includes(String(where.name.contains).toLowerCase())) return false;
  return true;
}

/** Build an isolated Express fixture for each route test. */
function fixture() {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, role: 'admin', username: 'tester' }; next(); });
  app.locals.prisma = {
    iptvChannel: {
      groupBy: async ({ where }: any) => {
        const grouped = new Map<string | null, number>();
        for (const channel of channels.filter((c) => matches(c, where))) {
          grouped.set(channel.groupTitle, (grouped.get(channel.groupTitle) ?? 0) + 1);
        }
        return [...grouped.entries()].map(([groupTitle, count]) => ({ groupTitle, _count: { _all: count } }));
      },
      findMany: async ({ where, select, orderBy, skip = 0, take }: any) => {
        const filtered = channels.filter((c) => matches(c, where));
        if (select?.groupTitle && !select?.playlist) return filtered.map((c) => ({ groupTitle: c.groupTitle }));
        const rows = filtered.sort((a, b) => a.playlistId - b.playlistId || a.position - b.position).slice(skip, take === undefined ? undefined : skip + take);
        return rows.map((c) => ({ ...c, playlist: playlists.find((p) => p.id === c.playlistId) }));
      },
      count: async ({ where }: any) => channels.filter((c) => matches(c, where)).length,
    },
  };
  app.use('/api/iptv', iptvRoutes);
  app.use(errorHandler);
  return app;
}

/** Send one request to a route fixture. */
async function send(app: Express, path: string) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

describe('console IPTV routes', () => {
  it('counts groups across playlists on one server', async () => {
    const response = await send(fixture(), '/api/iptv/groups?serverConfigId=1');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ group: 'News', count: 2 }, { group: 'Sports', count: 1 }]);
  });

  it('searches channels by name, group, playlist and pages the scoped result', async () => {
    const byName = await send(fixture(), '/api/iptv/channels?serverConfigId=1&search=morning');
    assert.equal(byName.body.channels[0].channelKey, 'morning');
    const byGroup = await send(fixture(), '/api/iptv/channels?serverConfigId=1&group=Sports');
    assert.equal(byGroup.body.channels[0].playlistName, 'Sports');
    const byPlaylist = await send(fixture(), '/api/iptv/channels?serverConfigId=1&playlistId=10&page=2&pageSize=1');
    assert.equal(byPlaylist.body.total, 2);
    assert.equal(byPlaylist.body.channels[0].name, 'World News');
    const capped = await send(fixture(), '/api/iptv/channels?serverConfigId=1&pageSize=101');
    assert.equal(capped.body.pageSize, 100);
  });

  it('never returns another server data and rejects bad positive integer params', async () => {
    const response = await send(fixture(), '/api/iptv/channels?serverConfigId=1&search=Secret');
    assert.equal(response.body.total, 0);
    for (const query of ['serverConfigId=0', 'serverConfigId=1.5', 'serverConfigId=1&page=0', 'serverConfigId=1&pageSize=nope']) {
      assert.equal((await send(fixture(), `/api/iptv/channels?${query}`)).status, 400, query);
    }
  });
});
