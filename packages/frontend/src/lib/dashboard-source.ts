import type { DashboardDataSource } from '@ts6/common';

/** Operator-facing dashboard provenance badge label. */
export function dashboardSourceLabel(dataSource: DashboardDataSource | undefined): string {
  const metrics = dataSource?.metrics;
  if (!metrics || metrics.status === 'disabled') return 'WebQuery only';
  if (metrics.status === 'current') return 'WebQuery + native metrics';
  switch (metrics.reason) {
    case 'unreachable':
      return 'WebQuery · metrics unreachable';
    case 'timeout':
      return 'WebQuery · metrics timed out';
    case 'invalid':
      return 'WebQuery · metrics invalid';
    case 'unscoped':
      return 'WebQuery · metrics unscoped';
    default:
      return 'WebQuery · metrics unavailable';
  }
}

/** Longer hint for the provenance badge title attribute. */
export function dashboardSourceHint(dataSource: DashboardDataSource | undefined): string | undefined {
  const metrics = dataSource?.metrics;
  if (!metrics || metrics.status === 'disabled') {
    return 'Dashboard uses authenticated WebQuery only. Native metrics scrape is off for this connection.';
  }
  if (metrics.status === 'current') {
    return 'WebQuery identity plus scoped TeamSpeak native Prometheus metrics.';
  }
  switch (metrics.reason) {
    case 'unreachable':
      return 'Metrics scrape could not connect. Ensure TSSERVER_METRICS_ENABLED=1 and TSSERVER_METRICS_IP is reachable from the manager (not localhost-only when the manager is remote), and that metricsHost/port match.';
    case 'timeout':
      return 'Metrics scrape did not finish before the dashboard returned. A later refresh may pick up a cached scrape if the listener is reachable.';
    case 'invalid':
      return 'Metrics response was rejected (HTTP status, content-type, or empty/invalid samples).';
    case 'unscoped':
      return 'Metrics samples could not be proven to match this virtual server identity; WebQuery values were kept.';
    default:
      return 'Native metrics are enabled but unavailable; dashboard kept WebQuery values.';
  }
}
