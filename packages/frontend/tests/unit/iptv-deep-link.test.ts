import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseIptvDeepLink } from '../../src/pages/bot-hub/iptv-deep-link';

describe('IPTV deep links', () => {
  it('splits playlist id and channel key at the first colon only', () => {
    assert.deepEqual(parseIptvDeepLink('42:news:west'), { playlistId: 42, channelKey: 'news:west' });
  });

  it('rejects missing, malformed, and non-positive playlist ids', () => {
    for (const value of [null, '', 'x:key', '0:key', '-1:key', '1']) {
      assert.equal(parseIptvDeepLink(value), null, value ?? 'null');
    }
  });
});
