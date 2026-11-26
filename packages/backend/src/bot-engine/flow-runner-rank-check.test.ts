import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TSApiError } from '../middleware/error-handler.js';

/**
 * Issue #660: `clientlist -times` does not return connection_connected_time
 * (TS6 WebQuery, and TS3 ServerQuery list output). rankCheck must read the
 * session time from clientinfo, or online time never accumulates.
 */

type ListedClient = Record<string, string>;

function makeHarness(opts: {
  clients: ListedClient[];
  connectedMs: Record<string, number | Error>;
}) {
  const vars = new Map<string, string>();
  const temps = new Map<string, unknown>();
  const posts: Array<{ command: string; params: any }> = [];
  const infoCalls: string[] = [];

  const client = {
    executePost: async (_sid: number, command: string, params: any) => {
      posts.push({ command, params });
      if (command === 'clientlist') return opts.clients.map((c) => ({ ...c }));
      return [];
    },
    execute: async (_sid: number, command: string, params: any) => {
      assert.equal(command, 'clientinfo');
      const clid = String(params.clid);
      infoCalls.push(clid);
      const v = opts.connectedMs[clid];
      if (v instanceof Error) throw v;
      return [{ clid, connection_connected_time: String(v ?? 0) }];
    },
  };

  const ctx = {
    sid: 1,
    resolveTemplate: async (v: string) => v,
    getVariable: async (name: string) => vars.get(name) ?? '',
    setVariable: async (name: string, value: string) => { vars.set(name, value); },
    setTemp: (name: string, value: unknown) => { temps.set(name, value); },
  };

  return { vars, temps, posts, infoCalls, client, ctx, connectedMs: opts.connectedMs, clients: opts.clients };
}

async function runRankCheck(h: ReturnType<typeof makeHarness>, ranks: unknown) {
  const { FlowRunner } = await import('./flow-runner.js');
  const runner = new FlowRunner({} as any, {} as any, { clients: new Set() } as any) as any;
  await runner.executeRankCheck({ actionType: 'rankCheck', label: 'r', ranks: JSON.stringify(ranks) }, h.ctx, h.client);
}

const HOUR_MS = 3600 * 1000;

test('rankCheck reads session time from clientinfo when clientlist omits it', async () => {
  const h = makeHarness({
    clients: [
      { clid: '5', client_database_id: '42', client_type: '0', client_servergroups: '8', client_idle_time: '1000' },
    ],
    connectedMs: { '5': 2 * HOUR_MS },
  });

  await runRankCheck(h, [{ hours: 1, groupId: '7' }]);

  assert.deepEqual(h.infoCalls, ['5']);
  assert.equal(Number(h.vars.get('onlinetime_42')), 7200);
  assert.deepEqual(JSON.parse(h.vars.get('onlinetime_last_42')!), { '5': 7200 });
  const adds = h.posts.filter((p) => p.command === 'servergroupaddclient');
  assert.deepEqual(adds.map((p) => p.params), [{ sgid: '7', cldbid: '42' }]);
  assert.equal(h.temps.get('rankPromotedCount'), 1);
});

test('rankCheck accumulates only the delta across runs and resets on a new session', async () => {
  const h = makeHarness({
    clients: [{ clid: '5', client_database_id: '42', client_type: '0', client_servergroups: '8' }],
    connectedMs: { '5': 600_000 },
  });
  await runRankCheck(h, [{ hours: 100, groupId: '7' }]);
  assert.equal(Number(h.vars.get('onlinetime_42')), 600);

  h.connectedMs['5'] = 900_000;
  await runRankCheck(h, [{ hours: 100, groupId: '7' }]);
  assert.equal(Number(h.vars.get('onlinetime_42')), 900);

  // Reconnected: session clock restarted below the last counted value.
  h.connectedMs['5'] = 120_000;
  await runRankCheck(h, [{ hours: 100, groupId: '7' }]);
  assert.equal(Number(h.vars.get('onlinetime_42')), 1020);
});

