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
  it('uses neutral wording when provenance is missing', () => {
    const hint = dashboardSourceHint(undefined);
    assert.equal(hint, 'Dashboard uses authenticated WebQuery.');
    assert.doesNotMatch(String(hint), /scrape is off/i);
  });

  it('uses neutral wording when metrics provenance is absent', () => {
    const hint = dashboardSourceHint({ webquery: { status: 'current' } });
    assert.equal(hint, 'Dashboard uses authenticated WebQuery.');
    assert.doesNotMatch(String(hint), /scrape is off/i);
  });

  it('reserves scrape-off wording for explicit disabled metrics', () => {
    const hint = dashboardSourceHint({
      webquery: { status: 'current' },
      metrics: { status: 'disabled' },
    });
    assert.match(String(hint), /scrape is off/i);
  });

  it('mentions localhost bind for unreachable', () => {
    const hint = dashboardSourceHint({
      webquery: { status: 'current' },
      metrics: { status: 'unavailable', reason: 'unreachable' },
    });
    assert.match(String(hint), /TSSERVER_METRICS_IP/);
    assert.match(String(hint), /localhost/i);
  });
});
