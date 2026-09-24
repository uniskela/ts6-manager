import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatLogTimestamp,
  levelBadgeLabel,
  logLevelMatchesFilter,
  normalizeServerLogLevel,
  parseServerLogLine,
} from '@ts6/common';

describe('parseServerLogLine', () => {
  it('parses known levels and leaves unknown levels as Unknown', () => {
    const info = parseServerLogLine('2026-03-15 12:00:05.123456|INFO    |VirtualServer |1  |hello');
    assert.equal(info.level, 'INFO');
    assert.equal(info.sourceTimestamp, '2026-03-15 12:00:05.123456');
    assert.equal(info.timezoneEstablished, false);

    const notice = parseServerLogLine('2026-03-15 12:00:00.000000|NOTICE  |VirtualServer |1  |x');
    assert.equal(notice.level, 'UNKNOWN');
    assert.equal(notice.rawLevel, 'NOTICE');

    const loose = parseServerLogLine('not a structured line — Unicode ✓');
    assert.equal(loose.level, 'UNKNOWN');
    assert.equal(loose.sourceTimestamp, null);
    assert.equal(loose.sourceText.includes('✓'), true);
  });

  it('maps WAR / WARN abbreviations to WARNING so Warning filter matches', () => {
    const war = parseServerLogLine(
      '2026-03-15 12:00:04.123456|WAR     |VirtualServer |1  |privilege key used by client \"Sample\"',
    );
    assert.equal(war.level, 'WARNING');
    assert.equal(war.rawLevel, 'WAR');
    assert.equal(levelBadgeLabel(war.level), 'WAR');
    assert.equal(logLevelMatchesFilter(war.level, 'WARNING'), true);

    const warn = parseServerLogLine(
      '2026-03-15 12:00:04.123456|WARN    |VirtualServer |1  |privilege key expired',
    );
    assert.equal(warn.level, 'WARNING');
    assert.equal(logLevelMatchesFilter(warn.level, 'WARNING'), true);

    const full = parseServerLogLine(
      '2026-03-15 12:00:04.123456|WARNING |VirtualServer |1  |Client Sample User connected with an unusual client version.',
    );
    assert.equal(full.level, 'WARNING');
    assert.equal(levelBadgeLabel(full.level), 'WAR');
    assert.equal(logLevelMatchesFilter(full.level, 'WARNING'), true);
  });

  it('recovers WARNING from separator / embedded |WARNING| lines', () => {
    const sep = parseServerLogLine('--------------------|WARNING|--------------------');
    assert.equal(sep.level, 'WARNING');
    assert.equal(sep.rawLevel, 'WARNING');
    assert.equal(logLevelMatchesFilter(sep.level, 'WARNING'), true);

    const frag = parseServerLogLine('|WAR|privilege key fragment without timestamp');
    assert.equal(frag.level, 'WARNING');
    assert.equal(logLevelMatchesFilter(frag.level, 'WARNING'), true);
  });

  it('normalizes other common abbreviations', () => {
    assert.equal(normalizeServerLogLevel('ERR'), 'ERROR');
    assert.equal(normalizeServerLogLevel('INF'), 'INFO');
    assert.equal(normalizeServerLogLevel('DBG'), 'DEBUG');
    assert.equal(normalizeServerLogLevel('nope'), 'UNKNOWN');
    assert.equal(logLevelMatchesFilter('ERROR', 'ERR'), true);
    assert.equal(logLevelMatchesFilter('INFO', 'ALL'), true);
    assert.equal(logLevelMatchesFilter('WARNING', 'INFO'), false);
    assert.equal(logLevelMatchesFilter('UNKNOWN', 'UNKNOWN'), true);
  });

  it('does not convert timestamps when timezone is unknown', () => {
    const parsed = parseServerLogLine('2026-03-15 12:00:05.123456|ERROR   |VirtualServer |1  |boom');
    const formatted = formatLogTimestamp(parsed, 'local');
    assert.equal(formatted.text, '2026-03-15 12:00:05.123456');
    assert.equal(formatted.zoneLabel, 'timezone unknown');
  });
});
