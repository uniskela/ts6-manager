import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getYtDlpPath } from './yt-dlp-path.js';

test('yt-dlp uses the fixed bundled path despite an attacker-controlled PATH', () => {
  assert.equal(getYtDlpPath({ PATH: '/tmp/untrusted:.' }), '/usr/local/bin/yt-dlp');
});

test('yt-dlp accepts an explicit absolute path and rejects PATH-relative commands', () => {
  assert.equal(getYtDlpPath({ YT_DLP_PATH: '/trusted/tools/yt-dlp' }), '/trusted/tools/yt-dlp');
  for (const command of ['yt-dlp', './yt-dlp', '']) {
    assert.throws(() => getYtDlpPath({ YT_DLP_PATH: command }), /must be an absolute path/);
  }
});
