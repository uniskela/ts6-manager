import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  beta13MetricsFixturePath,
  hasBeta13MetricsFixture,
  missingBeta13MetricsFixtureMessage,
} from './metrics-fixture.js';
import { isMetricsAllowlistReady, mapScopedMetrics, METRICS_ALLOWLIST } from './metrics-map.js';
import { parsePrometheusText } from './metrics-parse.js';

describe('metrics fixture gate', () => {
  it('keeps allow-list empty until a real fixture is committed', () => {
    assert.equal(METRICS_ALLOWLIST.length, 0);
    assert.equal(isMetricsAllowlistReady(), false);
  });

  it('fail-closes mapping as unscoped without fixture-derived rules', () => {
    const result = mapScopedMetrics(
      [{ name: 'invented_metric_should_not_be_used', labels: { sid: '1' }, value: 1 }],
      1,
      '2026-09-24T00:00:00.000Z',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unscoped');
  });

  it('skips fixture-driven parser assertions when the real dump is missing', (t) => {
    if (!hasBeta13MetricsFixture()) {
      t.skip(missingBeta13MetricsFixtureMessage());
      return;
    }

    const body = readFileSync(beta13MetricsFixturePath(), 'utf8');
    const { samples } = parsePrometheusText(body);
    assert.ok(samples.length > 0, 'fixture must contain at least one sample');
    // Post-fixture: assert exact metric names / VS labels from the real dump only.
  });
});

describe('parsePrometheusText skeleton', () => {
  it('parses generic sample lines without claiming TeamSpeak names', () => {
    // Synthetic lines only exercise the parser skeleton — not TeamSpeak beta13 names.
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
