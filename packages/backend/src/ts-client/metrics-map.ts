/**
 * Map scraped Prometheus samples → dashboard augmentation fields.
 *
 * Allow-list and VS scoping rules stay empty until a real beta13 fixture is
 * committed. Until then every map attempt fail-closes as `unscoped`.
 */

import type { PrometheusSample } from './metrics-parse.js';

export type MetricsUnavailableReason = 'timeout' | 'unreachable' | 'invalid' | 'unscoped';

export type MetricsProvenance =
  | { status: 'disabled' }
  | { status: 'current'; fetchedAt: string }
  | { status: 'unavailable'; fetchedAt?: string; reason: MetricsUnavailableReason };

/** Optional capacity/traffic fields metrics may eventually augment. Empty until fixture. */
export type MetricsAugmentation = {
  // Intentionally empty until derived from ts6-beta13-metrics.txt
};

/**
 * Metric names permitted for dashboard augmentation.
 * MUST remain empty until derived from a real beta13 dump — do not invent names.
 */
export const METRICS_ALLOWLIST: readonly string[] = Object.freeze([]);

export function isMetricsAllowlistReady(): boolean {
  return METRICS_ALLOWLIST.length > 0;
}

export type MapScopedMetricsResult =
  | { ok: true; augmentation: MetricsAugmentation; fetchedAt: string }
  | { ok: false; reason: MetricsUnavailableReason; fetchedAt: string };

/**
 * Fail-closed mapper: without a fixture-derived allow-list and SID scoping rule,
 * metrics cannot be proven scoped to the selected virtual server.
 */
export function mapScopedMetrics(
  _samples: PrometheusSample[],
  _sid: number,
  fetchedAt: string = new Date().toISOString(),
): MapScopedMetricsResult {
  if (!isMetricsAllowlistReady()) {
    return { ok: false, reason: 'unscoped', fetchedAt };
  }

  // Post-fixture: filter METRICS_ALLOWLIST samples with proven VS label === sid.
  return { ok: false, reason: 'unscoped', fetchedAt };
}
