/**
 * TS6 client rich-text helpers for music-bot channel chat.
 * Messages are plain text with Markdown / limited HTML; the TS6 client renders them.
 * Interactive pause/skip buttons are not available server-side — use command hints.
 */

export interface TrackLine {
  title: string;
  artist?: string;
  duration?: number;
}

export interface NowPlayingFormatInput {
  title: string;
  artist?: string;
  position?: number;
  duration?: number;
  paused?: boolean;
  upcoming?: TrackLine[];
  totalQueueLength?: number;
  /** Index of the currently playing track in the full queue. */
  queueIndex?: number;
  includeControls?: boolean;
}

export interface HelpCommandLine {
  usage: string;
  blurb: string;
}

export interface CustomHelpLine {
  name: string;
  description?: string | null;
}

export const TS6_CHAT_FORMATTING_HINT =
  'TS6 renders Markdown in chat: **bold**, lists, > quotes, `code`, tables, <details>/<summary>, images, BBCode legacy tags.';

function escapeMarkdownInline(text: string): string {
  return text.replace(/([\\*_`~|])/g, '\\$1');
}

function formatMmSs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function trackDurationSuffix(duration?: number): string {
  if (!duration || duration <= 0) return '';
  return ` _(${formatMmSs(duration)})_`;
}

/** Rich now-playing block for !np / !nowplaying. */
export function formatNowPlayingMessage(input: NowPlayingFormatInput): string {
  const lines: string[] = ['## 🎵 Now Playing', ''];
  const title = escapeMarkdownInline(input.title);
  const artistPart = input.artist ? ` — *${escapeMarkdownInline(input.artist)}*` : '';
  lines.push(`**${title}**${artistPart}`);

  if (input.position != null && input.duration != null && input.duration > 0) {
    lines.push(`${formatMmSs(input.position)} / ${formatMmSs(input.duration)}`);
  }

  if (input.paused) {
    lines.push('');
    lines.push('> ⏸ Paused');
  }

  if (input.upcoming && input.upcoming.length > 0) {
    lines.push('');
    lines.push('### Up Next');
    input.upcoming.forEach((item, i) => {
      const artist = item.artist ? ` — ${escapeMarkdownInline(item.artist)}` : '';
      lines.push(
        `${i + 1}. ${escapeMarkdownInline(item.title)}${artist}${trackDurationSuffix(item.duration)}`,
      );
    });
    const afterCurrent =
      input.totalQueueLength != null && input.queueIndex != null
        ? Math.max(0, input.totalQueueLength - input.queueIndex - 1)
        : 0;
    const extra = afterCurrent > input.upcoming.length ? afterCurrent - input.upcoming.length : 0;
    if (extra > 0) {
      lines.push(`_… and ${extra} more in queue_`);
    }
  }

  if (input.includeControls) {
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Playback controls</summary>');
    lines.push('');
    lines.push('Type in channel chat (not clickable buttons):');
    lines.push('- `!pause` — pause / resume');
    lines.push('- `!skip` or `!next` — skip track');
    lines.push('- `!prev` — previous track');
    lines.push('- `!stop` — stop playback');
    lines.push('- `!queue show` — full queue');
    lines.push('</details>');
  }

  return lines.join('\n');
}

/** Markdown help list for !help. */
export function formatHelpMessage(
  builtin: HelpCommandLine[],
  custom: CustomHelpLine[],
): string {
  const lines: string[] = ['## Music bot commands', '', '### Built-in'];
  for (const entry of builtin) {
    lines.push(`- **${entry.usage}** — ${entry.blurb}`);
  }

  if (custom.length > 0) {
    lines.push('');
    lines.push('### Custom');
    for (const c of custom) {
      const blurb = c.description?.trim() || 'Custom reply';
      lines.push(`- **!${c.name}** — ${blurb}`);
    }
  }

  return lines.join('\n');
}

/** Markdown queue listing for !queue show. */
export function formatQueueMessage(
  items: TrackLine[],
  currentIndex: number,
  maxLines = 15,
): string {
  if (items.length === 0) return '_Queue is empty._';

  const lines: string[] = [`## Queue (${items.length} tracks)`, ''];
  const shown = items.slice(0, maxLines);
  shown.forEach((item, i) => {
    const prefix = i === currentIndex ? '▶️' : '•';
    const artist = item.artist ? `${escapeMarkdownInline(item.artist)} — ` : '';
    lines.push(
      `${prefix} **${i + 1}.** ${artist}${escapeMarkdownInline(item.title)}${trackDurationSuffix(item.duration)}`,
    );
  });

  if (items.length > maxLines) {
    lines.push('');
    lines.push(`_… and ${items.length - maxLines} more_`);
  }

  return lines.join('\n');
}

/** Short formatted radio station list. */
export function formatRadioListMessage(
  stations: Array<{ id: number; name: string; genre?: string | null }>,
): string {
  const lines: string[] = ['## Radio stations', ''];
  for (const s of stations) {
    const genre = s.genre ? ` _(${escapeMarkdownInline(s.genre)})_` : '';
    lines.push(`- **${s.id}** — ${escapeMarkdownInline(s.name)}${genre}`);
  }
  lines.push('');
  lines.push('_Play with `!radio <id>`_');
  return lines.join('\n');
}
