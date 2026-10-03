import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseM3U } from './m3u-parser.js';

describe('M3U country and language metadata', () => {
  it('stores both attributes without treating their commas as the name delimiter', () => {
    const [channel] = parseM3U('#EXTM3U\n#EXTINF:-1 tvg-country="US;CA" tvg-language="en,fr" group-title="News",Morning News\nhttps://example.test/news\n');
    assert.equal(channel.name, 'Morning News');
    assert.equal(channel.tvgCountry, 'US;CA');
    assert.equal(channel.tvgLanguage, 'en,fr');
  });

  it('keeps metadata optional when attributes are missing or empty', () => {
    const channels = parseM3U('#EXTM3U\n#EXTINF:-1,Plain\nhttps://example.test/plain\n#EXTINF:-1 tvg-country="" tvg-language="",Empty\nhttps://example.test/empty\n');
    assert.deepEqual(channels.map((channel) => [channel.tvgCountry, channel.tvgLanguage]), [[undefined, undefined], [undefined, undefined]]);
  });

  it('parses case insensitive attribute names and commas in the display name', () => {
    const [channel] = parseM3U('#EXTINF:-1 TVG-COUNTRY="ca,US" TVG-LANGUAGE="fr;en",News, Live\nhttps://example.test/live\n');
    assert.equal(channel.name, 'News, Live');
    assert.equal(channel.tvgCountry, 'ca,US');
    assert.equal(channel.tvgLanguage, 'fr;en');
  });
});
