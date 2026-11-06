import {
  checkListenerDuration,
  listenerTrackMetaFromYtDlp,
  LISTENER_MAX_DURATION_SEC,
  type ListenerDurationRefusal,
  type ListenerTrackMeta,
} from '../../voice/audio/listener-music.js';
import { dumpYouTubeJson } from '../../voice/audio/youtube.js';
import { fail } from './shared.js';

/** API `code` values for C1a refusals (`unknown_duration` → `duration_unknown`). */
export type ListenerDurationApiCode = 'too_long' | 'live_not_allowed' | 'duration_unknown';

const MESSAGES: Record<ListenerDurationRefusal, string> = {
  too_long: 'This track is longer than 15 minutes.',
  live_not_allowed: 'Live streams are not allowed.',
  unknown_duration: "This track's duration could not be verified.",
};

/** Map an internal duration refusal to the public listener-remote error code. */
export function listenerDurationApiCode(reason: ListenerDurationRefusal): ListenerDurationApiCode {
  return reason === 'unknown_duration' ? 'duration_unknown' : reason;
}

/** Fail with 422 when the track is live, too long, or of unknown length. */
export function refuseListenerDuration(meta: ListenerTrackMeta): void {
  const verdict = checkListenerDuration(meta);
  if (verdict.ok) return;
  fail(422, listenerDurationApiCode(verdict.reason), MESSAGES[verdict.reason]);
}

/**
 * Byte cap for a listener paste download. Sized for 15 minutes of high-bitrate
 * audio with headroom so a wrong reported duration cannot fill the 1 GiB cache
 * limit.
 */
export const LISTENER_MAX_DOWNLOAD_BYTES = Math.ceil(LISTENER_MAX_DURATION_SEC * 320_000 / 8 * 2);

/** Probe URL metadata for the listener duration gate (yt-dlp dump, no download). */
export async function probeListenerLinkMeta(
  url: string,
  signal?: AbortSignal,
): Promise<ListenerTrackMeta> {
  return listenerTrackMetaFromYtDlp(await dumpYouTubeJson(url, signal));
}
