import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, mock } from 'node:test';
import { downloadVideoForStream } from '../voice/streaming/video-download.js';
import { SidecarClient } from '../voice/streaming/sidecar-client.js';
import { isPrivateIP, parseLocalHostAllowlist, validateUrl } from './url-validator.js';

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

describe('media destination policy', () => {
  const metadata = [
    '169.254.169.254', '100.100.100.200', 'fd00:ec2::254',
    'fd00:0ec2:0000:0000:0000:0000:0000:0254',
    '::ffff:100.100.100.200', '::ffff:6464:64c8',
  ];
  const { allowlist } = parseLocalHostAllowlist(['media.example', '100.64.0.0/10', 'fd00::/16']);
  const urlFor = (ip: string) => `http://${ip.includes(':') ? `[${ip}]` : ip}/live.m3u8`;

  it('never opens metadata literals, CIDRs or DNS names through an allowlist', async () => {
    for (const ip of metadata) {
      assert.deepEqual(parseLocalHostAllowlist([ip]).invalid, [ip]);
      assert.equal(allowlist.permits('media.example', ip), false, ip);
      assert.equal((await validateUrl(urlFor(ip), { localAllowlist: allowlist, skipDnsCheck: true })).valid, false, ip);
    }
  });

  it('never allows reserved addresses through alternate IPv6 spellings', async () => {
    const { allowlist } = parseLocalHostAllowlist(['media.example', 'fe00::/16', 'ff00::/16']);
    for (const ip of ['0.0.0.1', '127.0.0.1', '169.254.1.1', '224.0.0.1', '::', '0:0:0:0:0:0:0:1', 'febf::1', 'ff02::1', '::ffff:7f00:1', '::ffff:a9fe:101', '::ffff:e000:1']) {
      assert.equal(isPrivateIP(ip), true, ip);
      assert.equal(allowlist.permits('media.example', ip), false, ip);
      assert.equal((await validateUrl(urlFor(ip), { localAllowlist: allowlist, skipDnsCheck: true })).valid, false, ip);
    }
  });

  it('requires approval throughout shared-address space, including mapped IPv4', async () => {
    for (const ip of ['100.64.0.0', '100.64.0.1', '100.127.255.255', '::ffff:6440:1', '::ffff:100.127.255.255']) {
      assert.equal(isPrivateIP(ip), true, ip);
      assert.equal((await validateUrl(urlFor(ip), { skipDnsCheck: true })).valid, false, ip);
      assert.equal((await validateUrl(urlFor(ip), { skipDnsCheck: true, localAllowlist: allowlist })).valid, true, ip);
    }
    for (const ip of ['100.63.255.255', '100.128.0.0', '93.184.216.34', '2606:2800:220:1::']) {
      assert.equal(isPrivateIP(ip), false, ip);
      assert.equal((await validateUrl(urlFor(ip))).valid, true, ip);
    }
    assert.equal((await validateUrl('http://192.168.1.20/live.m3u8', { localAllowlist: parseLocalHostAllowlist(['192.168.1.20']).allowlist })).valid, true);
  });

  it('checks every DNS answer before applying LAN permissions', async () => {
    let answers: Array<{ address: string; family: number }> = [];
    const lookup = mock.method(dns, 'lookup', async (_hostname: string, opts: unknown) => {
      assert.deepEqual(opts, { all: true });
      return answers;
    });
    syncBuiltinESMExports();
    try {
      for (const ip of metadata) {
        for (const ips of [[ip], ['93.184.216.34', ip], [ip, '93.184.216.34']]) {
          answers = ips.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
          assert.equal((await validateUrl('http://media.example/live.m3u8', { localAllowlist: allowlist })).valid, false, ips.join(','));
        }
      }
      answers = [{ address: '100.64.0.10', family: 4 }, { address: '192.168.1.20', family: 4 }];
      assert.equal((await validateUrl('http://media.example/live.m3u8')).valid, false);
      assert.equal((await validateUrl('http://media.example/live.m3u8', { localAllowlist: allowlist })).valid, true);
      assert.equal((await validateUrl('http://other.example/live.m3u8', { localAllowlist: allowlist })).valid, false);
      answers = [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::', family: 6 }];
      assert.equal((await validateUrl('http://media.example/live.m3u8')).valid, true);
      answers = [];
      assert.equal((await validateUrl('http://media.example/live.m3u8')).valid, false);
    } finally {
      lookup.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('rejects unsafe sources before authenticated forwarding and preserves approved playback', async (t) => {
    const received: Array<{ source: string; allowedHosts: string[] }> = [];
    const server = createServer(async (req, res) => {
      assert.equal(req.url, '/source');
      assert.equal(req.headers.authorization, 'Bearer test-only');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('Content-Type', 'application/json');
      res.end('{"status":"ok"}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new SidecarClient(`http://127.0.0.1:${address.port}`, 'test-only');
    const forward = async (url: string, localHosts: string[] = []) => {
      const source = await downloadVideoForStream(url, 720, 1800, { localHosts });
      await client.setSource(source.path, { mode: 'live', allowedHosts: localHosts });
    };
    for (const ip of metadata) {
      await assert.rejects(forward(urlFor(ip), ['100.64.0.0/10', 'fd00::/16']), /Video source blocked/);
    }
    await assert.rejects(forward(urlFor('100.64.0.10')), /Video source blocked/);
    assert.equal(received.length, 0);
    await forward(urlFor('100.64.0.10'), ['100.64.0.0/10']);
    await forward(urlFor('192.168.1.20'), ['192.168.1.20']);
    await forward(urlFor('93.184.216.34'));
    assert.deepEqual(received.map(r => [r.source, r.allowedHosts]), [
      [urlFor('100.64.0.10'), ['100.64.0.0/10']],
      [urlFor('192.168.1.20'), ['192.168.1.20']],
      [urlFor('93.184.216.34'), []],
    ]);
  });
});
