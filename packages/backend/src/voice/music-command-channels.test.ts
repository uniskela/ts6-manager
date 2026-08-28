import { describe, expect, it } from 'vitest';
import {
  channelListenerKey,
  parseCommandChannelIds,
  serializeCommandChannelIds,
} from './music-command-channels.js';

describe('music-command-channels', () => {
  it('parses JSON channel id arrays', () => {
    expect(parseCommandChannelIds('["12","45"]')).toEqual(['12', '45']);
    expect(parseCommandChannelIds(null)).toEqual([]);
  });

  it('serializes unique numeric ids', () => {
    expect(serializeCommandChannelIds(['12', '12', 'bad', '3'])).toBe('["12","3"]');
  });

  it('builds listener keys', () => {
    expect(channelListenerKey(1, 1, 42)).toBe('1:1:42');
  });
});
