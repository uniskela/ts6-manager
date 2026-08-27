import { searchYouTube } from "./youtube.js";

export interface AppleMusicTrack {
  artist: string;
  title: string;
}

export interface AppleMusicResolved {
  tracks: AppleMusicTrack[];
  /** Playlist / album display name when available. */
  title?: string;
}

/** Exact hosts allowed for Apple Music / iTunes metadata fetches. */
type AppleMusicFetchHost =
  | "music.apple.com"
  | "itunes.apple.com"
  | "geo.itunes.apple.com"
  | "apple.co";

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/**
 * Map a hostname to an allowlisted Apple/iTunes host constant.
 * Returning string literals (not the input) keeps the fetch target host untainted for SSRF analysis.
 */
export function resolveAppleMusicFetchHost(hostname: string): AppleMusicFetchHost | null {
  switch (normalizeHostname(hostname)) {
    case "music.apple.com":
      return "music.apple.com";
    case "itunes.apple.com":
      return "itunes.apple.com";
    case "geo.itunes.apple.com":
      return "geo.itunes.apple.com";
    case "apple.co":
      return "apple.co";
    default:
      return null;
  }
}

export function isAppleMusicShareHostname(hostname: string): boolean {
  return resolveAppleMusicFetchHost(hostname) !== null;
}

export function isAppleMusicShareUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return isAppleMusicShareHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function buildAppleFetchUrl(allowedHost: AppleMusicFetchHost, from: URL): URL {
  const safe = new URL(`https://${allowedHost}`);
  safe.pathname = from.pathname;
  safe.search = from.search;
  return safe;
}

/**
 * Fetch an allowlisted Apple/iTunes URL, re-validating the host on every redirect hop.
 * Request URLs are rebuilt from allowlisted host constants (not the raw user URL).
 * Returns the final response and the last allowlisted request URL (fetch Response.url is
 * unreliable with redirect: "manual").
 */
async function fetchAppleAllowlisted(
  initialUrl: URL,
  maxRedirects = 5,
): Promise<{ res: Response; finalUrl: URL }> {
  let current = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.username || current.password) {
      throw new Error("URL credentials are not allowed");
    }
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new Error("Invalid URL protocol");
    }
    // Force https for all hops after parsing.
    if (current.protocol !== "https:") {
      current = new URL(current.href.replace(/^http:/i, "https:"));
    }

    const allowedHost = resolveAppleMusicFetchHost(current.hostname);
    if (!allowedHost) {
      throw new Error(`Refusing fetch to disallowed host: ${normalizeHostname(current.hostname)}`);
    }

    const safeUrl = buildAppleFetchUrl(allowedHost, current);
    const res = await fetch(safeUrl.href, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json",
      },
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("Redirect missing Location header");
      }
      current = new URL(location, safeUrl);
      continue;
    }

    return { res, finalUrl: safeUrl };
  }

  throw new Error("Too many redirects while fetching allowlisted URL");
}

/** iTunes Lookup only — host is a constant; id is validated. */
async function itunesLookup(id: string, entity?: "song"): Promise<Record<string, unknown>[]> {
  if (!/^\d+$/.test(id)) {
    throw new Error("Invalid iTunes id");
  }
  const url = new URL("https://itunes.apple.com/lookup");
  url.searchParams.set("id", id);
  if (entity) url.searchParams.set("entity", entity);

  const res = await fetch(url.href, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ts6-manager/1.0)", Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`iTunes lookup failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { results?: Record<string, unknown>[] };
  return Array.isArray(data.results) ? data.results : [];
}

export interface ParsedAppleMusicUrl {
  kind: "song" | "album" | "playlist" | "unknown";
  /** Numeric Adam id or pl.* playlist id. */
  id?: string;
  /** Song id from ?i= on album URLs. */
  songId?: string;
  storefront?: string;
}

/** Parse music.apple.com / itunes.apple.com / apple.co path shapes (no network). */
export function parseAppleMusicUrl(raw: string): ParsedAppleMusicUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { kind: "unknown" };
  }

  if (!isAppleMusicShareHostname(parsed.hostname)) {
    return { kind: "unknown" };
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  // /{storefront}/album|song|playlist/{slug}/{id}
  // itunes: /{storefront}/album/{slug}/{id} or /album/id{id}
  let storefront: string | undefined;
  let kindIdx = 0;
  if (parts[0] && /^[a-z]{2}$/i.test(parts[0])) {
    storefront = parts[0].toLowerCase();
    kindIdx = 1;
  }

  const kindRaw = (parts[kindIdx] || "").toLowerCase();
  const id = parts[kindIdx + 2] || parts[kindIdx + 1];
  const songIdParam = parsed.searchParams.get("i") || undefined;

  if (kindRaw === "song" && id && /^\d+$/.test(id)) {
    return { kind: "song", id, storefront, songId: id };
  }
  if (kindRaw === "album" && id && /^\d+$/.test(id)) {
    if (songIdParam && /^\d+$/.test(songIdParam)) {
      return { kind: "song", id, storefront, songId: songIdParam };
    }
    return { kind: "album", id, storefront };
  }
  if (kindRaw === "playlist" && id && /^pl\.[a-zA-Z0-9]+$/.test(id)) {
    return { kind: "playlist", id, storefront };
  }

  // itunes.apple.com/album/id12345
  const itunesAlbum = parsed.pathname.match(/\/album\/id(\d+)/i);
  if (itunesAlbum) {
    if (songIdParam && /^\d+$/.test(songIdParam)) {
      return { kind: "song", id: itunesAlbum[1], storefront, songId: songIdParam };
    }
    return { kind: "album", id: itunesAlbum[1], storefront };
  }

  return { kind: "unknown", storefront };
}