test('rankCheck counts one session per database id when a user has several connections', async () => {
  const h = makeHarness({
    clients: [
      { clid: '5', client_database_id: '42', client_type: '0', client_servergroups: '8' },
      { clid: '6', client_database_id: '42', client_type: '0', client_servergroups: '8' },
    ],
    connectedMs: { '5': 10 * HOUR_MS, '6': HOUR_MS },
  });
  const ranks = [{ hours: 1000, groupId: '7' }];

  await runRankCheck(h, ranks);
  assert.equal(Number(h.vars.get('onlinetime_42')), 36000);

  // Ten minutes later: both sessions advanced by 600 s; only 600 s should be added.
  h.connectedMs['5'] = 10 * HOUR_MS + 600_000;
  h.connectedMs['6'] = HOUR_MS + 600_000;
  await runRankCheck(h, ranks);
  assert.equal(Number(h.vars.get('onlinetime_42')), 36600);

  // The longest connection drops; the surviving one advanced 600 s. Its earlier
  // time overlapped the long session, so only those 600 s are new.
  h.clients.splice(0, 1);
  h.connectedMs['6'] = HOUR_MS + 1_200_000;
  await runRankCheck(h, ranks);
  assert.equal(Number(h.vars.get('onlinetime_42')), 37200);
  assert.deepEqual(JSON.parse(h.vars.get('onlinetime_last_42')!), { '6': 4800 });
});

test('rankCheck does not add a new overlapping connection on top of a running one', async () => {
  const h = makeHarness({
    clients: [{ clid: '5', client_database_id: '42', client_type: '0', client_servergroups: '8' }],
    connectedMs: { '5': HOUR_MS },
  });
  const ranks = [{ hours: 1000, groupId: '7' }];
  await runRankCheck(h, ranks);
  assert.equal(Number(h.vars.get('onlinetime_42')), 3600);

  // 600 s later the user also joined from a second device 300 s ago.
  h.clients.push({ clid: '9', client_database_id: '42', client_type: '0', client_servergroups: '8' });
  h.connectedMs['5'] = HOUR_MS + 600_000;
  h.connectedMs['9'] = 300_000;
  await runRankCheck(h, ranks);
  assert.equal(Number(h.vars.get('onlinetime_42')), 4200);
});

test('rankCheck reads a numeric last-counted value stored by older versions', async () => {
  const h = makeHarness({
    clients: [{ clid: '5', client_database_id: '42', client_type: '0', client_servergroups: '8' }],
    connectedMs: { '5': 1_500_000 },
  });
  h.vars.set('onlinetime_42', '900');
  h.vars.set('onlinetime_last_42', '900');

  await runRankCheck(h, [{ hours: 1000, groupId: '7' }]);
  assert.equal(Number(h.vars.get('onlinetime_42')), 1500);
  assert.deepEqual(JSON.parse(h.vars.get('onlinetime_last_42')!), { '5': 1500 });
});

test('rankCheck skips query clients and clients that left before clientinfo', async () => {
  const h = makeHarness({
    clients: [
      { clid: '1', client_database_id: '1', client_type: '1', client_servergroups: '2' },
      { clid: '5', client_database_id: '42', client_type: '0', client_servergroups: '8' },
      { clid: '6', client_database_id: '43', client_type: '0', client_servergroups: '8' },
    ],
    connectedMs: { '5': new TSApiError(512, 'invalid clientID'), '6': 300_000 },
  });

  await runRankCheck(h, [{ hours: 100, groupId: '7' }]);

  assert.deepEqual(h.infoCalls.sort(), ['5', '6']);
  assert.equal(h.vars.get('onlinetime_42'), undefined);
  assert.equal(h.vars.get('onlinetime_last_42'), undefined);
  assert.equal(Number(h.vars.get('onlinetime_43')), 300);
  assert.equal(h.vars.get('onlinetime_1'), undefined);
});

test('rankCheck surfaces clientinfo errors other than a vanished client', async () => {
  const h = makeHarness({
    clients: [{ clid: '5', client_database_id: '42', client_type: '0', client_servergroups: '8' }],
    connectedMs: { '5': new TSApiError(2568, 'insufficient client permissions') },
  });

  await assert.rejects(runRankCheck(h, [{ hours: 1, groupId: '7' }]), /insufficient client permissions/);
});

test('rankCheck ignores a non-finite stored last-counted value', async () => {
  const h = makeHarness({
    clients: [{ clid: '5', client_database_id: '42', client_type: '0', client_servergroups: '8' }],
    connectedMs: { '5': 600_000 },
  });
  h.vars.set('onlinetime_last_42', 'Infinity');
  const ranks = [{ hours: 1000, groupId: '7' }];

  await runRankCheck(h, ranks);
  assert.equal(Number(h.vars.get('onlinetime_42')), 600);

  h.connectedMs['5'] = 900_000;
  await runRankCheck(h, ranks);
  assert.equal(Number(h.vars.get('onlinetime_42')), 900);
});
