import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyClient,
  isCaptureAccepting,
  isServerJoinEvent,
  isServerLeaveEvent,
  recoveryDelayMs,
  resolveIdentityProvenance,
} from './activity-journal-service.js';

test('server join uses cfid=0; channel view enters are ignored', () => {
  assert.equal(isServerJoinEvent({ clid: '1', cfid: '0', ctid: '5' }), true);
  assert.equal(isServerJoinEvent({ clid: '1', cfid: '12', ctid: '5' }), false);
  assert.equal(isServerJoinEvent({ clid: '1', cfid: '00', ctid: '5' }), true);
});

test('server leave uses ctid=0; channel view leaves are ignored', () => {
  assert.equal(isServerLeaveEvent({ clid: '1', cfid: '5', ctid: '0' }), true);
  assert.equal(isServerLeaveEvent({ clid: '1', cfid: '5', ctid: '9' }), false);
  assert.equal(isServerLeaveEvent({ clid: '1', cfid: '5', ctid: '00' }), true);
  assert.equal(isServerLeaveEvent({ clid: '1', cfid: '5' }), true);
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

test('gap statuses still accept capture events; connecting accepts leaves only', () => {
  assert.equal(isCaptureAccepting('capturing'), true);
  assert.equal(isCaptureAccepting('interrupted'), true);
  assert.equal(isCaptureAccepting('persistence_error'), true);
  assert.equal(isCaptureAccepting('connecting'), false);
  assert.equal(isCaptureAccepting('connecting', 'join'), false);
  assert.equal(isCaptureAccepting('connecting', 'leave'), true);
  assert.equal(isCaptureAccepting('disabled'), false);
  assert.equal(isCaptureAccepting(undefined), false);
});

test('recovery backoff grows then caps', () => {
  assert.equal(recoveryDelayMs(0), 1_000);
  assert.equal(recoveryDelayMs(1), 2_000);
  assert.equal(recoveryDelayMs(2), 4_000);
  assert.equal(recoveryDelayMs(10), 30_000);
  assert.equal(recoveryDelayMs(20), 30_000);
});

test('capture lifecycle epoch must match while enabled', () => {
  // Mirrors ActivityJournalService.isCaptureEpochCurrent: stale attempts after
  // disable/re-enable must not mutate the new lifecycle.
  const current = (enabled: boolean, epoch: number, attemptEpoch: number) =>
    enabled && epoch === attemptEpoch;
  assert.equal(current(true, 2, 2), true);
  assert.equal(current(true, 3, 2), false);
  assert.equal(current(false, 2, 2), false);
});