function trackFromItunesResult(r: Record<string, unknown>): AppleMusicTrack | null {
  const title = typeof r.trackName === "string" ? r.trackName.trim() : "";
  const artist = typeof r.artistName === "string" ? r.artistName.trim() : "";
  if (!title || !artist) return null;
  return { artist, title };
}

async function resolveViaItunes(parsed: ParsedAppleMusicUrl): Promise<AppleMusicResolved | null> {
  if (parsed.kind === "song" && parsed.songId) {
    const results = await itunesLookup(parsed.songId);
    const song = results.find((r) => r.kind === "song") || results[0];
    if (!song) return null;
    const track = trackFromItunesResult(song);
    return track ? { tracks: [track], title: `${track.artist} - ${track.title}` } : null;
  }

  if (parsed.kind === "album" && parsed.id) {
    const results = await itunesLookup(parsed.id, "song");
    const collection = results.find((r) => r.wrapperType === "collection");
    const albumTitle =
      typeof collection?.collectionName === "string" ? collection.collectionName : undefined;
    const tracks = results
      .filter((r) => r.kind === "song")
      .map(trackFromItunesResult)
      .filter((t): t is AppleMusicTrack => t !== null);
    if (!tracks.length) return null;
    return { tracks, title: albumTitle };
  }

  return null;
}

/**
 * Extract tracks from Apple Music web `serialized-server-data` JSON.
 * Prefer track-lockup rows (playlists); fall back to title+artistName pairs.
 */
export function extractTracksFromSerializedServerData(data: unknown): {
  tracks: AppleMusicTrack[];
  title?: string;
} {
  const tracks: AppleMusicTrack[] = [];
  const seen = new Set<string>();
  let pageTitle: string | undefined;

  const add = (artist: string, title: string) => {
    const a = artist.trim();
    const t = title.trim();
    if (!a || !t) return;
    // Skip obvious chrome / section labels.
    if (/^apple music$/i.test(a) || /^preview$/i.test(t)) return;
    const key = `${a.toLowerCase()}\0${t.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    tracks.push({ artist: a, title: t });
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;

    const pageFields = o.pageFields;
    if (pageFields && typeof pageFields === "object") {
      const pf = pageFields as Record<string, unknown>;
      // Prefer og/header title from nested structures later; keep pageId-derived only as last resort.
      if (typeof pf.pageType === "string" && pf.pageType === "Playlist" && typeof o.title === "string") {
        pageTitle = pageTitle || o.title;
      }
    }

    const id = typeof o.id === "string" ? o.id : "";
    const title = typeof o.title === "string" ? o.title : "";
    const artist =
      (typeof o.artistName === "string" && o.artistName) ||
      (typeof o.subtitle === "string" && o.subtitle) ||
      "";

    if (id.includes("track-lockup") && title && artist) {
      add(artist, title);
    }

    // Album / playlist header lockup often has the collection name.
    if (
      (id.includes("playlist-detail-header") || id.includes("album-detail-header")) &&
      title &&
      !pageTitle
    ) {
      pageTitle = title;
    }

    for (const v of Object.values(o)) walk(v);
  };

  walk(data);

  // Fallback: any title+artistName pairs if no track-lockups found.
  if (tracks.length === 0) {
    const walkPairs = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walkPairs(child);
        return;
      }
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (typeof o.title === "string" && typeof o.artistName === "string") {
        add(o.artistName, o.title);
      }
      for (const v of Object.values(o)) walkPairs(v);
    };
    walkPairs(data);
  }

  return { tracks, title: pageTitle };
}

async function resolveViaPageScrape(pageUrl: URL): Promise<AppleMusicResolved | null> {
  const { res } = await fetchAppleAllowlisted(pageUrl);
  if (!res.ok) {
    throw new Error(`Apple Music page fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const serialized = html.match(
    /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (serialized?.[1]) {
    try {
      const data = JSON.parse(serialized[1]);
      const extracted = extractTracksFromSerializedServerData(data);
      if (extracted.tracks.length) return extracted;
    } catch {
      /* fall through */
    }
  }

  // og:title fallback — single ambiguous query (song or playlist name).
  const og =
    html.match(/property="og:title"\s+content="([^"]+)"/i) ||
    html.match(/content="([^"]+)"\s+property="og:title"/i);
  if (og?.[1]) {
    let title = og[1]
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/\s+on Apple Music$/i, "")
      .trim();
    if (title && !/^Apple\s*Music/i.test(title)) {
      // "Song Name - Artist" or just a name — treat as a single search query track.
      const dash = title.match(/^(.+?)\s+[–—-]\s+(.+)$/);
      if (dash) {
        return { tracks: [{ title: dash[1].trim(), artist: dash[2].trim() }], title };
      }
      return { tracks: [{ title, artist: "" }], title };
    }
  }

  return null;
}

