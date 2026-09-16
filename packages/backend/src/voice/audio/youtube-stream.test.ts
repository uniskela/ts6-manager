import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractYtDlpStreamHeaders } from './youtube.js';

describe('extractYtDlpStreamHeaders', () => {
  it('preserves top-level yt-dlp HTTP headers for the selected stream', () => {
    const headers = extractYtDlpStreamHeaders({
      http_headers: {
        'User-Agent': 'Mozilla/5.0 test',
        Referer: 'https://www.youtube.com/',
        Accept: '*/*',
      },
    });

    assert.deepEqual(headers, {
      'User-Agent': 'Mozilla/5.0 test',
      Referer: 'https://www.youtube.com/',
      Accept: '*/*',
    });
  });

  it('falls back to requested format headers when the top-level object has none', () => {
    const headers = extractYtDlpStreamHeaders({
      requested_formats: [
        {
          url: 'https://rr.example.test/audio',
          http_headers: {
            Origin: 'https://www.youtube.com',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
      ],
    });

    assert.deepEqual(headers, {
      Origin: 'https://www.youtube.com',
      'Accept-Language': 'en-US,en;q=0.9',
    });
  });

  it('drops non-string header values from yt-dlp JSON', () => {
    const headers = extractYtDlpStreamHeaders({
      http_headers: {
        'User-Agent': 'Mozilla/5.0 test',
        Broken: 123,
        Missing: null,
      },
    });

    assert.deepEqual(headers, { 'User-Agent': 'Mozilla/5.0 test' });
  });
});
