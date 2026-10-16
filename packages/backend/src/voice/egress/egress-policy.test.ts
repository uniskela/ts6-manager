import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { embeddedIPv4, ipv6Bytes, MEDIA_EGRESS_PORTS, mediaEgressRefusal } from './egress-policy.js';

describe('media egress address policy', () => {
  it('allows public addresses', () => {
    for (const address of ['93.184.215.14', '142.250.72.110', '2606:4700::6810:84e5', '2a00:1450:4001:82b::200e']) {
      assert.equal(mediaEgressRefusal(address), null, address);
    }
  });

  it('refuses private and shared address space with no exception', () => {
    for (const address of ['10.1.2.3', '172.16.0.9', '192.168.1.20', '100.64.0.1', 'fd12:3456::1']) {
      assert.equal(mediaEgressRefusal(address), 'private', address);
    }
  });

  it('refuses loopback, link-local, metadata, multicast and reserved addresses', () => {
    for (const address of [
      '127.0.0.1', '0.0.0.0', '169.254.169.254', '224.0.0.1', '255.255.255.255',
      '240.0.0.1', '198.18.0.1', '192.0.0.8', '100.100.100.200',
      '::1', '::', 'fe80::1', 'ff02::1', 'fd00:ec2::254',
    ]) {
      assert.equal(mediaEgressRefusal(address), 'reserved', address);
    }
  });

  it('judges IPv6 forms that carry an IPv4 address by that address', () => {
    assert.equal(embeddedIPv4('::ffff:10.0.0.1'), '10.0.0.1');
    assert.equal(embeddedIPv4('::ffff:7f00:1'), '127.0.0.1');
    assert.equal(embeddedIPv4('64:ff9b::a00:1'), '10.0.0.1');
    assert.equal(embeddedIPv4('64:ff9b:1::a9fe:a9fe'), '169.254.169.254');
    assert.equal(embeddedIPv4('2002:c0a8:0101::1'), '192.168.1.1');
    assert.equal(embeddedIPv4('2606:4700::1'), null);
    assert.equal(mediaEgressRefusal('::ffff:127.0.0.1'), 'reserved');
    assert.equal(mediaEgressRefusal('64:ff9b::c0a8:1'), 'private');
    assert.equal(mediaEgressRefusal('2002:0a00:0001::1'), 'private');
    // NAT64 of a public address stays usable on IPv6-only networks.
    assert.equal(mediaEgressRefusal('64:ff9b::5db8:d70e'), null);
    assert.equal(mediaEgressRefusal('2001:0:4136:e378::1'), 'reserved', 'Teredo');
  });

  it('expands IPv6 spellings to the same bytes', () => {
    assert.deepEqual(ipv6Bytes('::1'), [...new Array(15).fill(0), 1]);
    assert.deepEqual(ipv6Bytes('0:0:0:0:0:0:0:1'), ipv6Bytes('::1'));
    assert.deepEqual(ipv6Bytes('::ffff:1.2.3.4')?.slice(10), [0xff, 0xff, 1, 2, 3, 4]);
    assert.equal(ipv6Bytes('1.2.3.4'), null);
  });

  it('refuses things that are not addresses', () => {
    assert.equal(mediaEgressRefusal('example.com'), 'not-an-address');
  });

  it('allows only ports 80 and 443', () => {
    assert.deepEqual([...MEDIA_EGRESS_PORTS].sort((a, b) => a - b), [80, 443]);
  });
});
