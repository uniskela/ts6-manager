import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseLocalHostAllowlist, validateUrl } from './url-validator.js';

describe('local IPTV host allowlist', () => {
  it('accepts IPs, CIDRs and hostnames and rejects unsafe or malformed entries', () => {
    const { allowlist, invalid } = parseLocalHostAllowlist([
      '192.168.1.20', '10.0.0.0/24', 'threadfin.lan', 'fd12:3456::1',
      '127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', 'localhost',
      '10.0.0.0/4', 'not a host', '192.168.1.0/33', '',
    ]);
    assert.equal(allowlist.isEmpty, false);
    assert.deepEqual(invalid, ['127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', 'localhost', '10.0.0.0/4', 'not a host', '192.168.1.0/33', '']);
    assert.equal(allowlist.permits('192.168.1.20', '192.168.1.20'), true);
    assert.equal(allowlist.permits('192.168.1.21', '192.168.1.21'), false);
    assert.equal(allowlist.permits('10.0.0.7', '10.0.0.7'), true);
    assert.equal(allowlist.permits('10.0.1.7', '10.0.1.7'), false);
    assert.equal(allowlist.permits('threadfin.lan', '192.168.50.4'), true, 'a listed hostname may resolve to any LAN address');
    assert.equal(allowlist.permits('threadfin.lan', '127.0.0.1'), false, 'but never to loopback');
    assert.equal(allowlist.permits('[fd12:3456::1]', 'fd12:3456::1'), true);
  });

  it('opens only listed LAN sources and leaves everything else blocked', async () => {
    const { allowlist } = parseLocalHostAllowlist(['192.168.1.20']);
    const opts = { skipDnsCheck: true, localAllowlist: allowlist };
    assert.equal((await validateUrl('http://192.168.1.20:34400/playlist.m3u', opts)).valid, true);
    assert.equal((await validateUrl('http://192.168.1.99/playlist.m3u', opts)).valid, false);
    assert.equal((await validateUrl('http://127.0.0.1/x', opts)).valid, false);
    assert.equal((await validateUrl('http://169.254.169.254/latest', opts)).valid, false);
    assert.equal((await validateUrl('http://localhost/x', opts)).valid, false);
    // Without an allowlist nothing changes.
    assert.equal((await validateUrl('http://192.168.1.20/playlist.m3u', { skipDnsCheck: true })).valid, false);
  });
});