/**
 * Resolve an Apple Music / iTunes / apple.co share URL to track metadata
 * (artist + title). Does not download audio — callers search YouTube next.
 */
export async function resolveAppleMusicTracks(url: string): Promise<AppleMusicResolved> {
  const cleaned = url.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cleaned);
  } catch {
    throw new Error("Invalid Apple Music URL");
  }

  if (!isAppleMusicShareHostname(parsedUrl.hostname)) {
    throw new Error("Not an Apple Music share URL");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("Invalid Apple Music URL protocol: only https is allowed");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("URL credentials are not allowed");
  }
  if (parsedUrl.protocol === "http:") {
    parsedUrl = new URL(cleaned.replace(/^http:/i, "https:"));
  }

  // Short links / itunes URLs: follow allowlisted redirects to a canonical music.apple.com page.
  const host = resolveAppleMusicFetchHost(parsedUrl.hostname);
  if (host === "apple.co" || host === "itunes.apple.com" || host === "geo.itunes.apple.com") {
    const { res, finalUrl } = await fetchAppleAllowlisted(parsedUrl);
    // Consume body so the connection can close; we only need the final URL + may re-fetch.
    await res.arrayBuffer().catch(() => undefined);
    parsedUrl = finalUrl;
    if (!isAppleMusicShareHostname(parsedUrl.hostname)) {
      throw new Error("Apple Music short link did not resolve to an allowlisted host");
    }
  }

  const parsed = parseAppleMusicUrl(parsedUrl.href);

  // Prefer iTunes Lookup for numeric song/album ids (stable, no scrape).
  if (parsed.kind === "song" || parsed.kind === "album") {
    try {
      const viaItunes = await resolveViaItunes(parsed);
      if (viaItunes?.tracks.length) return viaItunes;
    } catch {
      /* fall through */
    }
  }

  // Song links with ?i= should not expand to the full album if lookup failed.
  if (parsed.kind === "song") {
    const viaPage = await resolveViaPageScrape(parsedUrl);
    if (viaPage?.tracks.length === 1) return viaPage;
    if (viaPage?.tracks.length && parsed.songId) {
      // Album page scrape: keep a single best-effort track (first) rather than the whole album.
      return {
        tracks: [viaPage.tracks[0]],
        title: `${viaPage.tracks[0].artist} - ${viaPage.tracks[0].title}`,
      };
    }
    throw new Error("Could not resolve that Apple Music song");
  }

  const viaPage = await resolveViaPageScrape(parsedUrl);
  if (viaPage?.tracks.length) return viaPage;

  throw new Error("Could not resolve any tracks from that Apple Music URL");
}

/** Search YouTube for one Apple Music track; returns a watch URL or null. */
export async function appleMusicTrackToYouTubeUrl(track: AppleMusicTrack): Promise<string | null> {
  const q = [track.artist, track.title, "audio"].filter(Boolean).join(" ").trim();
  if (!q) return null;
  const results = await searchYouTube(q, 1);
  if (!results.length) return null;
  return `https://www.youtube.com/watch?v=${results[0].id}`;
}

/**
 * Resolve Apple Music → YouTube watch URLs (up to maxTracks).
 * Searches YouTube per track; skips tracks with no match.
 */
export async function resolveAppleMusicToYouTubeUrls(
  url: string,
  maxTracks = 25,
): Promise<{ urls: string[]; title?: string }> {
  const resolved = await resolveAppleMusicTracks(url);
  const urls: string[] = [];
  for (const track of resolved.tracks.slice(0, maxTracks)) {
    try {
      const yt = await appleMusicTrackToYouTubeUrl(track);
      if (yt) urls.push(yt);
    } catch {
      /* skip failed searches */
    }
  }
  if (!urls.length) {
    throw new Error("No YouTube matches found for Apple Music tracks");
  }
  return { urls, title: resolved.title };
}
