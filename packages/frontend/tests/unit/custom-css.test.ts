import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CUSTOM_CSS_MAX_BYTES,
  isCustomCssWithinLimit,
  sanitizeCustomCssEnabled,
  sanitizeCustomCssText,
  utf8ByteLength,
} from '../../src/lib/custom-css.ts';
import {
  evaluateSafeUiLatch,
  isSafeUiActive,
  isSafeUiQueryParam,
  resetSafeUiLatchForTests,
} from '../../src/lib/safe-ui.ts';

describe('custom-css helpers', () => {
  it('defaults treat non-strings and empty as disabled', () => {
    assert.equal(sanitizeCustomCssText(undefined), '');
    assert.equal(sanitizeCustomCssText(null), '');
    assert.equal(sanitizeCustomCssText(12), '');
    assert.equal(sanitizeCustomCssEnabled(true, ''), false);
    assert.equal(sanitizeCustomCssEnabled(true, 'body{}'), true);
    assert.equal(sanitizeCustomCssEnabled('yes', 'body{}'), false);
  });

  it('rejects oversized CSS instead of truncating', () => {
    const oversized = 'a'.repeat(CUSTOM_CSS_MAX_BYTES + 1);
    assert.equal(isCustomCssWithinLimit(oversized), false);
    assert.equal(sanitizeCustomCssText(oversized), '');
    assert.equal(sanitizeCustomCssEnabled(true, sanitizeCustomCssText(oversized)), false);
  });

  it('accepts CSS at the exact byte limit', () => {
    const exact = 'b'.repeat(CUSTOM_CSS_MAX_BYTES);
    assert.equal(utf8ByteLength(exact), CUSTOM_CSS_MAX_BYTES);
    assert.equal(isCustomCssWithinLimit(exact), true);
    assert.equal(sanitizeCustomCssText(exact), exact);
  });

  it('counts multi-byte UTF-8 toward the limit', () => {
    // '€' is 3 bytes in UTF-8
    const text = `${'€'.repeat(Math.floor(CUSTOM_CSS_MAX_BYTES / 3))}xxxx`;
    assert.equal(isCustomCssWithinLimit(text), utf8ByteLength(text) <= CUSTOM_CSS_MAX_BYTES);
    if (utf8ByteLength(text) > CUSTOM_CSS_MAX_BYTES) {
      assert.equal(sanitizeCustomCssText(text), '');
    }
  });
});

describe('safe-ui latch', () => {
  it('detects the recovery query flag', () => {
    assert.equal(isSafeUiQueryParam('?safe-ui=1'), true);
    assert.equal(isSafeUiQueryParam('tab=appearance&safe-ui=1'), true);
    assert.equal(isSafeUiQueryParam('?safe-ui=0'), false);
    assert.equal(isSafeUiQueryParam(''), false);
  });

  it('latches for the document lifetime and never clears', () => {
    resetSafeUiLatchForTests();
    assert.equal(evaluateSafeUiLatch('?safe-ui=1'), true);
    assert.equal(isSafeUiActive(), true);
    // Later navigations without the query cannot clear the latch.
    assert.equal(evaluateSafeUiLatch(''), true);
    assert.equal(isSafeUiActive(), true);
  });

  it('stays inactive when the query was never present', () => {
    resetSafeUiLatchForTests();
    assert.equal(evaluateSafeUiLatch(''), false);
    assert.equal(isSafeUiActive(), false);
    // First evaluation already happened without the flag; later presence does not latch
    // (real apps only evaluate once at boot — this documents that contract).
    assert.equal(evaluateSafeUiLatch('?safe-ui=1'), false);
  });
});
