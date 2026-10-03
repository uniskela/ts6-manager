import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { iptvChannelKey, iptvConsolePath, parseIptvChannelId, parseIptvDeepLink } from '../../src/pages/bot-hub/iptv-deep-link';

/** Verify the pure deep-link parser independently of React and routing. */
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

describe('IPTV "Stream on…" links', () => {
  it('uses tvg-id as the key when present, else the channel name', () => {
    assert.equal(iptvChannelKey({ tvgId: 'news.us', name: 'News' }), 'news.us');
    assert.equal(iptvChannelKey({ tvgId: null, name: 'News' }), 'News');
    assert.equal(iptvChannelKey({ tvgId: '', name: 'News' }), 'News');
  });

  it('builds a console URL whose ?iptv= value round-trips through the parser', () => {
    const path = iptvConsolePath(7, 3, { id: 41, tvgId: null, name: 'Sport & News: 24/7' });
    const url = new URL(path, 'http://localhost');
    assert.equal(url.pathname, '/bot-hub/7');
    assert.deepEqual(parseIptvDeepLink(url.searchParams.get('iptv')), { playlistId: 3, channelKey: 'Sport & News: 24/7' });
    assert.equal(parseIptvChannelId(url.searchParams.get('iptvChannel')), 41);
  });

  it('accepts only a positive whole channel id', () => {
    assert.equal(parseIptvChannelId('12'), 12);
    for (const value of [null, '', '0', '-3', '1.5', '12a', '99999999999999999999']) {
      assert.equal(parseIptvChannelId(value), null, value ?? 'null');
    }
  });
});
