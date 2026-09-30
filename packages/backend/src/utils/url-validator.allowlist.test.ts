import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseLocalHostAllowlist, resolveRedirectsSafely, validateUrl } from './url-validator.js';

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

describe('media redirect resolution', () => {
  /** Fake server: maps a URL to a redirect target (or null for a 200). */
  function server(routes: Record<string, string | null>) {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      const to = routes[url];
      return to ? new Response(null, { status: 302, headers: { location: to } }) : new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it('returns the final URL after checking every hop', async () => {
    const { fetchImpl, seen } = server({
      'http://93.184.216.34/live': 'http://93.184.216.35/edge/live.m3u8',
    });
    assert.equal(await resolveRedirectsSafely('http://93.184.216.34/live', { fetchImpl }), 'http://93.184.216.35/edge/live.m3u8');
    assert.deepEqual(seen, ['http://93.184.216.34/live', 'http://93.184.216.35/edge/live.m3u8']);
  });

  it('refuses a redirect into a blocked address, allow-listed LAN or not', async () => {
    const { fetchImpl } = server({
      'http://93.184.216.34/a': 'http://169.254.169.254/latest/meta-data',
      'http://93.184.216.34/b': 'http://192.168.1.99/admin',
      'http://192.168.1.20/c': 'http://127.0.0.1:3001/api',
    });
    const { allowlist } = parseLocalHostAllowlist(['192.168.1.20']);
    await assert.rejects(resolveRedirectsSafely('http://93.184.216.34/a', { fetchImpl, localAllowlist: allowlist }), /redirect blocked/);
    await assert.rejects(resolveRedirectsSafely('http://93.184.216.34/b', { fetchImpl, localAllowlist: allowlist }), /redirect blocked/);
    await assert.rejects(resolveRedirectsSafely('http://192.168.1.20/c', { fetchImpl, localAllowlist: allowlist }), /redirect blocked/);
  });

  it('follows a redirect to an allow-listed LAN host', async () => {
    const { fetchImpl } = server({ 'http://192.168.1.20/c': 'http://192.168.1.20:34400/stream/1.ts' });
    const { allowlist } = parseLocalHostAllowlist(['192.168.1.20']);
    assert.equal(await resolveRedirectsSafely('http://192.168.1.20/c', { fetchImpl, localAllowlist: allowlist }), 'http://192.168.1.20:34400/stream/1.ts');
  });

  it('gives up on redirect loops', async () => {
    const { fetchImpl } = server({ 'http://93.184.216.34/x': 'http://93.184.216.34/x' });
    await assert.rejects(resolveRedirectsSafely('http://93.184.216.34/x', { fetchImpl, maxRedirects: 3 }), /more than 3 times/);
  });
});
