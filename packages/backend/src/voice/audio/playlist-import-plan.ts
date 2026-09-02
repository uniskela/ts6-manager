/** Pure planning for a playlist import. No I/O, no Prisma, no yt-dlp. */

export interface PlanEntry {
  id: string;
  title: string;
  url: string;
}

export interface ImportPlan {
  /** Entries to download, in playlist order, already capped. */
  toImport: PlanEntry[];
  /** Entries already attached to the playlist; reported, never re-fetched. */
  alreadyPresent: PlanEntry[];
  /** How many candidates the cap cut. */
  truncated: number;
}

/** Canonical watch URL, used as the identity of a track across imports. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Hosts whose `list=` parameter actually denotes a YouTube playlist. */
const YOUTUBE_PLAYLIST_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
]);

/**
 * True only for a URL that *is* a playlist, e.g. `/playlist?list=PL…`.
 *
 * YouTube appends `&list=` to the address bar of every video opened from a
 * playlist, and `&list=RD…` to everything reached by autoplay/Mix. Those URLs
 * carry a `v=` too and must stay single-video plays.
 */
export function isYouTubePlaylistUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!YOUTUBE_PLAYLIST_HOSTS.has(url.hostname.toLowerCase())) return false;
  return url.searchParams.has('list') && !url.searchParams.has('v');
}

/**
 * Split a playlist's entries into what to fetch and what is already there.
 * The cap bounds downloads only — already-present entries never consume it.
 */
export function planImport(entries: PlanEntry[], attachedUrls: Set<string>, cap: number): ImportPlan {
  const alreadyPresent: PlanEntry[] = [];
  const candidates: PlanEntry[] = [];

  for (const entry of entries) {
    if (!entry.id) continue;
    if (attachedUrls.has(entry.url)) {
      alreadyPresent.push(entry);
    } else {
      candidates.push(entry);
    }
  }

  const limit = Math.max(0, cap);
  return {
    toImport: candidates.slice(0, limit),
    alreadyPresent,
    truncated: Math.max(0, candidates.length - limit),
  };
}
