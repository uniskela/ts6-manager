import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClientMetadataCache,
  mergeIdentityPreferringEvent,
  pickAllowlistedIdentity,
} from './client-metadata-cache.js';

test('pickAllowlistedIdentity excludes IP and chat fields', () => {
  const picked = pickAllowlistedIdentity({
    clid: '8',
    client_nickname: 'Pikeleht',
    client_type: '0',
    client_unique_identifier: 'abc=',
    client_database_id: '42',
    connection_client_ip: '1.2.3.4',
    msg: 'hello',
  });
  assert.deepEqual(picked, {
    client_nickname: 'Pikeleht',
    client_type: '0',
    client_unique_identifier: 'abc=',
    client_database_id: '42',
  });
  assert.equal((picked as any).connection_client_ip, undefined);
});

test('enter → leave enrichment merges cache then evicts', () => {
  const cache = new ClientMetadataCache();
  cache.beginGeneration(1, 1);

  const enter = cache.enrich(1, 1, 'notifycliententerview', {
    clid: '8',
    cfid: '0',
    ctid: '16',
    client_nickname: 'Pikeleht',
    client_type: '0',
    client_unique_identifier: 'uid-1',
    client_database_id: '99',
  });
  assert.equal(enter.client_nickname, 'Pikeleht');

  const leave = cache.enrich(1, 1, 'notifyclientleftview', {
    clid: '8',
    cfid: '16',
    ctid: '0',
  });
  assert.equal(leave.clid, '8');
  assert.equal(leave.cfid, '16');
  assert.equal(leave.ctid, '0');
  assert.equal(leave.client_nickname, 'Pikeleht');
  assert.equal(leave.client_type, '0');
  assert.equal(leave.client_unique_identifier, 'uid-1');
  assert.equal(leave.client_database_id, '99');

  // Evicted — second leave has no cache.
  const leave2 = cache.enrich(1, 1, 'notifyclientleftview', {
    clid: '8',
    cfid: '16',
    ctid: '0',
  });
  assert.equal(leave2.client_nickname, undefined);
});

test('leave without cache still emits native payload', () => {
  const cache = new ClientMetadataCache();
  cache.beginGeneration(1, 1);
  const leave = cache.enrich(1, 1, 'notifyclientleftview', {
    clid: '3',
    cfid: '1',
    ctid: '0',
    reasonid: '8',
  });
  assert.deepEqual(leave, {
    clid: '3',
    cfid: '1',
    ctid: '0',
    reasonid: '8',
  });
});

test('event fields take precedence over cached fields', () => {
  const merged = mergeIdentityPreferringEvent(
    { clid: '1', client_nickname: 'Fresh', client_type: '' },
    { client_nickname: 'Stale', client_type: '0', client_database_id: '7' },
  );
  assert.equal(merged.client_nickname, 'Fresh');
  assert.equal(merged.client_type, '0');
  assert.equal(merged.client_database_id, '7');
});

test('identical clids on different servers stay isolated', () => {
  const cache = new ClientMetadataCache();
  cache.beginGeneration(1, 1);
  cache.beginGeneration(2, 1);
  cache.enrich(1, 1, 'notifycliententerview', {
    clid: '8',
    client_nickname: 'A',
    client_type: '0',
  });
  cache.enrich(2, 1, 'notifycliententerview', {
    clid: '8',
    client_nickname: 'B',
    client_type: '0',
  });
  const leaveA = cache.enrich(1, 1, 'notifyclientleftview', { clid: '8', ctid: '0' });
  const leaveB = cache.enrich(2, 1, 'notifyclientleftview', { clid: '8', ctid: '0' });
  assert.equal(leaveA.client_nickname, 'A');
  assert.equal(leaveB.client_nickname, 'B');
});

test('generation bump clears prior clid reuse after reconnect', () => {
  const cache = new ClientMetadataCache();
  cache.beginGeneration(1, 1);
  cache.enrich(1, 1, 'notifycliententerview', {
    clid: '8',
    client_nickname: 'Old',
    client_type: '0',
  });
  cache.beginGeneration(1, 1);
  const leave = cache.enrich(1, 1, 'notifyclientleftview', { clid: '8', ctid: '0' });
  assert.equal(leave.client_nickname, undefined);
});

test('seedFromClientList does not require enter events', () => {
  const cache = new ClientMetadataCache();
  cache.beginGeneration(9, 1);
  cache.seedFromClientList(9, 1, [
    {
      clid: '4',
      client_nickname: 'Seeded',
      client_type: '0',
      client_unique_identifier: 's=',
      client_database_id: '11',
    },
  ]);
  const leave = cache.enrich(9, 1, 'notifyclientleftview', { clid: '4', ctid: '0' });
  assert.equal(leave.client_nickname, 'Seeded');
  assert.equal(leave.client_database_id, '11');
});
