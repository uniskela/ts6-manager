import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSidecarVersion } from './sidecar-version.js';

describe('checkSidecarVersion', () => {
  it('matches the same release, ignoring a leading v and whitespace', () => {
    assert.deepEqual(checkSidecarVersion('1.11.0', '1.11.0'), { state: 'match', label: '1.11.0', note: null });
    assert.equal(checkSidecarVersion('v1.11.0', ' 1.11.0 ').state, 'match');
  });

  it('reports a mismatch with both versions', () => {
    const check = checkSidecarVersion('1.11.0', '1.10.2');
    assert.equal(check.state, 'mismatch');
    assert.equal(check.label, '1.10.2');
    assert.match(check.note ?? '', /sidecar 1\.10\.2 does not match backend 1\.11\.0/);
  });

  it('treats a patch difference as a mismatch', () => {
    assert.equal(checkSidecarVersion('1.11.1', '1.11.0').state, 'mismatch');
  });

  it('cannot check a sidecar that reports no version', () => {
    for (const reported of [undefined, null, '']) {
      const check = checkSidecarVersion('1.11.0', reported);
      assert.equal(check.state, 'unknown');
      assert.equal(check.label, 'unversioned');
      assert.match(check.note ?? '', /older than 1\.11/);
    }
  });

  it('cannot check a source build', () => {
    const check = checkSidecarVersion('1.11.0', 'dev');
    assert.equal(check.state, 'unknown');
    assert.equal(check.label, 'dev');
  });

  it('reports the sidecar version when the backend version is unknown', () => {
    assert.deepEqual(checkSidecarVersion(undefined, '1.11.0'), { state: 'unknown', label: '1.11.0', note: null });
  });
});
