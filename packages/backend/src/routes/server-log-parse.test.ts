import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLogTimestamp, parseServerLogLine } from '@ts6/common';

describe('parseServerLogLine', () => {
  it('parses known levels and leaves unknown levels as Unknown', () => {
    const info = parseServerLogLine('2026-03-15 12:00:05.123456|INFO    |VirtualServer |1  |hello');
    assert.equal(info.level, 'INFO');
    assert.equal(info.sourceTimestamp, '2026-03-15 12:00:05.123456');
    assert.equal(info.timezoneEstablished, false);

    const notice = parseServerLogLine('2026-03-15 12:00:00.000000|NOTICE  |VirtualServer |1  |x');
    assert.equal(notice.level, 'UNKNOWN');
    assert.equal(notice.rawLevel, 'NOTICE');

    const loose = parseServerLogLine('not structured — Unicode ✓');
    assert.equal(loose.level, 'UNKNOWN');
    assert.equal(loose.sourceTimestamp, null);
    assert.equal(loose.sourceText.includes('✓'), true);
  });

  it('does not convert timestamps when timezone is unknown', () => {
    const parsed = parseServerLogLine('2026-03-15 12:00:05.123456|ERROR   |VirtualServer |1  |boom');
    const formatted = formatLogTimestamp(parsed, 'local');
    assert.equal(formatted.text, '2026-03-15 12:00:05.123456');
    assert.equal(formatted.zoneLabel, 'timezone unknown');
  });
});
