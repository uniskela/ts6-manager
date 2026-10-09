import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveMediaIdentity, listHumanMediaListeners, VoteSkip } from './media-listeners.js';

test('identity lookup uses fresh server groups, verifies UID and fails closed', async () => {
  const query = async (command: string) => {
    assert.equal(command, 'clientinfo clid=2');
    return 'client_unique_identifier=human client_servergroups=6,9 client_type=0\nerror id=0 msg=ok';
  };
  assert.deepEqual(await resolveMediaIdentity(query, 2, 'human'), { uid: 'human', serverGroupIds: [6, 9] });
  assert.equal(await resolveMediaIdentity(query, 2, 'old-session'), null);
  assert.equal(await resolveMediaIdentity(query, 0), null);
  for (const response of ['client_servergroups=6', 'client_unique_identifier=human', 'client_unique_identifier=human client_servergroups=6x', 'client_unique_identifier=bot client_servergroups=6 client_type=1']) {
    assert.equal(await resolveMediaIdentity(async () => response, 2), null);
  }
  assert.equal(await resolveMediaIdentity(async () => { throw new Error('offline'); }, 2), null);
});

test('listener roster excludes query and managed bots, other channels and missing identities', async () => {
  const listeners = await listHumanMediaListeners(async (command) => {
    assert.equal(command, 'clientlist -uid');
    return 'clid=1 cid=5 client_type=0 client_unique_identifier=a|clid=2 cid=5 client_type=0 client_unique_identifier=b|clid=3 cid=5 client_type=1 client_unique_identifier=q|clid=4 cid=5 client_type=0 client_unique_identifier=music|clid=5 cid=6 client_type=0 client_unique_identifier=elsewhere';
  }, 5, new Set([4]));
  assert.deepEqual(listeners, [{ clid: 1, uid: 'a' }, { clid: 2, uid: 'b' }]);
  assert.equal(await listHumanMediaListeners(async () => { throw new Error('offline'); }, 5, new Set()), null);
  assert.equal(await listHumanMediaListeners(async () => 'clid=1 cid=5 client_type=0 client_unique_identifier=a|clid=2 cid=5 client_type=0', 5, new Set()), null, 'missing human identity cannot lower the majority');
});

test('vote-skip requires strictly more than half, deduplicates UID, resets on playback token changes', () => {
  const votes = new VoteSkip();
  const bot = {};
  const token = {};
  assert.equal(votes.vote(bot, token, 'a', ['a', 'b', 'c', 'd']).passed, false);
  assert.deepEqual(votes.vote(bot, token, 'a', ['a', 'b', 'c', 'd']), { votes: 1, required: 3, passed: false, duplicate: true });
  assert.equal(votes.vote(bot, token, 'b', ['a', 'b', 'c', 'd']).passed, false);
  assert.equal(votes.vote(bot, token, 'c', ['a', 'b', 'c', 'd']).passed, true);
  assert.equal(votes.vote(bot, token, 'd', ['a', 'b', 'c', 'd']).passed, false, 'only one skip per token');
  assert.equal(votes.vote(bot, {}, 'a', ['a', 'b', 'c']).votes, 1);
  for (const count of [1, 2, 3, 4, 5]) {
    const track = {};
    const listeners = Array.from({ length: count }, (_, i) => String(i));
    for (let i = 0; i < Math.floor(count / 2) + 1; i++) {
      const result = votes.vote(bot, track, String(i), listeners);
      assert.equal(result.passed, i === Math.floor(count / 2));
    }
  }
});

test('only current listeners vote and departed listeners lose their votes', () => {
  const votes = new VoteSkip();
  const bot = {}, token = {};
  assert.equal(votes.vote(bot, token, 'outsider', ['a', 'b']), null);
  votes.vote(bot, token, 'a', ['a', 'b', 'c', 'd']);
  const result = votes.vote(bot, token, 'b', ['b', 'c', 'd']);
  assert.equal(result.votes, 1);
  assert.equal(result.passed, false);
  assert.equal(votes.vote(bot, token, 'c', ['b', 'c', 'c', 'd']).passed, true);
});
