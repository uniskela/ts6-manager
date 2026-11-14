import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { radioFfmpegArgs } from './ffmpeg-args.mjs';

describe('radio ffmpeg args', () => {
  it('verifies TLS on HTTPS starts and omits TLS AVOptions on HTTP (httpproxy)', () => {
    const http = radioFfmpegArgs('http://203.0.113.10/live.m3u8', { ca: '/jobs/ca.crt' });
    const https = radioFfmpegArgs('https://203.0.113.10/live', { ca: '/jobs/ca.crt' });
    assert.equal(http.includes('-tls_verify'), false);
    assert.equal(http.includes('-ca_file'), false);
    assert.equal(https[https.indexOf('-tls_verify') + 1], '1');
    assert.ok(https.indexOf('-tls_verify') < https.indexOf('-i'));
    assert.equal(https[https.indexOf('-ca_file') + 1], '/jobs/ca.crt');
    assert.equal(http[http.indexOf('-allowed_extensions') + 1], 'ALL');
    assert.equal(https.includes('-allowed_extensions'), false);
  });
});
