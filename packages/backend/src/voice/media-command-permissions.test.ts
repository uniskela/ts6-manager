import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUILTIN_CHAT_COMMANDS, MEDIA_COMMAND_GROUP_BY_COMMAND, type MediaCommandPermissions } from '@ts6/common';
import {
  authorizeMediaCommand,
  authorizeMediaCommandGroup,
  defaultMediaCommandPermissions,
  loadMediaCommandPermissions,
  mediaCommandPermissionsKey,
  parseMediaCommandPermissions,
  saveMediaCommandPermissions,
} from './media-command-permissions.js';

const restricted: MediaCommandPermissions = {
  playback: { mode: 'server_groups', serverGroupIds: [6, 12] },
  queue: { mode: 'server_groups', serverGroupIds: [7] },
  video: { mode: 'server_groups', serverGroupIds: [] },
};

function store(initial: Array<[string, string]> = []) {
  const rows = new Map(initial);
  const prisma = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => rows.has(where.key) ? { value: rows.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        rows.set(where.key, create.value);
      },
    },
  } as any;
  return { rows, prisma };
}

describe('media command permissions', () => {
  it('preserves Everyone for existing installations without policy rows or identities', async () => {
    const { rows, prisma } = store();
    const policy = await loadMediaCommandPermissions(prisma, 1, 1);
    assert.deepEqual(policy, defaultMediaCommandPermissions());
    for (const command of BUILTIN_CHAT_COMMANDS) assert.equal(authorizeMediaCommand(policy, command, {}), true, command);
    assert.equal(rows.size, 0, 'reading upgrade defaults must not modify storage');
  });

  it('grants only selected TS groups independently per command group', () => {
    assert.equal(authorizeMediaCommand(restricted, 'play', { uid: 'human', serverGroupIds: [12] }), true);
    assert.equal(authorizeMediaCommand(restricted, 'add', { uid: 'human', serverGroupIds: [12] }), false);
    assert.equal(authorizeMediaCommand(restricted, 'add', { uid: 'human', serverGroupIds: [7] }), true);
    assert.equal(authorizeMediaCommand(restricted, 'stream', { uid: 'human', serverGroupIds: [7, 12] }), false);
    for (const command of ['help', 'commands', 'np', 'nowplaying', 'viewers', 'channels', 'lyrics']) {
      assert.equal(authorizeMediaCommand(restricted, command, {}), true, command);
    }
    assert.equal(authorizeMediaCommand(restricted, 'voteskip', {}), true, 'listener eligibility belongs to the vote service');
    assert.equal(authorizeMediaCommand(restricted, 'unknown', {}), false);
    assert.equal(authorizeMediaCommand(restricted, '__proto__', {}), false);
    assert.deepEqual(Object.keys(MEDIA_COMMAND_GROUP_BY_COMMAND).sort(), [...BUILTIN_CHAT_COMMANDS].sort());
  });

  it('denies restrictions with missing UID, unresolved groups or no memberships', () => {
    for (const identity of [{}, { uid: null, serverGroupIds: [6] }, { uid: '', serverGroupIds: [6] },
      { uid: '  ', serverGroupIds: [6] }, { uid: 'human' }, { uid: 'human', serverGroupIds: null },
      { uid: 'human', serverGroupIds: [] }]) {
      assert.equal(authorizeMediaCommandGroup(restricted, 'playback', identity), false);
    }
    assert.equal(authorizeMediaCommandGroup(defaultMediaCommandPermissions(), 'playback', {}), true);
  });

  it('allows read-only forms while enforcing control forms and aliases', () => {
    for (const command of ['queue', 'vol', 'volume', 'playlist', 'pl', 'radio', 'repeat']) {
      assert.equal(authorizeMediaCommand(restricted, command, {}, ''), true, command);
      assert.equal(authorizeMediaCommand(restricted, command, {}, 'change'), false, command);
    }
    assert.equal(authorizeMediaCommand(restricted, 'queue', {}, ' SHOW '), true);
    assert.equal(authorizeMediaCommand(restricted, 'queue', {}, 'clear'), false);
    for (const command of ['here', 'come']) assert.equal(authorizeMediaCommand(restricted, command, {}), false);
  });

  it('isolates saved policies by connection and virtual server', async () => {
    const { prisma } = store();
    assert.deepEqual(await saveMediaCommandPermissions(prisma, 1, 2, restricted), restricted);
    assert.deepEqual(await loadMediaCommandPermissions(prisma, 1, 2), restricted);
    assert.deepEqual(await loadMediaCommandPermissions(prisma, 1, 1), defaultMediaCommandPermissions());
    assert.deepEqual(await loadMediaCommandPermissions(prisma, 2, 2), defaultMediaCommandPermissions());
  });

  it('fails closed on malformed saved policy while keeping information accessible', async () => {
    for (const value of ['broken json', '{}', 'null', JSON.stringify({ ...restricted, playback: { mode: 'unexpected' } })]) {
      const { prisma } = store([[mediaCommandPermissionsKey(1, 1), value]]);
      const policy = await loadMediaCommandPermissions(prisma, 1, 1);
      for (const group of ['playback', 'queue', 'video'] as const) {
        assert.equal(authorizeMediaCommandGroup(policy, group, { uid: 'human', serverGroupIds: [6, 7, 12] }), false);
      }
      assert.equal(authorizeMediaCommand(policy, 'help', {}), true);
    }
  });

  it('validates complete admin updates and normalizes duplicate positive group IDs', async () => {
    assert.deepEqual(parseMediaCommandPermissions({ ...restricted, playback: { mode: 'server_groups', serverGroupIds: [6, 6, 12] } }), restricted);
    for (const serverGroupIds of [['6'], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], '6']) {
      assert.equal(parseMediaCommandPermissions({ ...restricted, playback: { mode: 'server_groups', serverGroupIds } }), null);
    }
    assert.equal(parseMediaCommandPermissions({ playback: { mode: 'everyone' } }), null);
    assert.equal(parseMediaCommandPermissions({ ...restricted, extra: { mode: 'everyone' } }), null);
    assert.equal(parseMediaCommandPermissions({ ...restricted, playback: { mode: 'everyone', serverGroupIds: [6] } }), null);
    const { prisma, rows } = store();
    await assert.rejects(saveMediaCommandPermissions(prisma, 1, 1, {}), /Invalid/);
    assert.equal(rows.size, 0);
  });
});
