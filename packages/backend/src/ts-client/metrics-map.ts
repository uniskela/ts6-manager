/**
 * Map scraped Prometheus samples → dashboard augmentation fields.
 *
 * Allow-list and VS scoping derived from real beta13 fixture
 * `ts6-beta13-metrics.txt` only. Unknown metric names are ignored.
 * Without a proven VS identifier for the selected SID, fail closed as `unscoped`.
 */

import type { PrometheusSample } from './metrics-parse.js';

export type MetricsUnavailableReason = 'timeout' | 'unreachable' | 'invalid' | 'unscoped';

export type MetricsProvenance =
  | { status: 'disabled' }
  | { status: 'current'; fetchedAt: string }
  | { status: 'unavailable'; fetchedAt?: string; reason: MetricsUnavailableReason };

/**
 * Optional dashboard fields metrics may augment.
 * Missing series are omitted — never filled with misleading zeroes.
 */
export type MetricsAugmentation = {
  onlineUsers?: number;
  maxClients?: number;
  uptime?: number;
  channelCount?: number;
  bandwidth?: {
    incoming?: number;
    outgoing?: number;
  };
  packetloss?: number;
  ping?: number;
};

/** Label used on per-VS series in beta13 (not numeric SID alone). */
export const VS_UNIQUE_ID_LABEL = 'virtualserver_unique_identifier';

/** Identity series that also carries numeric `virtualserver_id` for SID resolution. */
export const VS_INFO_METRIC = 'teamspeak_virtualserver_info';

/**
 * Metric names permitted for dashboard augmentation / SID resolution.
 * Derived from packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.txt.
 */
export const METRICS_ALLOWLIST: readonly string[] = Object.freeze([
  'teamspeak_virtualserver_info',
  'teamspeak_clients_online',
  'teamspeak_query_clients_online',
  'teamspeak_max_clients',
  'teamspeak_channels_online',
  'teamspeak_virtualserver_start_timestamp_seconds',
  'teamspeak_host_timestamp_seconds',
  'teamspeak_connection_bandwidth_bytes_per_second',
  'teamspeak_packetloss_ratio',
  'teamspeak_ping_seconds',
]);

export function isMetricsAllowlistReady(): boolean {
  return METRICS_ALLOWLIST.length > 0;
}

const ALLOWLIST_SET = new Set<string>(METRICS_ALLOWLIST);

export type MapScopedMetricsResult =
  | { ok: true; augmentation: MetricsAugmentation; fetchedAt: string }
  | { ok: false; reason: MetricsUnavailableReason; fetchedAt: string };

