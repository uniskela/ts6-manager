import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDiscordBridgeHealthPort, mapDiscordBridgeStatus } from './bridge-health-port.js';

test('mapDiscordBridgeStatus reads private-beta style counters', () => {
  const snap = mapDiscordBridgeStatus({
    receiver: 'slot-0',
    generation: 6,
    daveReady: true,
    t2d: { forwarded: 42 },
  });
  assert.deepEqual(snap, {
    daveReady: true,
    electedSlot: 'slot-0',
    generation: 6,
    t2dForwarded: 42,
  });
});

test('mapDiscordBridgeStatus derives daveReady from senders', () => {
  const snap = mapDiscordBridgeStatus({
    receiver: 'slot-1',
    generation: 2,
    senders: {
      'slot-0': { daveReady: false },
      'slot-1': { daveReady: true },
    },
  });
  assert.equal(snap?.daveReady, true);
  assert.equal(snap?.electedSlot, 'slot-1');
});

test('health port returns null when bridge is not configured', async () => {
  const port = createDiscordBridgeHealthPort({});
  assert.equal(await port.health('g1'), null);
});

test('health port reads a lab status file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-health-'));
  const file = path.join(dir, 'status.json');
  await fs.writeFile(file, JSON.stringify({
    receiver: 'slot-0',
    generation: 3,
    daveReady: false,
  }));
  const port = createDiscordBridgeHealthPort({ statusFilePath: file });
  const snap = await port.health('g1');
  assert.deepEqual(snap, {
    daveReady: false,
    electedSlot: 'slot-0',
    generation: 3,
  });
});

test('health port fetches HTTP /health with bearer secret', async () => {
  let sawAuth = '';
  const port = createDiscordBridgeHealthPort({
    baseUrl: 'http://bridge.local/',
    secret: 's3cret',
    fetchImpl: (async (input, init) => {
      assert.equal(String(input), 'http://bridge.local/health');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sawAuth = headers.authorization || headers.Authorization || '';
      return new Response(JSON.stringify({
        receiver: 'slot-2',
        generation: 9,
        daveReady: true,
        t2dForwarded: 7,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const snap = await port.health('g1');
  assert.equal(sawAuth, 'Bearer s3cret');
  assert.deepEqual(snap, {
    daveReady: true,
    electedSlot: 'slot-2',
    generation: 9,
    t2dForwarded: 7,
  });
});
