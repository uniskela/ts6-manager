import { fetchSpotifyPage, isSpotifyShareHostname } from "./youtube.js";

/** One track read from a Spotify playlist or album (artist + title, no Spotify API key). */
export interface SpotifyTrack {
  artist: string;
  title: string;
}

export interface SpotifyCollection {
  kind: "playlist" | "album";
  id: string;
  title?: string;
  tracks: SpotifyTrack[];
}

export type SpotifyLinkKind = "track" | "album" | "playlist" | "other";

/** Spotify IDs are 22 base-62 characters. */
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/**
 * Read `<kind>/<id>` from an open.spotify.com path, ignoring `/intl-xx/` and `/embed/`
 * prefixes. Returns `other` for artists, shows, episodes and anything unrecognised.
 */
export function parseSpotifyPath(pathname: string): { kind: SpotifyLinkKind; id?: string } {
  const parts = pathname.split("/").filter(Boolean);
  while (parts.length && (/^intl-[a-z-]+$/i.test(parts[0]) || parts[0] === "embed")) parts.shift();
  const [kind, id] = parts;
  if ((kind === "track" || kind === "album" || kind === "playlist") && id && SPOTIFY_ID.test(id)) {
    return { kind, id };
  }
  return { kind: "other" };
}

/** Find the first array of embed track entries (objects with `title` + `subtitle`) in parsed JSON. */
function findTrackList(node: unknown, depth = 0): { list: any[]; owner: any } | null {
  if (!node || typeof node !== "object" || depth > 12) return null;
  const obj = node as Record<string, unknown>;
  const direct = obj.trackList;
  if (Array.isArray(direct) && direct.some((t) => t && typeof t.title === "string")) {
    return { list: direct, owner: obj };
  }
  for (const value of Object.values(obj)) {
    const found = findTrackList(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Parse the track list out of a Spotify embed page (`open.spotify.com/embed/<kind>/<id>`).
 * The page carries its data in a `__NEXT_DATA__` JSON script; each `trackList` entry has
 * the song `title` and the artists in `subtitle`.
 */
export function parseSpotifyEmbedTracks(html: string): { title?: string; tracks: SpotifyTrack[] } {
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return { tracks: [] };
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return { tracks: [] };
  }
  const found = findTrackList(data);
  if (!found) return { tracks: [] };

  const tracks: SpotifyTrack[] = [];
  for (const entry of found.list) {
    const title = typeof entry?.title === "string" ? entry.title.trim() : "";
    if (!title) continue;
    const artist = typeof entry.subtitle === "string"
      ? entry.subtitle.replace(/ /g, " ").replace(/\s+/g, " ").trim()
      : "";
    tracks.push({ artist, title });
  }
  const name = found.owner?.name ?? found.owner?.title;
  return { title: typeof name === "string" && name.trim() ? name.trim() : undefined, tracks };
}

/** Parse and validate a user-supplied Spotify URL (https, no credentials, allowlisted host). */
function parseSpotifyShareUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error("Invalid Spotify URL");
  }
  if (!isSpotifyShareHostname(parsed.hostname)) throw new Error("Not a Spotify share URL");
  if (parsed.protocol !== "https:") throw new Error("Invalid Spotify URL protocol: only https is allowed");
  if (parsed.username || parsed.password) throw new Error("URL credentials are not allowed");
  return parsed;
}

/** Work out what a Spotify link points at, following `spotify.link` short links. */
export async function identifySpotifyLink(url: string): Promise<{ kind: SpotifyLinkKind; id?: string }> {
  const parsed = parseSpotifyShareUrl(url);
  const direct = parseSpotifyPath(parsed.pathname);
  if (direct.kind !== "other") return direct;
  // Short links only reveal their target after redirects.
  const { url: finalUrl } = await fetchSpotifyPage(parsed);
  return parseSpotifyPath(finalUrl.pathname);
}

/**
 * Read the tracks of a Spotify playlist or album from its public embed page.
 * Returns null for single tracks (and other non-collection links) so callers keep
 * the one-song path. Throws a readable error when a collection cannot be read,
 * so a playlist never falls back to a song named after it.
 */
export async function resolveSpotifyCollection(url: string): Promise<SpotifyCollection | null> {
  const link = await identifySpotifyLink(url);
  if (link.kind !== "playlist" && link.kind !== "album") return null;
  const kind = link.kind;
  const id = link.id!;

  let parsed: { title?: string; tracks: SpotifyTrack[] } = { tracks: [] };
  try {
    const { response } = await fetchSpotifyPage(new URL(`https://open.spotify.com/embed/${kind}/${id}`));
    if (response.ok) parsed = parseSpotifyEmbedTracks(await response.text());
  } catch {
    /* reported below */
  }
  if (!parsed.tracks.length) {
    throw new Error(
      `Could not read the tracks of that Spotify ${kind}. It may be private or region-locked; try a YouTube or Apple Music link instead.`,
    );
  }
  return { kind, id, title: parsed.title, tracks: parsed.tracks };
}
