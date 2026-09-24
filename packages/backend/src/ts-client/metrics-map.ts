/**
 * Map scraped Prometheus samples → dashboard augmentation fields.
 *
 * Allow-list and VS scoping derived from real beta13 fixture
 * `ts6-beta13-metrics.txt` only. Unknown metric names are ignored.
 *
 * Identity join (Codex Job 2):
 *   selected SID → teamspeak_virtualserver_info.virtualserver_id
 *   → virtualserver_unique_identifier
 *   → must agree with authenticated WebQuery virtualserver_unique_identifier
 * Only samples carrying that exact UID are accepted; else fail closed as `unscoped`.
 *
 * Uptime and total packet loss stay on WebQuery (do not map host timestamps or
 * speech/average packet-loss class ratios).
 */

import type { PrometheusSample } from './metrics-parse.js';

export type MetricsUnavailableReason = 'timeout' | 'unreachable' | 'invalid' | 'unscoped';

export type MetricsProvenance =
  | { status: 'disabled' }
  | { status: 'current'; fetchedAt: string }
  | { status: 'unavailable'; fetchedAt?: string; reason: MetricsUnavailableReason };

/**
 * Optional dashboard fields metrics may augment.
 * Missing / invalid series are omitted — never filled with misleading zeroes.
 * Uptime and packetloss are intentionally absent (WebQuery-only).
 */
export type MetricsAugmentation = {
  onlineUsers?: number;
  maxClients?: number;
  channelCount?: number;
  bandwidth?: {
    incoming?: number;
    outgoing?: number;
  };
  ping?: number;
};

/** Label used on per-VS series in beta13 (not numeric SID alone). */
export const VS_UNIQUE_ID_LABEL = 'virtualserver_unique_identifier';

/** Identity series that also carries numeric `virtualserver_id` for SID resolution. */
export const VS_INFO_METRIC = 'teamspeak_virtualserver_info';

/**
 * Metric names permitted for dashboard augmentation / SID resolution.
 * Derived from packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.txt.
 * Packet-loss and host/start timestamps are not allow-listed for mapping.
 */
export const METRICS_ALLOWLIST: readonly string[] = Object.freeze([
  'teamspeak_virtualserver_info',
  'teamspeak_clients_online',
  'teamspeak_query_clients_online',
  'teamspeak_max_clients',
  'teamspeak_channels_online',
  'teamspeak_connection_bandwidth_bytes_per_second',
  'teamspeak_ping_seconds',
]);

export function isMetricsAllowlistReady(): boolean {
  return METRICS_ALLOWLIST.length > 0;
}

const ALLOWLIST_SET = new Set<string>(METRICS_ALLOWLIST);

export type MapScopedMetricsResult =
  | { ok: true; augmentation: MetricsAugmentation; fetchedAt: string; usedFields: string[] }
  | { ok: false; reason: MetricsUnavailableReason; fetchedAt: string };

function isUsableFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Find a single matching sample. Duplicate matches are ambiguous → omit.
 */
