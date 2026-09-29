/**
 * Human-readable media lifecycle wording (stop reasons, countdowns).
 */

/** "5 minutes", "1 minute", "45 seconds", "1 minute 30 seconds". */
export function describeDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (sec < 60) return plural(sec, 'second');
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (h) parts.push(plural(h, 'hour'));
  if (m) parts.push(plural(m, 'minute'));
  if (s) parts.push(plural(s, 'second'));
  return parts.join(' ');
}

export function noViewersStopDetail(timeoutSec: number): string {
  return `Stopped after ${describeDuration(timeoutSec)} with no viewers`;
}

export function channelEmptyStopDetail(graceSec: number): string {
  return `Stopped after the channel was empty for ${describeDuration(graceSec)}`;
}
