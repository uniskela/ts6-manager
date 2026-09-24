import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyClient,
  isServerJoinEvent,
  isServerLeaveEvent,
  resolveIdentityProvenance,
} from './activity-journal-service.js';

test('server join uses cfid=0; channel view enters are ignored', () => {
  assert.equal(isServerJoinEvent({ clid: '1', cfid: '0', ctid: '5' }), true);
  assert.equal(isServerJoinEvent({ clid: '1', cfid: '12', ctid: '5' }), false);
});

test('server leave uses ctid=0; channel view leaves are ignored', () => {
  assert.equal(isServerLeaveEvent({ clid: '1', cfid: '5', ctid: '0' }), true);
  assert.equal(isServerLeaveEvent({ clid: '1', cfid: '5', ctid: '9' }), false);
});

test('classification: query, known bot, voice, unknown', () => {
  const bots = new Set(['bot-uid']);
  assert.equal(classifyClient({ clientType: 1, uniqueId: null, knownBotUids: bots }), 'query');
  assert.equal(
    classifyClient({ clientType: 0, uniqueId: 'bot-uid', knownBotUids: bots }),
    'known_bot',
  );
  assert.equal(classifyClient({ clientType: 0, uniqueId: 'human', knownBotUids: bots }), 'voice');
  assert.equal(classifyClient({ clientType: null, uniqueId: null, knownBotUids: bots }), 'unknown');
});

test('resolveIdentityProvenance distinguishes event vs cache vs mixed', () => {
  assert.equal(
    resolveIdentityProvenance({ clid: '1' }, { clid: '1', client_nickname: 'X' }),
    'cache',
  );
  assert.equal(
    resolveIdentityProvenance(
      { clid: '1', client_nickname: 'X' },
      { clid: '1', client_nickname: 'X' },
    ),
    'event',
  );
  assert.equal(
    resolveIdentityProvenance(
      { clid: '1', client_nickname: 'X' },
      { clid: '1', client_nickname: 'X', client_type: '0' },
    ),
    'mixed',
  );
  assert.equal(resolveIdentityProvenance({ clid: '1' }, { clid: '1' }), 'none');
});
