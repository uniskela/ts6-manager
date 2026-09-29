import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dashboardSourceHint, dashboardSourceLabel } from '../../src/lib/dashboard-source.ts';

describe('dashboardSourceLabel', () => {
  it('labels disabled metrics as WebQuery only', () => {
    assert.equal(
      dashboardSourceLabel({
        webquery: { status: 'current' },
        metrics: { status: 'disabled' },
      }),
      'WebQuery only',
    );
  });

  it('labels current metrics as combined', () => {
    assert.equal(
      dashboardSourceLabel({
        webquery: { status: 'current' },
        metrics: { status: 'current', fetchedAt: '2026-01-01T00:00:00.000Z' },
      }),
      'WebQuery + native metrics',
    );
  });

  it('surfaces unavailable reasons instead of looking disabled', () => {
    assert.equal(
      dashboardSourceLabel({
        webquery: { status: 'current' },
        metrics: { status: 'unavailable', reason: 'unreachable' },
      }),
      'WebQuery · metrics unreachable',
    );
    assert.equal(
      dashboardSourceLabel({
        webquery: { status: 'current' },
        metrics: { status: 'unavailable', reason: 'timeout' },
      }),
      'WebQuery · metrics timed out',
    );
  });
});

describe('dashboardSourceHint', () => {
  it('mentions localhost bind for unreachable', () => {
    const hint = dashboardSourceHint({
      webquery: { status: 'current' },
      metrics: { status: 'unavailable', reason: 'unreachable' },
    });
    assert.match(String(hint), /TSSERVER_METRICS_IP/);
    assert.match(String(hint), /localhost/i);
  });
});
