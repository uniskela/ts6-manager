import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PLAYLIST_VOTE_SETTINGS,
  playlistVoteApprovalsNeeded,
} from '@ts6/common';
import {
  defaultPlaylistVoteSettings,
  loadPlaylistVoteSettings,
  parsePlaylistVoteSettings,
  playlistVoteSettingsKey,
  savePlaylistVoteSettings,
} from './playlist-vote-settings.js';

function store(initial: Array<[string, string]> = []) {
  const rows = new Map(initial);
  const prisma = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { value: rows.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        rows.set(where.key, create.value);
      },
    },
  } as any;
  return { rows, prisma };
}

describe('playlist vote settings', () => {
  it('defaults voting off at 80% with a 25-track request cap', () => {
    assert.deepEqual(defaultPlaylistVoteSettings(), {
      enabled: false,
      thresholdPercent: 80,
      maxRequestSize: 25,
    });
    assert.deepEqual(defaultPlaylistVoteSettings(), DEFAULT_PLAYLIST_VOTE_SETTINGS);
  });

  it('loads upgrade defaults without writing when no row exists', async () => {
    const { rows, prisma } = store();
    assert.deepEqual(await loadPlaylistVoteSettings(prisma, 1, 1), defaultPlaylistVoteSettings());
    assert.equal(rows.size, 0);
  });

  it('isolates saved settings by connection and virtual server', async () => {
    const { prisma } = store();
    const saved = { enabled: true, thresholdPercent: 60, maxRequestSize: 10 };
    assert.deepEqual(await savePlaylistVoteSettings(prisma, 1, 2, saved), saved);
    assert.deepEqual(await loadPlaylistVoteSettings(prisma, 1, 2), saved);
    assert.deepEqual(await loadPlaylistVoteSettings(prisma, 1, 1), defaultPlaylistVoteSettings());
    assert.deepEqual(await loadPlaylistVoteSettings(prisma, 2, 2), defaultPlaylistVoteSettings());
  });

  it('returns defaults for malformed stored JSON', async () => {
    for (const value of ['broken', 'null', '{}', JSON.stringify({ enabled: true })]) {
      const { prisma } = store([[playlistVoteSettingsKey(1, 1), value]]);
      assert.deepEqual(await loadPlaylistVoteSettings(prisma, 1, 1), defaultPlaylistVoteSettings());
    }
  });

  it('accepts complete updates and rejects invalid fields', () => {
    const ok = { enabled: true, thresholdPercent: 80, maxRequestSize: 25 };
    assert.deepEqual(parsePlaylistVoteSettings(ok), ok);
    assert.equal(parsePlaylistVoteSettings(null), null);
    assert.equal(parsePlaylistVoteSettings({ ...ok, extra: true }), null);
    assert.equal(parsePlaylistVoteSettings({ ...ok, enabled: 'yes' }), null);
    assert.equal(parsePlaylistVoteSettings({ ...ok, thresholdPercent: 0 }), null);
    assert.equal(parsePlaylistVoteSettings({ ...ok, thresholdPercent: 101 }), null);
    assert.equal(parsePlaylistVoteSettings({ ...ok, thresholdPercent: 80.5 }), null);
    assert.equal(parsePlaylistVoteSettings({ ...ok, maxRequestSize: 0 }), null);
    assert.equal(parsePlaylistVoteSettings({ ...ok, maxRequestSize: 501 }), null);
    assert.equal(parsePlaylistVoteSettings({ enabled: true, thresholdPercent: 80 }), null);
  });

  it('matches the documented pass-rule examples at 80%', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 10].map((n) => playlistVoteApprovalsNeeded(80, n)),
      [1, 2, 3, 4, 4, 5, 8],
    );
    // Defensive floor — openVote must still refuse an empty electorate (#442).
    assert.equal(playlistVoteApprovalsNeeded(80, 0), 1);
  });
});
