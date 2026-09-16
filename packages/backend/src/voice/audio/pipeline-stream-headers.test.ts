import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPcmStreamArgs } from './pipeline.js';

describe('buildPcmStreamArgs', () => {
  it('passes safe yt-dlp headers to ffmpeg before the input URL', () => {
    const args = buildPcmStreamArgs('https://rr.example.test/audio', {
      'User-Agent': 'Mozilla/5.0 test',
      Referer: 'https://www.youtube.com/',
      Origin: 'https://www.youtube.com',
    });

    const headerIndex = args.indexOf('-headers');
    const inputIndex = args.indexOf('-i');

    assert.ok(headerIndex >= 0);
    assert.ok(headerIndex < inputIndex);
    assert.equal(
      args[headerIndex + 1],
      'User-Agent: Mozilla/5.0 test\r\nReferer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n',
    );
    assert.equal(args[inputIndex + 1], 'https://rr.example.test/audio');
  });

  it('does not add a headers option when none are supplied', () => {
    const args = buildPcmStreamArgs('https://radio.example.test/live');
    assert.equal(args.includes('-headers'), false);
  });

  it('drops scoped cookies and header injection attempts before invoking ffmpeg', () => {
    const args = buildPcmStreamArgs('https://rr.example.test/audio', {
      Cookie: 'SID=secret',
      'User-Agent': 'safe-agent',
      'X-Bad': 'safe\r\nInjected: yes',
      'Bad\nName': 'value',
    });

    const headerIndex = args.indexOf('-headers');
    assert.ok(headerIndex >= 0);
    assert.equal(args[headerIndex + 1], 'User-Agent: safe-agent\r\n');
  });
});
