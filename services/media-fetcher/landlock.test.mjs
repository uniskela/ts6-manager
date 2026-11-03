import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { landlockDisabledByEnv, parseCheckOutput } from './landlock.mjs';

describe('landlock gate', () => {
  it('treats explicit disable flags as a hard refusal', () => {
    assert.equal(landlockDisabledByEnv({}), false);
    assert.equal(landlockDisabledByEnv({ LL_WRAP: '0' }), true);
    assert.equal(landlockDisabledByEnv({ MEDIA_FETCHER_DISABLE_LANDLOCK: '1' }), true);
  });

  it('requires ABI >= 4 and filesystem enforcement from ll-wrap --check', () => {
    assert.deepEqual(
      parseCheckOutput('landlock_abi=4\nlandlock_fs=1\nlandlock_resolve_unix=0\n', 0),
      { ok: true, abi: 4, fs: true },
    );
    assert.deepEqual(parseCheckOutput('landlock_abi=4\n', 0), { ok: false, abi: 4, fs: false });
    assert.deepEqual(parseCheckOutput('landlock_abi=3\nlandlock_fs=1\n', 0), { ok: false, abi: 3, fs: true });
    assert.deepEqual(parseCheckOutput('', 1), { ok: false, abi: 0, fs: false });
  });
});
