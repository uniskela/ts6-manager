import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  channelListenerKey,
  parseCommandChannelIds,
  serializeCommandChannelIds,
} from './music-command-channels.js';

describe('music-command-channels', () => {
  it('parses JSON channel id arrays', () => {
    assert.deepEqual(parseCommandChannelIds('["12","45"]'), ['12', '45']);
    assert.deepEqual(parseCommandChannelIds(null), []);
  });

  it('serializes unique numeric ids', () => {
    assert.equal(serializeCommandChannelIds(['12', '12', 'bad', '3']), '["12","3"]');
  });

  it('builds listener keys', () => {
    assert.equal(channelListenerKey(1, 1, 42), '1:1:42');
  });
});
