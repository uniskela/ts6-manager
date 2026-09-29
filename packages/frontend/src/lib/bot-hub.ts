/**
 * Bot hub wording: what a bot is doing right now, in one line.
 */

import type { BotMediaOverview } from '@ts6/common';
import {
  SOURCE_MODE_LABELS, formatClock, lastStopLabel, qualityLabel, encoderLabel, formatTimeout, healthLabel,
} from './video-streaming';

export type HubTone = 'live' | 'music' | 'idle' | 'offline';

export function hubTone(bot: BotMediaOverview): HubTone {
  if (bot.status === 'stopped' || bot.status === 'error') return 'offline';
  if (bot.session?.kind === 'video') return 'live';
  if (bot.session?.kind === 'music') return 'music';
  return 'idle';
}

/** "Neon Skyline — Aurora", "Streaming from iptv.example", "Idle", "Offline". */
export function hubHeadline(bot: BotMediaOverview): string {
  const tone = hubTone(bot);
  if (tone === 'offline') return bot.status === 'error' ? 'Error' : 'Offline';
  if (tone === 'live') {
    const label = bot.session?.label;
    return bot.session?.state === 'starting'
      ? `Starting stream${label ? ` from ${label}` : ''}…`
      : `Streaming${label ? ` from ${label}` : ''}`;
  }
  if (tone === 'music' && bot.music) {
    const title = bot.music.title ?? 'Unknown track';
    return bot.music.artist ? `${title} — ${bot.music.artist}` : title;
  }
  return 'Idle';
}

/** Compact facts for the card: quality/encoder/viewers for video, progress for music. */
export function hubFacts(bot: BotMediaOverview, now: number): string[] {
  const facts: string[] = [];
  if (bot.video) {
    facts.push(qualityLabel(bot.video.quality, bot.video.preset));
    facts.push(encoderLabel(bot.video.encoder));
    if (bot.video.sourceMode) facts.push(SOURCE_MODE_LABELS[bot.video.sourceMode]);
    if (bot.video.health?.speed != null) facts.push(healthLabel(bot.video.health));
    facts.push(`${bot.video.viewerCount} viewer${bot.video.viewerCount === 1 ? '' : 's'}`);
    if (bot.video.startedAt) facts.push(`up ${formatClock(now - bot.video.startedAt)}`);
    if (bot.video.noViewer.stopAt) {
      facts.push(`auto-stop in ${formatClock(bot.video.noViewer.stopAt - now)}`);
    } else if (bot.video.noViewer.timeoutSec > 0) {
      facts.push(`stops after ${formatTimeout(bot.video.noViewer.timeoutSec)} idle`);
    }
  } else if (bot.music) {
    if (bot.music.live) {
      facts.push('Live radio');
      if (bot.music.position != null) facts.push(`up ${formatClock(bot.music.position * 1000)}`);
    } else if (bot.music.position != null) {
      facts.push(bot.music.duration
        ? `${formatClock(bot.music.position * 1000)} / ${formatClock(bot.music.duration * 1000)}`
        : formatClock(bot.music.position * 1000));
    }
    if (bot.status === 'paused') facts.push('Paused');
  }
  return facts;
}

/** The newest stop across music and video, for idle cards. */
export function hubLastStop(bot: BotMediaOverview, now: number): string | null {
  const stops = [
    bot.lastVideoStop ? { ...bot.lastVideoStop, kind: 'Stream' } : null,
    bot.lastMusicStop ? { ...bot.lastMusicStop, kind: 'Music' } : null,
  ].filter((s): s is NonNullable<typeof s> => s != null).sort((a, b) => b.at - a.at);
  const latest = stops[0];
  if (!latest) return null;
  return `Last ${latest.kind.toLowerCase()}: ${lastStopLabel(latest, now)}`;
}
