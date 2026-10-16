import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import { addressRateKey, clientRateKey } from './client-address.js';

describe('client address rate keys', () => {
  it('keys IPv4 per address and unmaps IPv4-mapped IPv6 first', () => {
    assert.equal(addressRateKey('192.0.2.1'), 'ipv4:192.0.2.1');
    assert.equal(addressRateKey('::ffff:192.0.2.1'), addressRateKey('192.0.2.1'));
    assert.equal(addressRateKey('::FFFF:c000:201'), addressRateKey('192.0.2.1'));
    assert.equal(addressRateKey('0:0:0:0:0:ffff:192.0.2.1'), addressRateKey('192.0.2.1'));
    assert.notEqual(addressRateKey('::ffff:192.0.2.1'), addressRateKey('::ffff:192.0.2.2'));
    assert.notEqual(addressRateKey('192.0.2.1'), addressRateKey('192.0.2.2'));
  });

  it('keys IPv6 per /64, whatever the spelling', () => {
    const key = addressRateKey('2001:db8:1:2::1');
    assert.equal(key, 'ipv6:20010db800010002/64');
    for (const same of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0DB8:0001:0002:0000:0000:0000:0009', '2001:db8:1:2:0:0:a:b', '2001:db8:1:2::c0a8:1', '2001:db8:1:2::1%eth0']) {
      assert.equal(addressRateKey(same), key, same);
    }
    for (const other of ['2001:db8:1:3::1', '2001:db8::1', '2001:db9:1:2::1']) {
      assert.notEqual(addressRateKey(other), key, other);
    }
    assert.equal(addressRateKey('::1'), 'ipv6:0000000000000000/64');
    assert.equal(addressRateKey('fe80::'), addressRateKey('fe80:0:0:0:1:2:3:4'));
  });

  it('rejects anything that is not an IP address', () => {
    for (const value of [undefined, '', 'unknown', 'not-an-ip', '192.0.2.1, 198.51.100.1', '2001:db8:1:2::1::2', '192.0.2.256', '::ffff:192.0.2.256']) {
      assert.equal(addressRateKey(value), null, String(value));
    }
  });

  it('falls back to the connecting peer when req.ip is not an IP address', () => {
    const req = (ip: string | undefined, remoteAddress: string | undefined) => ({ ip, socket: { remoteAddress } }) as unknown as Request;
    assert.equal(clientRateKey(req('not-an-ip', '::ffff:192.0.2.9')), 'ipv4:192.0.2.9');
    assert.equal(clientRateKey(req(undefined, '2001:db8::5')), addressRateKey('2001:db8::1'));
    assert.equal(clientRateKey(req('198.51.100.7', '192.0.2.9')), 'ipv4:198.51.100.7');
    assert.equal(clientRateKey(req('junk', 'junk')), 'unknown');
  });
});
