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
  /server returned|connection (refused|reset|timed out)|timed out|failed to resolve|name or service|no such file|invalid data found|end of file|http error|\b(?:400\s+Bad Request|401\s+Unauthorized|403\s+Forbidden|404\s+Not Found)\b|i\/o error|matches no streams|stream map|empty segment/i;

/**
 * Turn ffmpeg/sidecar stderr into a short operator-facing line (no pointer
 * addresses, no duplicated HTTP noise).
 */
export function humanizeSourceError(raw: string): string {
  const err = raw.trim();
  if (!err) return 'Source became unreachable';
  if (/matches no streams|stream map|empty segment/i.test(err)) {
    return 'Playlist has no playable streams (variants failed or empty)';
  }
  const codeMatch = err.match(/\bHTTP error\s+(\d{3})\b/i)
    ?? err.match(/\bServer returned\s+(\d{3})\b/i)
    ?? err.match(/\b([45]\d{2})\s+(?:Bad Request|Not Found|Forbidden|Unauthorized)\b/i);
  if (codeMatch) {
    const code = codeMatch[1];
    if (code === '400') return 'Source returned 400 Bad Request — URL may be invalid or expired';
    if (code === '401') return 'Source returned 401 Unauthorized — credentials or a token may be required';
    if (code === '403') return 'Source returned 403 Forbidden — access may be blocked';
    if (code === '404') return 'Source returned 404 Not Found — stream URL may be dead or moved';
    return `Source returned HTTP ${code}`;
  }
  if (/connection (refused|reset|timed out)|timed out|failed to resolve|name or service/i.test(err)) {
    return 'Could not reach the media source (network or DNS failure)';
  }
  // Strip ffmpeg channel tags like `[https @ 0x…]` and `<source>` markers.
  const cleaned = err
    .replace(/\[[^\]]*@\s*0x[0-9a-fA-F]+\]\s*/g, '')
    .replace(/<source>\s*/gi, '')
    .replace(/\s*;\s*/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Source became unreachable';
  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}…` : cleaned;
}

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
    return { reason: 'source_unreachable', detail: humanizeSourceError(err) };
  }
  if (!err && opts.mode !== 'live' && !opts.loop) {
    return { reason: 'source_ended', detail: 'Video reached its end' };
  }
  if (opts.mode === 'live') {
    return {
      reason: 'source_unreachable',
      detail: err ? humanizeSourceError(err) : 'Live source ended',
    };
  }
  return {
    reason: 'encoder_failure',
    detail: err ? `Encoder stopped: ${humanizeSourceError(err)}` : 'Encoder stopped unexpectedly',
  };
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