function finiteNumber(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function findSample(
  samples: PrometheusSample[],
  name: string,
  match: (labels: Record<string, string>) => boolean = () => true,
): PrometheusSample | undefined {
  return samples.find((s) => s.name === name && match(s.labels));
}

/**
 * Resolve selected Query SID → virtualserver_unique_identifier via
 * teamspeak_virtualserver_info{virtualserver_id="<sid>"}.
 */
export function resolveVirtualServerUniqueId(
  samples: PrometheusSample[],
  sid: number,
): string | null {
  const info = findSample(
    samples,
    VS_INFO_METRIC,
    (labels) => labels.virtualserver_id === String(sid),
  );
  const uid = info?.labels[VS_UNIQUE_ID_LABEL];
  return uid && uid.length > 0 ? uid : null;
}

function scoped(
  samples: PrometheusSample[],
  name: string,
  uid: string,
  extra: (labels: Record<string, string>) => boolean = () => true,
): PrometheusSample | undefined {
  return findSample(
    samples,
    name,
    (labels) => labels[VS_UNIQUE_ID_LABEL] === uid && extra(labels),
  );
}

/**
 * Map allow-listed, VS-scoped samples for the selected SID into dashboard fields.
 * Fail-closed when SID cannot be proven via teamspeak_virtualserver_info.
 */
export function mapScopedMetrics(
  samples: PrometheusSample[],
  sid: number,
  fetchedAt: string = new Date().toISOString(),
): MapScopedMetricsResult {
  if (!isMetricsAllowlistReady()) {
    return { ok: false, reason: 'unscoped', fetchedAt };
  }

  const allowlisted = samples.filter((s) => ALLOWLIST_SET.has(s.name));
  const uid = resolveVirtualServerUniqueId(allowlisted, sid);
  if (!uid) {
    return { ok: false, reason: 'unscoped', fetchedAt };
  }

  const augmentation: MetricsAugmentation = {};

  const clientsOnline = scoped(allowlisted, 'teamspeak_clients_online', uid);
  const queryOnline = scoped(allowlisted, 'teamspeak_query_clients_online', uid);
  // Fixture: instance HELP defines non-query clients; VS clients_online includes query.
  if (clientsOnline && queryOnline) {
    const nonQuery = clientsOnline.value - queryOnline.value;
    const value = finiteNumber(nonQuery);
    if (value !== undefined && value >= 0) augmentation.onlineUsers = value;
  } else if (clientsOnline) {
    const value = finiteNumber(clientsOnline.value);
    if (value !== undefined) augmentation.onlineUsers = value;
  }

  const maxClients = scoped(allowlisted, 'teamspeak_max_clients', uid);
  if (maxClients) {
    const value = finiteNumber(maxClients.value);
    if (value !== undefined) augmentation.maxClients = value;
  }

  const channels = scoped(allowlisted, 'teamspeak_channels_online', uid);
  if (channels) {
    const value = finiteNumber(channels.value);
    if (value !== undefined) augmentation.channelCount = value;
  }

  const startTs = scoped(allowlisted, 'teamspeak_virtualserver_start_timestamp_seconds', uid);
  const hostTs = findSample(allowlisted, 'teamspeak_host_timestamp_seconds');
  if (startTs && hostTs) {
    const uptime = finiteNumber(hostTs.value - startTs.value);
    if (uptime !== undefined && uptime >= 0) augmentation.uptime = uptime;
  }

  const bwIn = scoped(
    allowlisted,
    'teamspeak_connection_bandwidth_bytes_per_second',
    uid,
    (labels) => labels.direction === 'received',
  );
  const bwOut = scoped(
    allowlisted,
    'teamspeak_connection_bandwidth_bytes_per_second',
    uid,
    (labels) => labels.direction === 'sent',
  );
  if (bwIn || bwOut) {
    augmentation.bandwidth = {};
    const incoming = bwIn ? finiteNumber(bwIn.value) : undefined;
    const outgoing = bwOut ? finiteNumber(bwOut.value) : undefined;
    if (incoming !== undefined) augmentation.bandwidth.incoming = incoming;
    if (outgoing !== undefined) augmentation.bandwidth.outgoing = outgoing;
  }

  const speechLoss = scoped(
    allowlisted,
    'teamspeak_packetloss_ratio',
    uid,
    (labels) => labels.traffic_class === 'speech',
  );
  if (speechLoss) {
    const value = finiteNumber(speechLoss.value);
    if (value !== undefined) augmentation.packetloss = value;
  } else {
    const lossSamples = allowlisted.filter(
      (s) => s.name === 'teamspeak_packetloss_ratio' && s.labels[VS_UNIQUE_ID_LABEL] === uid,
    );
    if (lossSamples.length > 0) {
      const mean = lossSamples.reduce((sum, s) => sum + s.value, 0) / lossSamples.length;
      const value = finiteNumber(mean);
      if (value !== undefined) augmentation.packetloss = value;
    }
  }

  const pingSeconds = scoped(allowlisted, 'teamspeak_ping_seconds', uid);
  if (pingSeconds) {
    // WebQuery dashboard exposes ping in milliseconds.
    const value = finiteNumber(pingSeconds.value * 1000);
    if (value !== undefined) augmentation.ping = value;
  }

  return { ok: true, augmentation, fetchedAt };
}

/** Merge metrics augmentation onto WebQuery dashboard fields (omit missing). */
export function applyMetricsAugmentation<T extends Record<string, unknown>>(
  base: T & {
    onlineUsers: number;
    maxClients: number;
    uptime: number;
    channelCount: number;
    bandwidth: { incoming: number; outgoing: number };
    packetloss: number;
    ping: number;
  },
  augmentation: MetricsAugmentation,
): typeof base {
  const next = { ...base, bandwidth: { ...base.bandwidth } };
  if (augmentation.onlineUsers !== undefined) next.onlineUsers = augmentation.onlineUsers;
  if (augmentation.maxClients !== undefined) next.maxClients = augmentation.maxClients;
  if (augmentation.uptime !== undefined) next.uptime = augmentation.uptime;
  if (augmentation.channelCount !== undefined) next.channelCount = augmentation.channelCount;
  if (augmentation.packetloss !== undefined) next.packetloss = augmentation.packetloss;
  if (augmentation.ping !== undefined) next.ping = augmentation.ping;
  if (augmentation.bandwidth?.incoming !== undefined) {
    next.bandwidth.incoming = augmentation.bandwidth.incoming;
  }
  if (augmentation.bandwidth?.outgoing !== undefined) {
    next.bandwidth.outgoing = augmentation.bandwidth.outgoing;
  }
  return next;
}
