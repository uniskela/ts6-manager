import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { MediaEgressError } from './media-egress.js';
import { mediaFetcherEnabled, radioAllowsHls, RADIO_HLS_RESTRICTED, submitMediaFetch } from './media-fetcher-client.js';

const saved = {
  flag: process.env.MEDIA_FETCHER,
  sock: process.env.MEDIA_FETCHER_SOCK,
  token: process.env.MEDIA_FETCHER_TOKEN_FILE,
  hls: process.env.RADIO_ALLOW_HLS,
};

afterEach(() => {
  for (const [key, value] of [
    ['MEDIA_FETCHER', saved.flag],
    ['MEDIA_FETCHER_SOCK', saved.sock],
    ['MEDIA_FETCHER_TOKEN_FILE', saved.token],
    ['RADIO_ALLOW_HLS', saved.hls],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('media fetcher flag', () => {
  it('is off unless MEDIA_FETCHER is exactly 1', () => {
    assert.equal(mediaFetcherEnabled({}), false);
    assert.equal(mediaFetcherEnabled({ MEDIA_FETCHER: 'true' }), false);
    assert.equal(mediaFetcherEnabled({ MEDIA_FETCHER: '1' }), true);
  });

  it('allows HLS unless RADIO_ALLOW_HLS=0', () => {
    assert.equal(radioAllowsHls({}), true);
    assert.equal(radioAllowsHls({ RADIO_ALLOW_HLS: '0' }), false);
    assert.match(RADIO_HLS_RESTRICTED, /does not fully resolve SSRF/);
  });
});

describe('submitMediaFetch', () => {
  it('fails closed when the token file or job socket is missing', async () => {
    const spawn = mock.method(childProcess, 'spawn', () => {
      throw new Error('must not spawn');
    });
    try {
      await assert.rejects(
        () => submitMediaFetch('https://203.0.113.10/live', {
          MEDIA_FETCHER: '1',
          MEDIA_FETCHER_SOCK: '/tmp/ts6-missing-jobs.sock',
        }),
        MediaEgressError,
      );
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-fetch-'));
      const token = path.join(dir, 'token');
      fs.writeFileSync(token, '0123456789abcdef0123456789abcdef');
      await assert.rejects(
        () => submitMediaFetch('https://203.0.113.10/live', {
          MEDIA_FETCHER: '1',
          MEDIA_FETCHER_SOCK: path.join(dir, 'missing.sock'),
          MEDIA_FETCHER_TOKEN_FILE: token,
        }),
        MediaEgressError,
      );
      fs.rmSync(dir, { recursive: true, force: true });
      assert.equal(spawn.mock.calls.length, 0);
    } finally {
      spawn.mock.restore();
    }
  });
});
