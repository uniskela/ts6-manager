import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnedTempChannel, cleanupOwnedTempChannels } from './temp-channel-ownership.js';

test('persistent ownership isolates flows and protects siblings, lobby, parent, occupied and reused IDs', async () => {
  const records: any[] = [];
  const channels = new Map<string, any>();
  const deletions: string[] = [];
  let nextId = 10;
  const prisma = { botVariable: {
    create: async ({ data }: any) => { records.push({ ...data, id: records.length + 1 }); },
    findMany: async ({ where }: any) => records.filter(r => r.flowId === where.flowId && r.scope === where.scope),
    deleteMany: async ({ where }: any) => { const i = records.findIndex(r => r.id === where.id); if (i >= 0) records.splice(i, 1); },
  } } as any;
  const client = {
    execute: async (_sid: number, command: string, params: any) => command === 'channellist'
      ? [...channels.values()] : [channels.get(params.cid)],
    executePost: async (_sid: number, command: string, params: any) => {
      if (command === 'channelcreate') {
        const cid = String(nextId++);
        channels.set(cid, { ...params, cid, pid: params.cpid, total_clients: 0 });
        return [{ cid }];
      }
      assert.equal(params.force, 0, 'must never force deletion');
      if (channels.get(params.cid)?.joinedDuringCleanup) throw new Error('channel not empty');
      deletions.push(params.cid); channels.delete(params.cid);
    },
  } as any;
  const owner = { flowId: 1, configId: 1, sid: 1 };
  const create = async (flowId = 1, description?: string) => String((await createOwnedTempChannel(prisma, { ...owner, flowId }, client,
    { cpid: '2', channel_flag_semi_permanent: '1', ...(description ? { channel_description: description } : {}) }))[0].cid);
  const empty = await create(1, 'Welcome to your channel');
  assert.match(channels.get(empty).channel_description, /^Welcome to your channel\n\nTS6M-TEMP:/);
  const occupied = await create(); channels.get(occupied).total_clients = 1;
  const stale = await create(); channels.delete(stale);
  const reused = await create(); channels.get(reused).channel_description = 'Administrator channel';
  const otherFlow = await create(2);
  const lobby = await create();
  const raced = await create(); channels.get(raced).joinedDuringCleanup = true;
  const withChild = await create();
  channels.set('99', { cid: '99', pid: withChild, total_clients: 0 });
  const moved = await create(); channels.get(moved).pid = '99';
  const permanent = await create(); channels.get(permanent).channel_flag_permanent = 1;
  for (const [cid, count] of [['2', 0], ['3', 0], ['4', 1]] as const) {
    channels.set(cid, { cid, pid: '2', total_clients: count, channel_flag_semi_permanent: 1 });
  }
  const count = await cleanupOwnedTempChannels(prisma, owner, client, '2', new Set([lobby]));
  assert.equal(count, 1);
  assert.deepEqual(deletions, [empty]);
  for (const cid of [occupied, reused, otherFlow, lobby, raced, moved, permanent, withChild, '99', '2', '3', '4']) assert.ok(channels.has(cid), cid);
  assert.ok(!records.some(r => r.name === stale || r.name === reused));
  assert.equal(await cleanupOwnedTempChannels(prisma, { ...owner, flowId: 2 }, client, '2', new Set()), 1);
  assert.deepEqual(deletions, [empty, otherFlow]);
  assert.equal(await cleanupOwnedTempChannels(prisma, { ...owner, configId: 2 }, client, '2', new Set()), 0);
});
