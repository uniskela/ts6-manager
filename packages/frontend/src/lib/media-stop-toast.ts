/**
 * Toast when media stops for a reason the operator should notice (not
 * manual stop / intentional replace). Driven by bot-media poll deltas.
 */

import { toast } from 'sonner';
import type { BotMediaOverview, MediaStopInfo, MediaStopReason } from '@ts6/common';
import { lastStopLabel } from './video-streaming';

/** Reasons that deserve a toast (failures / unexpected auto-stops). */
const TOAST_REASONS = new Set<MediaStopReason>([
  'source_unreachable',
  'encoder_failure',
  'sidecar_failure',
  'no_viewers',
  'channel_empty',
  'source_ended',
  'server_disconnect',
  'bot_stopped',
]);

const ERROR_REASONS = new Set<MediaStopReason>([
  'source_unreachable',
  'encoder_failure',
  'sidecar_failure',
  'server_disconnect',
]);

export type MediaStopToastKey = `${number}:${'music' | 'video'}:${number}`;

export function mediaStopToastKey(
  botId: number,
  kind: 'music' | 'video',
  stop: MediaStopInfo,
): MediaStopToastKey {
  return `${botId}:${kind}:${stop.at}`;
}

/** Stops worth toasting from one bot overview (newest per kind only). */
export function collectToastableStops(bot: BotMediaOverview): Array<{
  key: MediaStopToastKey;
  botName: string;
  kind: 'music' | 'video';
  stop: MediaStopInfo;
}> {
  const out: Array<{
    key: MediaStopToastKey;
    botName: string;
    kind: 'music' | 'video';
    stop: MediaStopInfo;
  }> = [];
  if (bot.lastVideoStop && TOAST_REASONS.has(bot.lastVideoStop.reason)) {
    out.push({
      key: mediaStopToastKey(bot.botId, 'video', bot.lastVideoStop),
      botName: bot.botName,
      kind: 'video',
      stop: bot.lastVideoStop,
    });
  }
  if (bot.lastMusicStop && TOAST_REASONS.has(bot.lastMusicStop.reason)) {
    out.push({
      key: mediaStopToastKey(bot.botId, 'music', bot.lastMusicStop),
      botName: bot.botName,
      kind: 'music',
      stop: bot.lastMusicStop,
    });
  }
  return out;
}

export function toastMediaStopped(opts: {
  botName: string;
  kind: 'music' | 'video';
  stop: MediaStopInfo;
  now?: number;
}): void {
  const label = lastStopLabel(opts.stop, opts.now ?? Date.now()) ?? opts.stop.reason;
  const kindLabel = opts.kind === 'video' ? 'Stream' : 'Music';
  const message = `${opts.botName}: ${kindLabel} stopped — ${label}`;
  if (ERROR_REASONS.has(opts.stop.reason)) {
    toast.error(message, {
      action: {
        label: 'Open Bot Hub',
        onClick: () => {
          window.location.assign('/bot-hub');
        },
      },
    });
  } else {
    toast.message(message, {
      action: {
        label: 'Open Bot Hub',
        onClick: () => {
          window.location.assign('/bot-hub');
        },
      },
    });
  }
}

/**
 * Diff bot-media snapshots and toast newly appeared stop events.
 * Returns the updated set of keys already toasted (seed on first poll).
 */
export function applyMediaStopToastDelta(
  bots: BotMediaOverview[],
  seen: Set<MediaStopToastKey>,
  opts?: { now?: number; toast?: typeof toastMediaStopped },
): Set<MediaStopToastKey> {
  const next = new Set(seen);
  const emit = opts?.toast ?? toastMediaStopped;
  const seeding = seen.size === 0;
  for (const bot of bots) {
    for (const item of collectToastableStops(bot)) {
      if (next.has(item.key)) continue;
      next.add(item.key);
      if (!seeding) {
        emit({
          botName: item.botName,
          kind: item.kind,
          stop: item.stop,
          now: opts?.now,
        });
      }
    }
  }
  return next;
}
