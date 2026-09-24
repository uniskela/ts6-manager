/**
 * Fixture gate for #91 Slice 1 native metrics.
 *
 * Real beta13 Prometheus exposition must be committed before allow-listed
 * metric names or VS-scoping rules land in application code.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Canonical fixture path once a real scrape is committed. */
export const BETA13_METRICS_FIXTURE_NAME = 'ts6-beta13-metrics.txt';

export function beta13MetricsFixturePath(): string {
  return join(here, BETA13_METRICS_FIXTURE_NAME);
}

export function hasBeta13MetricsFixture(): boolean {
  return existsSync(beta13MetricsFixturePath());
}

export function missingBeta13MetricsFixtureMessage(): string {
  return (
    `Missing real beta13 metrics fixture at packages/backend/src/ts-client/__fixtures__/${BETA13_METRICS_FIXTURE_NAME}. ` +
    'Capture per packages/backend/src/ts-client/__fixtures__/README.md — do not invent Prometheus series.'
  );
}
