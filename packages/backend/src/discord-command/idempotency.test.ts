import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandResult, DiscordCommandIntent } from './adapter.js';
import {
  IDEMPOTENCY_RESULT_TTL_MS,
  MemoryCommandIdempotency,
  musicIdempotencyKey,
} from './idempotency.js';

const ok = (content: string): CommandResult => ({
  ok: true, code: 'ok', ephemeral: true, content, ack: 'immediate',
});
const fail = (content: string): CommandResult => ({
  ok: false, code: 'unavailable', ephemeral: true, content, ack: 'deferred',
});

function intent(partial: Partial<DiscordCommandIntent> = {}): DiscordCommandIntent {
  return {
    guildId: 'g1',
    userId: 'u1',
    roleIds: [],
    memberPermissions: '0',
    command: 'play',
    idempotencyKey: 'ix-1',
    ...partial,
  };
}

describe('MemoryCommandIdempotency', () => {
  it('records success and replays it without a second execute slot', () => {
    const store = new MemoryCommandIdempotency(60_000);
    const key = musicIdempotencyKey(intent())!;
    assert.equal(store.begin(key, 1_000).kind, 'execute');
    store.complete(key, ok('Now playing'), 1_001);
    const again = store.begin(key, 1_002);
    assert.equal(again.kind, 'replay');
    if (again.kind === 'replay') {
      assert.equal(again.result.ok, true);
      assert.equal(again.result.content, 'Now playing');
    }
  });

  it('records failure and never upgrades a retry to success', () => {
    const store = new MemoryCommandIdempotency(60_000);
    const key = musicIdempotencyKey(intent())!;
    assert.equal(store.begin(key, 1_000).kind, 'execute');
    store.complete(key, fail('Nothing is playing.'), 1_001);
    const again = store.begin(key, 1_002);
    assert.equal(again.kind, 'replay');
    if (again.kind === 'replay') {
      assert.equal(again.result.ok, false);
      assert.equal(again.result.content, 'Nothing is playing.');
    }
  });

  it('treats concurrent identical keys as pending until complete', () => {
    const store = new MemoryCommandIdempotency(60_000);
    const key = musicIdempotencyKey(intent())!;
    assert.equal(store.begin(key, 1_000).kind, 'execute');
    assert.equal(store.begin(key, 1_000).kind, 'pending');
    store.complete(key, ok('Paused.'), 1_050);
    const again = store.begin(key, 1_051);
    assert.equal(again.kind, 'replay');
  });

  it('keeps pending claims beyond the completed-result TTL', () => {
    const store = new MemoryCommandIdempotency(IDEMPOTENCY_RESULT_TTL_MS);
    const key = musicIdempotencyKey(intent())!;
    assert.equal(store.begin(key, 0).kind, 'execute');
    // Far past the 60s result TTL — still pending, must not re-execute.
    assert.equal(store.begin(key, IDEMPOTENCY_RESULT_TTL_MS + 1).kind, 'pending');
    assert.equal(store.peek(key, IDEMPOTENCY_RESULT_TTL_MS + 1)?.state, 'pending');
    store.complete(key, ok('late'), IDEMPOTENCY_RESULT_TTL_MS + 2);
    const replay = store.begin(key, IDEMPOTENCY_RESULT_TTL_MS + 3);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') assert.equal(replay.result.content, 'late');
  });

  it('expires completed outcomes after the documented retention window', () => {
    const store = new MemoryCommandIdempotency(100);
    const key = musicIdempotencyKey(intent())!;
    store.begin(key, 1_000);
    store.complete(key, fail('Search failed.'), 1_000);
    assert.equal(store.begin(key, 1_050).kind, 'replay');
    assert.equal(store.begin(key, 1_101).kind, 'execute');
  });

  it('evicts completed records under capacity pressure but never pending', () => {
    const store = new MemoryCommandIdempotency(60_000, 2);
    assert.equal(store.begin('done-a', 1).kind, 'execute');
    store.complete('done-a', ok('a'), 1);
    assert.equal(store.begin('pending-b', 2).kind, 'execute');
    // Cap is 2: inserting c must evict completed done-a, keep pending-b.
    assert.equal(store.begin('c', 3).kind, 'execute');
    assert.equal(store.begin('pending-b', 3).kind, 'pending');
    assert.equal(store.peek('done-a', 3), undefined);
    store.complete('c', ok('c'), 3);
    // done-c + pending-b: replay of c still works; pending-b untouched.
    assert.equal(store.begin('c', 4).kind, 'replay');
    assert.equal(store.begin('pending-b', 4).kind, 'pending');
  });

  it('refuses new claims when capacity is exhausted by pending work', () => {
    const store = new MemoryCommandIdempotency(60_000, 2);
    assert.equal(store.begin('p1', 1).kind, 'execute');
    assert.equal(store.begin('p2', 2).kind, 'execute');
    assert.equal(store.begin('p3', 3).kind, 'full');
    assert.equal(store.begin('p1', 3).kind, 'pending');
    assert.equal(store.begin('p2', 3).kind, 'pending');
    store.complete('p1', ok('one'), 4);
    // Completing frees a slot (still size 2: done+pending); new claim can proceed by
    // evicting the completed record if needed.
    assert.equal(store.begin('p3', 5).kind, 'execute');
    assert.equal(store.begin('p2', 5).kind, 'pending');
  });

  it('isolates keys across guild, user, command, subcommand, and interaction id', () => {
    const store = new MemoryCommandIdempotency(60_000);
    const a = musicIdempotencyKey(intent({ guildId: 'g1', userId: 'u1', command: 'play', idempotencyKey: 'ix' }))!;
    const b = musicIdempotencyKey(intent({ guildId: 'g2', userId: 'u1', command: 'play', idempotencyKey: 'ix' }))!;
    const c = musicIdempotencyKey(intent({ guildId: 'g1', userId: 'u2', command: 'play', idempotencyKey: 'ix' }))!;
    const d = musicIdempotencyKey(intent({ guildId: 'g1', userId: 'u1', command: 'skip', idempotencyKey: 'ix' }))!;
    const e = musicIdempotencyKey(intent({ guildId: 'g1', userId: 'u1', command: 'play', idempotencyKey: 'ix-2' }))!;
    const f = musicIdempotencyKey(intent({
      guildId: 'g1', userId: 'u1', command: 'playlist', args: { subcommand: 'play' }, idempotencyKey: 'ix',
    }))!;
    const g = musicIdempotencyKey(intent({
      guildId: 'g1', userId: 'u1', command: 'playlist', args: { subcommand: 'create' }, idempotencyKey: 'ix',
    }))!;
    const keys = new Set([a, b, c, d, e, f, g]);
    assert.equal(keys.size, 7);
    for (const key of keys) assert.equal(store.begin(key, 1_000).kind, 'execute');
  });

  it('does not treat a different interaction id as a cached success for another payload', () => {
    const store = new MemoryCommandIdempotency(60_000);
    const first = musicIdempotencyKey(intent({
      command: 'play',
      args: { query: 'https://a.example/track' },
      idempotencyKey: 'ix-a',
    }))!;
    const second = musicIdempotencyKey(intent({
      command: 'play',
      args: { query: 'https://b.example/other' },
      idempotencyKey: 'ix-b',
    }))!;
    assert.notEqual(first, second);
    store.begin(first, 1);
    store.complete(first, ok('Now playing: A'), 1);
    assert.equal(store.begin(second, 2).kind, 'execute');
  });

  it('transitions pending to a recorded outcome on complete, including failures', () => {
    const store = new MemoryCommandIdempotency(60_000);
    const key = 'k';
    store.begin(key, 1);
    assert.equal(store.peek(key, 1)?.state, 'pending');
    store.complete(key, fail('boom'), 2);
    assert.equal(store.peek(key, 2)?.state, 'done');
    const again = store.begin(key, 3);
    assert.equal(again.kind, 'replay');
    if (again.kind === 'replay') assert.equal(again.result.ok, false);
  });
});
