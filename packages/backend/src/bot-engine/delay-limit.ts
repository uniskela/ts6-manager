/** Static delay nodes stay at 5 minutes. */
export const MAX_DELAY_MS = 300_000;

/** Command reminders may wait longer than a static delay, but not for days. */
// shortcut: waits are memory-only; add durable scheduling if reminders must survive restarts.
export const REMINDER_DELAY_CAP_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** First token of `!remind 10m …`. Null when the token is not a duration. */
export function parseDurationMs(token: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d)$/i.exec(token.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const ms = amount * UNIT_MS[match[2].toLowerCase()];
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}
