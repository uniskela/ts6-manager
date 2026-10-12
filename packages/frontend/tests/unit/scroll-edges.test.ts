import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scrollEdgesOf } from '../../src/hooks/use-scroll-edges';

describe('scroll edge hints', () => {
  it('shows no hint when the content fits', () => {
    assert.deepEqual(scrollEdgesOf({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }), { top: false, bottom: false });
  });

  it('points to hidden content above and below', () => {
    assert.deepEqual(scrollEdgesOf({ scrollTop: 0, scrollHeight: 556, clientHeight: 273 }), { top: false, bottom: true });
    assert.deepEqual(scrollEdgesOf({ scrollTop: 120, scrollHeight: 556, clientHeight: 273 }), { top: true, bottom: true });
    assert.deepEqual(scrollEdgesOf({ scrollTop: 283, scrollHeight: 556, clientHeight: 273 }), { top: true, bottom: false });
  });

  it('treats the furthest reachable position at a zoomed display as the end', () => {
    // Measured in Chromium at 110% zoom: the list cannot scroll past 281.82 although
    // scrollHeight - clientHeight is 283.
    assert.deepEqual(
      scrollEdgesOf({ scrollTop: 281.81817626953125, scrollHeight: 556, clientHeight: 273 }),
      { top: true, bottom: false },
    );
    assert.deepEqual(
      scrollEdgesOf({ scrollTop: 120.90908813476562, scrollHeight: 556, clientHeight: 434 }),
      { top: true, bottom: false },
    );
  });

  it('still shows the hint when a few pixels remain', () => {
    assert.equal(scrollEdgesOf({ scrollTop: 279, scrollHeight: 556, clientHeight: 273 }).bottom, true);
    assert.equal(scrollEdgesOf({ scrollTop: 3, scrollHeight: 556, clientHeight: 273 }).top, true);
  });
});
