import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RADIO_LOCAL_HOSTS_KEY,
  loadRadioLocalHosts,
  parseRadioLocalHostsUpdate,
  radioLocalAllowlist,
} from './app-settings.js';

function prismaWith(value: string | null) {
  return { appSetting: { findUnique: async ({ where }: any) => (where.key === RADIO_LOCAL_HOSTS_KEY && value != null ? { key: where.key, value } : null) } } as any;
}

describe('allowed local radio hosts setting', () => {
  it('normalizes, dedupes and validates updates', () => {
    const ok = parseRadioLocalHostsUpdate({ allowedLocalHosts: [' 192.168.1.20 ', 'Radio.LAN', '192.168.1.20', '10.0.0.0/24'] });
    assert.deepEqual(ok, { ok: true, value: ['192.168.1.20', 'radio.lan', '10.0.0.0/24'] });
    assert.deepEqual(parseRadioLocalHostsUpdate({ allowedLocalHosts: [] }), { ok: true, value: [] });

    const bad = parseRadioLocalHostsUpdate({ allowedLocalHosts: ['127.0.0.1', '192.168.1.20'] });
    assert.equal(bad.ok, false);
    assert.match((bad as any).error, /127\.0\.0\.1/);
    assert.equal(parseRadioLocalHostsUpdate({ allowedLocalHosts: 'x' }).ok, false);
    assert.equal(parseRadioLocalHostsUpdate({ allowedLocalHosts: Array.from({ length: 33 }, (_, i) => `10.0.0.${i + 1}`) }).ok, false);
  });

  it('loads only valid stored entries and treats a missing row as empty', async () => {
    assert.deepEqual(await loadRadioLocalHosts(prismaWith(null)), []);
    assert.deepEqual(await loadRadioLocalHosts(prismaWith('not json')), []);
    assert.deepEqual(await loadRadioLocalHosts(prismaWith(JSON.stringify(['192.168.1.20', '127.0.0.1', 5]))), ['192.168.1.20']);
  });

  it('builds an allowlist only when hosts are stored', async () => {
    assert.equal(await radioLocalAllowlist(prismaWith(null)), undefined);
    assert.equal(await radioLocalAllowlist(prismaWith(JSON.stringify([]))), undefined);
    const allowlist = await radioLocalAllowlist(prismaWith(JSON.stringify(['192.168.1.20'])));
    assert.ok(allowlist);
    assert.equal(allowlist!.permits('192.168.1.20', '192.168.1.20'), true);
    assert.equal(allowlist!.permits('192.168.1.99', '192.168.1.99'), false);
  });
});
