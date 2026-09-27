export type MetricHealth = 'normal' | 'elevated' | 'high';

// Server-wide averages reported by TeamSpeak; bands follow common VoIP guidance.
const PING_ELEVATED_MS = 100;
const PING_HIGH_MS = 200;
const PACKET_LOSS_ELEVATED = 0.01;
const PACKET_LOSS_HIGH = 0.05;

function classify(value: number, elevated: number, high: number): MetricHealth {
  if (!Number.isFinite(value) || value < elevated) return 'normal';
  return value < high ? 'elevated' : 'high';
}

export function classifyPing(ms: number): MetricHealth {
  return classify(ms, PING_ELEVATED_MS, PING_HIGH_MS);
}

/** `fraction` is TeamSpeak's 0–1 packet loss ratio, not a percentage. */
export function classifyPacketLoss(fraction: number): MetricHealth {
  return classify(fraction, PACKET_LOSS_ELEVATED, PACKET_LOSS_HIGH);
}

export const METRIC_HEALTH_LABEL: Record<Exclude<MetricHealth, 'normal'>, string> = {
  elevated: 'Elevated',
  high: 'High',
};
