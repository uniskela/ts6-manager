import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IPTV_LOCAL_HOSTS_KEY, loadIptvLocalHosts, parseIptvLocalHostsUpdate } from './app-settings.js';
import { downloadVideoForStream } from '../voice/streaming/video-download.js';

function prismaWith(value: string | null) {
  return { appSetting: { findUnique: async ({ where }: any) => (where.key === IPTV_LOCAL_HOSTS_KEY && value != null ? { key: where.key, value } : null) } } as any;
}

describe('allowed local IPTV hosts setting', () => {
  it('normalizes, dedupes and validates updates', () => {
    const ok = parseIptvLocalHostsUpdate({ allowedLocalHosts: [' 192.168.1.20 ', 'Threadfin.LAN', '192.168.1.20', '10.0.0.0/24'] });
    assert.deepEqual(ok, { ok: true, value: ['192.168.1.20', 'threadfin.lan', '10.0.0.0/24'] });
    assert.deepEqual(parseIptvLocalHostsUpdate({ allowedLocalHosts: [] }), { ok: true, value: [] });

    const bad = parseIptvLocalHostsUpdate({ allowedLocalHosts: ['127.0.0.1', '192.168.1.20'] });
    assert.equal(bad.ok, false);
    assert.match((bad as any).error, /127\.0\.0\.1/);
    assert.equal(parseIptvLocalHostsUpdate({ allowedLocalHosts: 'x' }).ok, false);
    assert.equal(parseIptvLocalHostsUpdate({ allowedLocalHosts: Array.from({ length: 33 }, (_, i) => `10.0.0.${i + 1}`) }).ok, false);
  });

  it('loads only valid stored entries and treats a missing row as empty', async () => {
    assert.deepEqual(await loadIptvLocalHosts(prismaWith(null)), []);
    assert.deepEqual(await loadIptvLocalHosts(prismaWith('not json')), []);
    assert.deepEqual(await loadIptvLocalHosts(prismaWith(JSON.stringify(['192.168.1.20', '127.0.0.1', 5]))), ['192.168.1.20']);
  });

  it('lets an allow-listed LAN channel through to the stream and nothing else', async () => {
    const lan = 'http://192.168.1.20:34400/stream/42.ts';
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await downloadVideoForStream(lan, 720, 900, { localHosts: ['192.168.1.20'], fetchImpl }), { path: lan, durationSec: null });
    await assert.rejects(downloadVideoForStream(lan, 720, 900), /Video source blocked/);
    await assert.rejects(downloadVideoForStream('http://192.168.1.99/x.ts', 720, 900, { localHosts: ['192.168.1.20'] }), /Video source blocked/);
    await assert.rejects(downloadVideoForStream('http://127.0.0.1/x.ts', 720, 900, { localHosts: ['192.168.1.20'] }), /Video source blocked/);
  });
});
