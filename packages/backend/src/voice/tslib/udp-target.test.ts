import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveUdpTarget, type DnsLookupFn } from './udp-target.js';

describe('resolveUdpTarget', () => {
  it('returns an IPv4 literal without performing a DNS lookup', async () => {
    let lookups = 0;
    const lookup: DnsLookupFn = async () => {
      lookups++;
      return { address: '203.0.113.10' };
    };

    const result = await resolveUdpTarget('192.0.2.25', lookup);

    assert.equal(result, '192.0.2.25');
    assert.equal(lookups, 0);
  });

  it('resolves a hostname exactly once and returns the IPv4 target', async () => {
    let lookups = 0;
    const lookup: DnsLookupFn = async (hostname, options) => {
      lookups++;
      assert.equal(hostname, 'voice.example.test');
      assert.deepEqual(options, { family: 4 });
      return { address: '198.51.100.42' };
    };

    const result = await resolveUdpTarget('voice.example.test', lookup);

    assert.equal(result, '198.51.100.42');
    assert.equal(lookups, 1);
  });
});