function findUniqueSample(
  samples: PrometheusSample[],
  name: string,
  match: (labels: Record<string, string>) => boolean = () => true,
): PrometheusSample | undefined {
  const hits = samples.filter((s) => s.name === name && match(s.labels));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Resolve selected Query SID → virtualserver_unique_identifier via
 * teamspeak_virtualserver_info{virtualserver_id="<sid>"}.
 * Ambiguous (multiple distinct UIDs for the same SID) → null.
 */
export function resolveVirtualServerUniqueId(
  samples: PrometheusSample[],
  sid: number,
): string | null {
  const matches = samples.filter(
    (s) => s.name === VS_INFO_METRIC && s.labels.virtualserver_id === String(sid),
  );
  if (matches.length === 0) return null;

  const uids = new Set(
    matches
      .map((s) => s.labels[VS_UNIQUE_ID_LABEL])
      .filter((uid): uid is string => typeof uid === 'string' && uid.length > 0),
  );
  if (uids.size !== 1) return null;
  return [...uids][0] ?? null;
}

function scoped(
  samples: PrometheusSample[],
  name: string,
  uid: string,
  extra: (labels: Record<string, string>) => boolean = () => true,
): PrometheusSample | undefined {
  return findUniqueSample(
    samples,
    name,
    (labels) => labels[VS_UNIQUE_ID_LABEL] === uid && extra(labels),
  );
}

export type MapScopedMetricsOptions = {
  /** Authenticated WebQuery virtualserver_unique_identifier for the selected SID. */
  webqueryUniqueId: string;
  fetchedAt?: string;
};

/**
 * Map allow-listed, VS-scoped samples for the selected SID into dashboard fields.
 * Fail-closed when SID cannot be proven, WebQuery UID is missing/mismatched, or
 * metrics UID does not agree with authenticated WebQuery identity.
 */
export function mapScopedMetrics(
  samples: PrometheusSample[],
  sid: number,
  options: MapScopedMetricsOptions,
): MapScopedMetricsResult {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const expectedUid = options.webqueryUniqueId?.trim();

  if (!isMetricsAllowlistReady() || !expectedUid) {
    return { ok: false, reason: 'unscoped', fetchedAt };
  }

  const allowlisted = samples.filter((s) => ALLOWLIST_SET.has(s.name));
  const uid = resolveVirtualServerUniqueId(allowlisted, sid);
  if (!uid || uid !== expectedUid) {
    return { ok: false, reason: 'unscoped', fetchedAt };
  }

  const augmentation: MetricsAugmentation = {};
  const usedFields: string[] = [];

  const clientsOnline = scoped(allowlisted, 'teamspeak_clients_online', uid);
  const queryOnline = scoped(allowlisted, 'teamspeak_query_clients_online', uid);
  // Both counts required; never fall back to clients-only (would include query clients).
  if (clientsOnline && queryOnline) {
    if (isUsableFinite(clientsOnline.value) && isUsableFinite(queryOnline.value)) {
      const nonQuery = clientsOnline.value - queryOnline.value;
      if (isUsableFinite(nonQuery)) {
        augmentation.onlineUsers = nonQuery;
        usedFields.push('onlineUsers');
      }
    }
  }

  const maxClients = scoped(allowlisted, 'teamspeak_max_clients', uid);
  if (maxClients && isUsableFinite(maxClients.value)) {
    augmentation.maxClients = maxClients.value;
    usedFields.push('maxClients');
  }

  const channels = scoped(allowlisted, 'teamspeak_channels_online', uid);
  if (channels && isUsableFinite(channels.value)) {
    augmentation.channelCount = channels.value;
    usedFields.push('channelCount');
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
    const bandwidth: NonNullable<MetricsAugmentation['bandwidth']> = {};
    if (bwIn && isUsableFinite(bwIn.value)) bandwidth.incoming = bwIn.value;
    if (bwOut && isUsableFinite(bwOut.value)) bandwidth.outgoing = bwOut.value;
    if (bandwidth.incoming !== undefined || bandwidth.outgoing !== undefined) {
      augmentation.bandwidth = bandwidth;
      usedFields.push('bandwidth');
    }
  }

  const pingSeconds = scoped(allowlisted, 'teamspeak_ping_seconds', uid);
  if (pingSeconds && isUsableFinite(pingSeconds.value)) {
    // WebQuery dashboard exposes ping in milliseconds.
    const pingMs = pingSeconds.value * 1000;
    if (isUsableFinite(pingMs)) {
      augmentation.ping = pingMs;
      usedFields.push('ping');
    }
  }

  return { ok: true, augmentation, fetchedAt, usedFields };
}

/** True when at least one dashboard field was taken from metrics. */
export function metricsAugmentationUsed(augmentation: MetricsAugmentation | undefined): boolean {
  if (!augmentation) return false;
  if (augmentation.onlineUsers !== undefined) return true;
  if (augmentation.maxClients !== undefined) return true;
  if (augmentation.channelCount !== undefined) return true;
  if (augmentation.ping !== undefined) return true;
  if (augmentation.bandwidth?.incoming !== undefined) return true;
  if (augmentation.bandwidth?.outgoing !== undefined) return true;
  return false;
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
  if (augmentation.channelCount !== undefined) next.channelCount = augmentation.channelCount;
  if (augmentation.ping !== undefined) next.ping = augmentation.ping;
  if (augmentation.bandwidth?.incoming !== undefined) {
    next.bandwidth.incoming = augmentation.bandwidth.incoming;
  }
  if (augmentation.bandwidth?.outgoing !== undefined) {
    next.bandwidth.outgoing = augmentation.bandwidth.outgoing;
  }
  // uptime + packetloss intentionally never overwritten from metrics
  return next;
}
