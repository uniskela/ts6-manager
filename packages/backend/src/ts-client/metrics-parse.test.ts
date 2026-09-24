import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  beta13MetricsFixturePath,
  hasBeta13MetricsFixture,
  missingBeta13MetricsFixtureMessage,
} from './metrics-fixture.js';
import {
  applyMetricsAugmentation,
  isMetricsAllowlistReady,
  mapScopedMetrics,
  METRICS_ALLOWLIST,
  resolveVirtualServerUniqueId,
  VS_INFO_METRIC,
  VS_UNIQUE_ID_LABEL,
} from './metrics-map.js';
import { parsePrometheusText } from './metrics-parse.js';

describe('metrics allow-list (beta13 fixture)', () => {
  it('is populated from the real dump only', () => {
    assert.equal(isMetricsAllowlistReady(), true);
    assert.ok(METRICS_ALLOWLIST.includes(VS_INFO_METRIC));
    assert.ok(METRICS_ALLOWLIST.includes('teamspeak_clients_online'));
    assert.ok(METRICS_ALLOWLIST.includes('teamspeak_connection_bandwidth_bytes_per_second'));
    // Never invent voice-only names that were not confirmed in the capture.
    assert.ok(!METRICS_ALLOWLIST.some((name) => name.includes('voice_packet')));
  });

  it('fail-closes as unscoped when SID cannot be resolved', () => {
    const result = mapScopedMetrics(
      [{ name: 'teamspeak_clients_online', labels: { [VS_UNIQUE_ID_LABEL]: 'x' }, value: 1 }],
      1,
      '2026-09-24T00:00:00.000Z',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unscoped');
  });

  it('ignores non-allow-listed series even when SID-scoped labels exist', () => {
    const samples = [
      {
        name: VS_INFO_METRIC,
        labels: {
          [VS_UNIQUE_ID_LABEL]: 'uid-1',
          virtualserver_id: '1',
          name: 'Test',
        },
        value: 1,
      },
      {
        name: 'teamspeak_invented_should_not_map',
        labels: { [VS_UNIQUE_ID_LABEL]: 'uid-1' },
        value: 99,
      },
    ];
    const result = mapScopedMetrics(samples, 1, '2026-09-24T00:00:00.000Z');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.augmentation, {});
    }
  });
});

describe('beta13 fixture-driven metrics', () => {
  it('requires the real exposition dump', () => {
    assert.equal(
      hasBeta13MetricsFixture(),
      true,
      missingBeta13MetricsFixtureMessage(),
    );
  });

  it('parses key series and VS scoping labels from the dump', () => {
    const body = readFileSync(beta13MetricsFixturePath(), 'utf8');
    assert.equal(Buffer.byteLength(body, 'utf8'), 20856);

    const { samples } = parsePrometheusText(body);
    assert.ok(samples.length > 50);

    const info = samples.find((s) => s.name === VS_INFO_METRIC);
    assert.ok(info);
    assert.equal(info!.labels.virtualserver_id, '1');
    assert.ok(info!.labels[VS_UNIQUE_ID_LABEL]);

    const uid = resolveVirtualServerUniqueId(samples, 1);
    assert.equal(uid, info!.labels[VS_UNIQUE_ID_LABEL]);
    assert.equal(resolveVirtualServerUniqueId(samples, 99), null);

    const clients = samples.find(
      (s) => s.name === 'teamspeak_clients_online' && s.labels[VS_UNIQUE_ID_LABEL] === uid,
    );
    const query = samples.find(
      (s) => s.name === 'teamspeak_query_clients_online' && s.labels[VS_UNIQUE_ID_LABEL] === uid,
    );
    const maxClients = samples.find(
      (s) => s.name === 'teamspeak_max_clients' && s.labels[VS_UNIQUE_ID_LABEL] === uid,
    );
    const bwOut = samples.find(
      (s) =>
        s.name === 'teamspeak_connection_bandwidth_bytes_per_second'
        && s.labels[VS_UNIQUE_ID_LABEL] === uid
        && s.labels.direction === 'sent',
    );
    assert.ok(clients);
    assert.ok(query);
    assert.ok(maxClients);
    assert.ok(bwOut);
    assert.equal(clients!.value, 3);
    assert.equal(query!.value, 2);
    assert.equal(maxClients!.value, 32);
    assert.equal(bwOut!.value, 513);
  });

  it('maps scoped dashboard fields for SID 1 and fail-closes for unknown SID', () => {
    const body = readFileSync(beta13MetricsFixturePath(), 'utf8');
    const { samples } = parsePrometheusText(body);

    const mapped = mapScopedMetrics(samples, 1, '2026-09-24T00:00:00.000Z');
    assert.equal(mapped.ok, true);
    if (!mapped.ok) return;

    assert.equal(mapped.augmentation.onlineUsers, 1); // 3 clients - 2 query
    assert.equal(mapped.augmentation.maxClients, 32);
    assert.equal(mapped.augmentation.channelCount, 14);
    assert.equal(mapped.augmentation.uptime, 112); // 1790221502 - 1790221390
    assert.equal(mapped.augmentation.bandwidth?.incoming, 211);
    assert.equal(mapped.augmentation.bandwidth?.outgoing, 513);
    assert.equal(mapped.augmentation.packetloss, 0);
    assert.equal(mapped.augmentation.ping, 0);

    const missingSid = mapScopedMetrics(samples, 2, '2026-09-24T00:00:00.000Z');
    assert.equal(missingSid.ok, false);
    if (!missingSid.ok) assert.equal(missingSid.reason, 'unscoped');
  });

  it('applies augmentation without inventing missing fields', () => {
    const base = {
      serverName: 'WebQuery Name',
      platform: 'Linux',
      version: 'wq',
      onlineUsers: 9,
      maxClients: 9,
      uptime: 9,
      channelCount: 9,
      bandwidth: { incoming: 1, outgoing: 2 },
      packetloss: 0.5,
      ping: 12,
    };
    const merged = applyMetricsAugmentation(base, {
      onlineUsers: 1,
      bandwidth: { outgoing: 513 },
    });
    assert.equal(merged.serverName, 'WebQuery Name');
    assert.equal(merged.onlineUsers, 1);
    assert.equal(merged.maxClients, 9);
    assert.equal(merged.bandwidth.incoming, 1);
    assert.equal(merged.bandwidth.outgoing, 513);
    assert.equal(merged.packetloss, 0.5);
  });
});

describe('parsePrometheusText skeleton', () => {
  it('parses generic sample lines without claiming TeamSpeak names', () => {
    const body = [
      '# HELP example_metric A generic example (not TeamSpeak)',
      '# TYPE example_metric gauge',
      'example_metric{job="test"} 3.5',
      'example_counter 10',
    ].join('\n');

    const { samples } = parsePrometheusText(body);
    assert.equal(samples.length, 2);
    assert.equal(samples[0]?.name, 'example_metric');
    assert.equal(samples[0]?.labels.job, 'test');
    assert.equal(samples[0]?.value, 3.5);
    assert.equal(samples[1]?.name, 'example_counter');
    assert.equal(samples[1]?.value, 10);
  });

  it('rejects empty body', () => {
    assert.throws(() => parsePrometheusText(''), /Empty Prometheus/);
  });
});
