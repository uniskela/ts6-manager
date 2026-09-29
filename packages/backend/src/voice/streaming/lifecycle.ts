import type { MediaStopReason, VideoSourceMode, VideoSourceModeRequest } from '@ts6/common';

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


/**
 * Decide the source mode. Local files are always `file`; an explicit request
 * wins for remote sources; otherwise a probe without a duration means live.
 * With no probe (fixed presets never probe) remote sources stay `vod`, the
 * pre-1.9 behaviour. URL suffixes such as `.m3u8` are never used.
 */
export function resolveSourceMode(
  requested: VideoSourceModeRequest | undefined,
  isLocal: boolean,
  probe: { durationSec: number | null } | null,
): VideoSourceMode {
  if (isLocal) return 'file';
  if (requested === 'live' || requested === 'vod') return requested;
  if (probe) return probe.durationSec == null ? 'live' : 'vod';
  return 'vod';
}

const SOURCE_FAILURE =
  /server returned|connection (refused|reset|timed out)|timed out|failed to resolve|name or service|no such file|invalid data found|end of file|http error|404|403|401|i\/o error/i;

/**
 * Why ffmpeg stopped on its own. `exitError` is the sidecar's URL-redacted
 * stderr summary. A clean exit of a non-looping VOD/file source is its end;
 * a live source should never end, so its exit means the source went away.
 */
export function classifyEncoderExit(opts: {
  mode: VideoSourceMode;
  loop: boolean;
  exitError: string | null;
}): { reason: MediaStopReason; detail: string } {
  const err = opts.exitError?.trim() || null;
  if (err && SOURCE_FAILURE.test(err)) {
    return { reason: 'source_unreachable', detail: `Source stopped responding: ${err}` };
  }
  if (!err && opts.mode !== 'live' && !opts.loop) {
    return { reason: 'source_ended', detail: 'Video reached its end' };
  }
  if (opts.mode === 'live') {
    return { reason: 'source_unreachable', detail: err ? `Live source ended: ${err}` : 'Live source ended' };
  }
  return { reason: 'encoder_failure', detail: err ? `Encoder stopped: ${err}` : 'Encoder stopped unexpectedly' };
}

/** "Encoding below realtime (0.62x for 40 s) — …" or null. */
export function belowRealtimeWarning(opts: {
  speed: number | null;
  belowSecs: number;
  preset: string;
  encoderLabel: string;
  mode: VideoSourceMode | null;
  rtpDrops: number;
}): string {
  const speed = opts.speed != null ? `${opts.speed.toFixed(2)}x` : 'unknown speed';
  const drops = opts.rtpDrops > 0 ? `, ${opts.rtpDrops} packets dropped` : '';
  return `Encoding below realtime (${speed} for ${Math.round(opts.belowSecs)} s${drops}) at ${opts.preset} with ${opts.encoderLabel}`
    + `${opts.mode ? ` from a ${opts.mode} source` : ''}. The host cannot keep up — try a lower preset or a hardware encoder.`;
}
