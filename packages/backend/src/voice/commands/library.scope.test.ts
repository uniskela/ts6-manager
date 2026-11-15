import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogScopeWhere, loadPlaylistSummaries, matchNamed } from './library.js';

const rows = [
  { id: 1, name: 'Server one', serverConfigId: 1, musicBot: { serverConfigId: 1 } },
  { id: 2, name: 'Server two', serverConfigId: 2, musicBot: { serverConfigId: 2 } },
  { id: 3, name: 'Legacy shared', serverConfigId: null, musicBot: null },
  { id: 4, name: 'Legacy server one bot', serverConfigId: null, musicBot: { serverConfigId: 1 } },
  { id: 5, name: 'Legacy server two bot', serverConfigId: null, musicBot: { serverConfigId: 2 } },
  { id: 6, name: 'Conflicting server and bot', serverConfigId: 1, musicBot: { serverConfigId: 2 } },
];

function matchesWhere(row: Record<string, unknown>, where?: any): boolean {
  return !where || Object.entries(where).every(([key, value]) =>
    key === 'OR'
      ? (value as any[]).some((condition) => matchesWhere(row, condition))
      : key === 'AND'
        ? (value as any[]).every((condition) => matchesWhere(row, condition))
        : value !== null && typeof value === 'object'
          ? row[key] !== null && typeof row[key] === 'object' && matchesWhere(row[key] as Record<string, unknown>, value)
          : row[key] === value);
}

describe('playlist catalog eligibility', () => {
  it('matches the web and Auto-DJ server-and-bot ownership rule', () => {
    assert.deepEqual(catalogScopeWhere(1), {
      AND: [
        { OR: [{ serverConfigId: 1 }, { serverConfigId: null }] },
        { OR: [{ musicBot: null }, { musicBot: { serverConfigId: 1 } }] },
      ],
    });
  });

  it('lists this server, genuine shared, and same-server legacy playlists only', async () => {
    const db = {
      playlist: {
        findMany: async ({ where }: any) => rows.filter((row) => matchesWhere(row, where)).map(({ id, name }) => ({ id, name })),
      },
    } as any;
    const listed = await loadPlaylistSummaries(db, 1);
    assert.deepEqual(listed.map((item) => item.id), [1, 3, 4]);
    assert.deepEqual(matchNamed(listed, '1').map((item) => item.id), [1]);
    assert.deepEqual(matchNamed(listed, 'Legacy shared').map((item) => item.id), [3]);
    assert.deepEqual(matchNamed(listed, 'Legacy server one bot').map((item) => item.id), [4]);
    assert.deepEqual(matchNamed(listed, '4').map((item) => item.id), [4]);
    assert.equal(matchNamed(listed, '5').length, 0);
    assert.equal(matchNamed(listed, 'Legacy server two bot').length, 0);
    assert.equal(matchNamed(listed, '2').length, 0);
  });
});
