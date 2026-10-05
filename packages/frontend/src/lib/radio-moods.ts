/**
 * Radio "moods" are derived from each station's free-text genre. Community
 * (Radio Browser) imports store several tags in one string, e.g.
 * "local, local information, local news", so a genre is split into
 * individual tags before it becomes a mood chip or filter.
 */

export interface RadioMood {
  /** Case-insensitive identity used for filtering and dedupe. */
  key: string;
  /** Display label. */
  label: string;
  /** Number of stations tagged with this mood. */
  count: number;
}

/** Mood chips shown before the "More" toggle. */
export const RADIO_MOOD_CHIP_LIMIT = 12;

/** Split a genre string into trimmed tags, deduped case-insensitively (first spelling wins). */
export function splitGenreTags(genre: string | null | undefined): string[] {
  if (!genre) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of genre.split(/[,;]/)) {
    const tag = raw.trim().replace(/\s+/g, ' ');
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** Capitalise all-lowercase tags ("local news" → "Local News"); keep deliberate casing ("Pop/Rock", "BBC"). */
function displayLabel(tag: string): string {
  if (tag !== tag.toLowerCase()) return tag;
  return tag.replace(/(^|[\s/&-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Count stations under each of their tags. Sorted by station count (desc),
 * then label. A spelling with capitals beats an all-lowercase one for the label.
 */
export function radioMoods(stations: ReadonlyArray<{ genre?: string | null }>): RadioMood[] {
  const byKey = new Map<string, { label: string; count: number; cased: boolean }>();
  for (const s of stations) {
    for (const tag of splitGenreTags(s.genre)) {
      const key = tag.toLowerCase();
      const cased = tag !== key;
      const entry = byKey.get(key);
      if (!entry) {
        byKey.set(key, { label: tag, count: 1, cased });
      } else {
        entry.count += 1;
        if (cased && !entry.cased) {
          entry.label = tag;
          entry.cased = true;
        }
      }
    }
  }
  return [...byKey.entries()]
    .map(([key, { label, count }]) => ({ key, label: displayLabel(label), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** True when one of the station's genre tags matches the mood key (case-insensitive). */
export function stationHasMood(genre: string | null | undefined, key: string): boolean {
  return splitGenreTags(genre).some((tag) => tag.toLowerCase() === key);
}
