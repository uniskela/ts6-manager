import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildServerLogPage,
  parseLogQuery,
  verifiedNextBeginPos,
  LOGVIEW_MAX_LINES,
} from './logs-page.js';

describe('parseLogQuery', () => {
  it('applies defaults and accepts bounded page sizes', () => {
    assert.deepEqual(parseLogQuery({}), {
      ok: true,
      lines: 100,
      reverse: 1,
      instance: 0,
      beginPos: undefined,
    });
    assert.equal((parseLogQuery({ lines: '50' }) as any).lines, 50);
    assert.equal((parseLogQuery({ lines: String(LOGVIEW_MAX_LINES) }) as any).lines, LOGVIEW_MAX_LINES);
  });

  it('rejects malformed parameters', () => {
    assert.equal(parseLogQuery({ lines: '0' }).ok, false);
    assert.equal(parseLogQuery({ lines: '101' }).ok, false);
    assert.equal(parseLogQuery({ lines: 'abc' }).ok, false);
    assert.equal(parseLogQuery({ reverse: '2' }).ok, false);
    assert.equal(parseLogQuery({ instance: 'yes' }).ok, false);
    assert.equal(parseLogQuery({ begin_pos: '-1' }).ok, false);
    assert.equal(parseLogQuery({ begin_pos: '12.5' }).ok, false);
    assert.equal(parseLogQuery({ begin_pos: '1e3' }).ok, false);
  });

  it('accepts a verified begin_pos digit string', () => {
    const parsed = parseLogQuery({ begin_pos: '403788', lines: '30', reverse: '1', instance: '1' });
    assert.deepEqual(parsed, {
      ok: true,
      lines: 30,
      reverse: 1,
      instance: 1,
      beginPos: '403788',
    });
  });
});

describe('verifiedNextBeginPos', () => {
  it('uses last-row last_pos for reverse=1 and never invents from text length', () => {
    assert.equal(verifiedNextBeginPos([]), null);
    assert.equal(verifiedNextBeginPos([{ l: 'x'.repeat(500) }]), null);
    assert.equal(verifiedNextBeginPos([{ last_pos: '0', file_size: '100', l: 'a' }]), null);
    assert.equal(verifiedNextBeginPos([{ last_pos: 'abc', file_size: '100', l: 'a' }]), null);
    assert.equal(
      verifiedNextBeginPos([{ last_pos: '200', file_size: '100', l: 'a' }]),
      null,
    );
    assert.equal(
      verifiedNextBeginPos([
        { last_pos: '90', file_size: '100', l: 'newest' },
        { last_pos: '40', file_size: '100', l: 'older' },
      ], 1),
      '40',
    );
    assert.equal(
      verifiedNextBeginPos([
        { last_pos: '40', file_size: '100', l: 'older' },
        { last_pos: '90', file_size: '100', l: 'newer' },
      ], 0),
      '40',
    );
  });
});

describe('buildServerLogPage', () => {
  it('preserves source text and builds a typed envelope without totals', () => {
    const page = buildServerLogPage({
      configId: 3,
      sid: 2,
      lines: 50,
      reverse: 1,
      instance: 0,
      beginPos: undefined,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      raw: [
        { last_pos: '90', file_size: '100', l: '2026-01-01 00:00:00.000000|INFO    |VirtualServer |2  |hello' },
        { last_pos: '40', file_size: '100', l: 'not a structured line' },
      ],
    });

    assert.equal(page.entries.length, 2);
    assert.equal(page.entries[0].sourceText.includes('hello'), true);
    assert.equal(page.entries[1].sourceText, 'not a structured line');
    assert.equal(page.fileSize, '100');
    assert.equal(page.nextBeginPos, '40');
    assert.equal(page.context.instance, false);
    assert.equal(page.context.beginPos, null);
    assert.equal((page as any).total, undefined);
    assert.equal((page as any).totalCount, undefined);
  });

  it('marks instance context and empty pages without a cursor', () => {
    const page = buildServerLogPage({
      configId: 1,
      sid: 1,
      lines: 50,
      reverse: 1,
      instance: 1,
      beginPos: '10',
      fetchedAt: '2026-09-24T00:00:00.000Z',
      raw: [],
    });
    assert.equal(page.context.instance, true);
    assert.equal(page.context.beginPos, '10');
    assert.equal(page.nextBeginPos, null);
    assert.equal(page.fileSize, null);
    assert.deepEqual(page.entries, []);
  });

  it('normalizes a single logview object body into one entry', () => {
    const page = buildServerLogPage({
      configId: 1,
      sid: 1,
      lines: 50,
      reverse: 1,
      instance: 1,
      beginPos: undefined,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      raw: { last_pos: '80', file_size: '80', l: '2026-01-01 00:00:00.000000|INFO    |ServerLibPriv |   |only row' },
    });
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].sourceText.includes('only row'), true);
    assert.equal(page.nextBeginPos, '80');
    assert.equal(page.fileSize, '80');
    assert.equal(page.context.instance, true);
  });
});
