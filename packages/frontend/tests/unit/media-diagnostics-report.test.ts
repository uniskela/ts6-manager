import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MediaAdminDiagnosticReport } from '@ts6/common';
import { redactDiagnosticText, redactDiagnosticValue } from '@ts6/common';
import { isExpensiveDiagnosticQuery } from '../../src/lib/demand-driven-query-policy.ts';
import {
  formatMediaDiagnosticReport,
  mediaDiagnosticStatusWord,
} from '../../src/lib/media-diagnostics-report.ts';

const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');

function sample(): MediaAdminDiagnosticReport {
  return {
    checkedAt: '2026-01-01T00:00:00.000Z',
    overall: 'partial',
    checks: [
      {
        id: 'ffmpeg',
        label: 'FFmpeg',
        status: 'ok',
        message: 'ffmpeg available',
        version: 'ffmpeg 6.1',
        path: '/usr/bin/ffmpeg',
      },
      {
        id: 'deno',
        label: 'Deno',
        status: 'warning',
        message: `deno was not found. Authorization: Bearer ${jwt}`,
        remediation: 'Pull or rebuild the image.',
      },
    ],
    sidecar: {
      mode: 'url',
      status: 'ok',
      message: 'Sidecar health endpoint reachable',
      healthStatus: 'ok',
      videoPort: 10000,
      audioPort: 10001,
    },
    encoders: {
      status: 'ok',
      message: 'cached',
      items: [
        { id: 'vp8', codec: 'vp8', hardware: false, available: true },
        { id: 'h264_nvenc', codec: 'h264', hardware: true, available: false, detail: 'no device' },
      ],
    },
    warnings: [`Deno: password=hunter2`],
  };
}

describe('media diagnostic report', () => {
  it('names Green, Warning, and Failed', () => {
    assert.equal(mediaDiagnosticStatusWord('ok'), 'Green');
    assert.equal(mediaDiagnosticStatusWord('warning'), 'Warning');
    assert.equal(mediaDiagnosticStatusWord('fail'), 'Failed');
    assert.equal(mediaDiagnosticStatusWord('skipped'), 'Not checked');
  });

  it('copies versions, encoders, and warnings with credentials removed', () => {
    const text = formatMediaDiagnosticReport(sample());
    assert.match(text, /FFmpeg — ffmpeg available \(ffmpeg 6\.1\)/);
    assert.match(text, /\[Green\] FFmpeg/);
    assert.match(text, /executable: \/usr\/bin\/ffmpeg/);
    assert.match(text, /\[Warning\] Deno/);
    assert.match(text, /version: not reported by GET \/health/);
    assert.match(text, /video port: 10000/);
    assert.match(text, /vp8 \(vp8, software\): available/);
    assert.match(text, /h264_nvenc \(h264, hardware\): unavailable — no device/);
    assert.equal(text.includes(jwt), false);
    assert.equal(text.includes('hunter2'), false);
    assert.match(text, /\[redacted/);
  });

  it('redacts cookie headers and api keys', () => {
    const text = redactDiagnosticText('Cookie: session=abc api_key=zzz Authorization: Bearer abc.def');
    assert.equal(text.includes('session=abc'), false);
    assert.equal(text.includes('zzz'), false);
    assert.equal(text.includes('abc.def'), false);
  });

  it('redacts whole headers, URL credentials, JSON assignments, and short JWT payloads', () => {
    for (const input of [
      'Authorization: Basic dXNlcjpwYXNz',
      'Cookie: session=abc; refresh=other-secret',
      'Set-Cookie: session=abc; Secure; HttpOnly',
      'https://user:pass@media.example.test/path?token=query-secret&format=pcm',
      'https://user:pass@media.example.test',
      '{"password":"json-secret", "api_key":"key-secret"}',
      'SIDECAR_SECRET=sidecar-secret',
      'eyJhbGciOiJIUzI1NiJ9.e30.signature',
      'eyJhbGciOiJIUzI1NiJ9.e30',
      'enc:0123456789abcdef:0123456789abcdef:abcdef0123456789',
    ]) {
      const text = redactDiagnosticText(input);
      assert.match(text, /\[redacted/);
      assert.doesNotMatch(text, /dXNlcjpwYXNz|session=abc|other-secret|user:pass|query-secret|json-secret|key-secret|sidecar-secret|\.e30\.signature|enc:0123456789abcdef/);
    }
    assert.equal(redactDiagnosticText('yt-dlp listed extractors without cookies'), 'yt-dlp listed extractors without cookies');
  });

  it('redacts nested credential values and preserves report fields', () => {
    assert.deepEqual(redactDiagnosticValue({
      password: 'bare-secret',
      nested: [{ SIDECAR_SECRET: 'bare-secret', message: 'token=bare-secret' }],
      status: 'ok',
    }), {
      password: '[redacted]',
      nested: [{ SIDECAR_SECRET: '[redacted]', message: 'token=[redacted]' }],
      status: 'ok',
    });
  });

  it('redacts quoted delimiters and mixed-case bearer credentials without losing adjacent fields', () => {
    const cases = [
      ['password="one two &,; three" format=pcm', 'password=[redacted] format=pcm'],
      ["secret='one two &,; three' format=pcm", 'secret=[redacted] format=pcm'],
      ['{"api-key":"one two", "format":"pcm"}', '{"api-key=[redacted], "format":"pcm"}'],
      ['TOKEN=one&format=pcm', 'TOKEN=[redacted]&format=pcm'],
      ['passwd=one; format=pcm', 'passwd=[redacted]; format=pcm'],
      ['cookie=one,format=pcm', 'cookie=[redacted],format=pcm'],
      ['secret="one\ntwo"\nformat=pcm', 'secret=[redacted]\nformat=pcm'],
      ['{"password":"one two"}', '{"password=[redacted]}'],
      ["(api_key='one two')", '(api_key=[redacted])'],
      ['token="one two", passwd="three four"', 'token=[redacted], passwd=[redacted]'],
      ['bEaReR AbCz09-._~+/== format=pcm', 'Bearer [redacted] format=pcm'],
      ['yt-dlp listed extractors without cookies', 'yt-dlp listed extractors without cookies'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(redactDiagnosticText(input), expected);
    }
  });

  it('treats the admin diagnostics query as expensive', () => {
    assert.equal(isExpensiveDiagnosticQuery({ queryKey: ['media-admin-diagnostics'] }), true);
  });
});
