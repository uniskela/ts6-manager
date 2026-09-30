import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENCODE_PROFILE_PRESETS,
  applyEncodeProfile,
  inferEncodeProfile,
} from './encode-profiles.js';

describe('encode profiles', () => {
  it('maps performance/balanced/quality', () => {
    assert.deepEqual(applyEncodeProfile('performance'), {
      autoMaxPreset: '720p',
      maxBitrateKbps: 2500,
      cpuUsed: 6,
      encodeProfile: 'performance',
    });
    assert.equal(applyEncodeProfile('balanced').cpuUsed, 4);
    assert.equal(applyEncodeProfile('balanced').autoMaxPreset, '1080p');
    assert.equal(applyEncodeProfile('quality').maxBitrateKbps, 0);
    assert.equal(applyEncodeProfile('quality').cpuUsed, 2);
    assert.equal(ENCODE_PROFILE_PRESETS.quality.autoMaxPreset, '1440p');
  });

  it('infers named profiles and custom when settings diverge', () => {
    assert.equal(
      inferEncodeProfile({ autoMaxPreset: '720p', maxBitrateKbps: 2500, cpuUsed: 6 }),
      'performance',
    );
    assert.equal(
      inferEncodeProfile({ autoMaxPreset: '1080p', maxBitrateKbps: 4500, cpuUsed: 4 }),
      'balanced',
    );
    assert.equal(
      inferEncodeProfile({ autoMaxPreset: '720p', maxBitrateKbps: 999, cpuUsed: 6 }),
      'custom',
    );
  });
});
