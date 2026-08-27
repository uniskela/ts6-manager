import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export interface YouTubeInfo {
  id: string;
  title: string;
  artist: string;
  duration: number; // seconds
  thumbnail: string;
  url: string;
}

export interface YouTubeSearchResult {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
}

export interface ParsedYouTubeUrl {
  videoId?: string;
  listId?: string;
  /** music.youtube.com rewritten to www.youtube.com (or original if not YT). */
  canonicalUrl: string;
  /** Best URL for playlist expansion when listId is present. */
  playlistUrl?: string;
  /** Best single-video watch URL when videoId is present. */
  watchUrl?: string;
}

// Shared cookie file path (set from settings)
let ytCookieFile: string | null = null;

export function setYtCookieFile(filePath: string | null): void {
  ytCookieFile = filePath;
}

export function getYtCookieFile(): string | null {
  return ytCookieFile;
}

export function getCookieArgs(): string[] {
  const args: string[] = ["--remote-components", "ejs:github"];
  if (ytCookieFile) {
    args.push("--cookies", ytCookieFile);
  }
  return args;
}

/** Prefer ERROR lines in yt-dlp stderr (warnings often drown the real failure). */
function summarizeYtDlpStderr(stderr: string, maxLen = 280): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errors = lines.filter((l) => /ERROR:/i.test(l));
  const chosen = errors.length > 0 ? errors : lines;
  const text = chosen.join(" | ");
  return text.slice(0, maxLen) || "unknown yt-dlp error";
}

/**
 * Canonicalize YouTube / YouTube Music URLs before calling yt-dlp.
 * music.youtube.com is rewritten to www.youtube.com (yt-dlp does not support Music natively).
 * Video and playlist ids are taken from standard v= / list= / youtu.be forms.
 */
export function parseYouTubeUrl(raw: string): ParsedYouTubeUrl {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { canonicalUrl: trimmed };
  }

  const host = parsed.hostname.toLowerCase();
  if (!isYouTubeHostname(host)) {
    return { canonicalUrl: trimmed };
  }

  // music.youtube.com / m.youtube.com / bare youtube.com → www.youtube.com
  if (host === "music.youtube.com" || host === "m.youtube.com" || host === "youtube.com") {
    parsed.hostname = "www.youtube.com";
  }

  const href = parsed.toString();
  const listMatch = href.match(/[?&]list=([\w-]+)/i);
  const videoMatch =
    href.match(/[?&]v=([\w-]{11})/i) ||
    href.match(/youtu\.be\/([\w-]{11})/i) ||
    href.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/i);

  const listId = listMatch?.[1];
  const videoId = videoMatch?.[1];

  const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined;
  const playlistUrl = listId ? `https://www.youtube.com/playlist?list=${listId}` : undefined;

  let canonicalUrl = href;
  if (listId && !videoId) {
    canonicalUrl = playlistUrl!;
  } else if (videoId && listId) {
    // Keep list for playlist expansion; watch URL used for single-track download.
    canonicalUrl = `https://www.youtube.com/watch?v=${videoId}&list=${listId}`;
  } else if (videoId) {
    canonicalUrl = watchUrl!;
  } else if (playlistUrl) {
    canonicalUrl = playlistUrl;
  }

  return { videoId, listId, canonicalUrl, playlistUrl, watchUrl };
}

/** Normalize host for allowlist checks (FQDN trailing dots, case). */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** Exact YouTube host match (avoids substring false positives like evil-youtube.com). */
export function isYouTubeHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
}

export function isYouTubeHostUrl(url: string): boolean {
  try {
    return isYouTubeHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Spotify share hosts we are willing to fetch for Open Graph titles. */
export function isSpotifyShareHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return (
    host === "open.spotify.com" ||
    host === "spotify.com" ||
    host === "spotify.link" ||
    host.endsWith(".spotify.com")
  );
}

/**
 * Decode a small set of HTML entities once. Decode `&amp;` last so sequences
 * like `&amp;#39;` cannot be double-unescaped into a quote.
 */
function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/**
 * Fetch a URL while re-validating the host on every redirect hop.
 * `redirect: "follow"` would otherwise allow SSRF via an open redirect off an allowlisted host.
 */
async function fetchAllowlistedUrl(
  initialUrl: URL,
  isAllowedHost: (hostname: string) => boolean,
  maxRedirects = 5,
): Promise<Response> {
  let current = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const host = normalizeHostname(current.hostname);
    // Userinfo can confuse parsers / proxies; never fetch credentialed URLs.
    if (current.username || current.password) {
      throw new Error("URL credentials are not allowed");
    }
    if (!isAllowedHost(host)) {
      throw new Error(`Refusing fetch to disallowed host: ${host}`);
    }
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new Error("Invalid URL protocol");
    }
    // Block obvious local/metadata targets even if somehow allowlisted later.
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "metadata.google.internal" ||
      host.endsWith(".local")
    ) {
      throw new Error(`Refusing fetch to local host: ${host}`);
    }

    const res = await fetch(current.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ts6-manager/1.0)" },
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("Redirect missing Location header");
      }
      // Resolve relative redirect targets against the current URL.
      current = new URL(location, current);
      continue;
    }

    return res;
  }

  throw new Error("Too many redirects while fetching allowlisted URL");
}

function rejectYtDlpOptionUrl(url: string): void {
  if (url.trim().startsWith("-")) {
    throw new Error("Invalid URL: must not start with '-'");
  }
}

/** Append a media URL after yt-dlp's `--` separator to block option injection. */
function withMediaUrl(args: string[], url: string): string[] {
  rejectYtDlpOptionUrl(url);
  return [...args, "--", url];
}

function runYtDlp(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", (err) => reject(new Error(`yt-dlp not found: ${err.message}`)));
  });
}

/** Resolve Spotify track/album/playlist share links to a YouTube search query / best match URL. */
export async function resolveSpotifyToYouTube(url: string): Promise<string> {
  const cleaned = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error("Invalid Spotify URL");
  }

  if (!isSpotifyShareHostname(parsed.hostname)) {
    throw new Error("Not a Spotify share URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Invalid Spotify URL protocol");
  }

  // Fetch Open Graph title from the Spotify page (no Spotify API key required).
  // Redirects are followed manually so each hop stays on an allowlisted Spotify host.
  let title = "";
  try {
    const res = await fetchAllowlistedUrl(parsed, isSpotifyShareHostname);
    const html = await res.text();
    const og =
      html.match(/property="og:title"\s+content="([^"]+)"/i) ||
      html.match(/content="([^"]+)"\s+property="og:title"/i);
    title = og?.[1] ? decodeBasicHtmlEntities(og[1]) : "";
  } catch {
    /* fall through */
  }

  if (!title) {
    title = decodeURIComponent(parsed.pathname.split("/").pop() || "").replace(/-/g, " ");
  }

  const results = await searchYouTube(`${title} audio`, 1);
  if (!results.length) throw new Error(`No YouTube match found for Spotify title: ${title}`);
  return `https://www.youtube.com/watch?v=${results[0].id}`;
}

/**
 * Download audio from a YouTube URL using yt-dlp.
 * Always canonicalizes Music URLs to www.youtube.com/watch?v=… first.
 */
export async function downloadYouTube(
  url: string,
  outputDir: string,
): Promise<{ filePath: string; info: YouTubeInfo }> {
  const parsed = parseYouTubeUrl(url);
  if (parsed.listId && !parsed.videoId) {
    throw new Error(
      "Refusing to download a playlist URL as a single track — expand the playlist first",
    );
  }
  const mediaUrl = parsed.watchUrl || parsed.canonicalUrl;
  const outputTemplate = path.join(outputDir, "%(id)s.%(ext)s");

  const infoResult = await runYtDlp(withMediaUrl([
    ...getCookieArgs(),
    "--no-warnings",
    "--dump-json",
    "--no-playlist",
  ], mediaUrl));

  if (infoResult.code !== 0 && !infoResult.stdout.trim()) {
    throw new Error(`yt-dlp info failed (code ${infoResult.code}): ${summarizeYtDlpStderr(infoResult.stderr)}`);
  }

  let parsedInfo: any;
  try {
    // dump-json may still print warnings on stdout in rare cases — take first JSON object line
    const jsonLine = infoResult.stdout
      .trim()
      .split("\n")
      .find((l) => l.trim().startsWith("{"));
    parsedInfo = JSON.parse(jsonLine || infoResult.stdout);
  } catch {
    throw new Error(
      `Failed to parse yt-dlp output: ${summarizeYtDlpStderr(infoResult.stderr || infoResult.stdout)}`,
    );
  }

  const info: YouTubeInfo = {
    id: parsedInfo.id,
    title: parsedInfo.title || "Unknown",
    artist: parsedInfo.uploader || parsedInfo.channel || "Unknown",
    duration: parsedInfo.duration || 0,
    thumbnail: parsedInfo.thumbnail || "",
    url: mediaUrl,
  };

  const expectedPath = path.join(outputDir, `${info.id}.opus`);

  // Check if already downloaded
  if (fs.existsSync(expectedPath)) {
    return { filePath: expectedPath, info };
  }

  const dlResult = await runYtDlp(withMediaUrl([
    ...getCookieArgs(),
    "--no-warnings",
    "-x", // extract audio
    "--audio-format",
    "opus", // opus format (native for TS3)
    "--audio-quality",
    "0", // best quality
    "--no-playlist",
    "-o",
    outputTemplate,
  ], mediaUrl));

  if (dlResult.code !== 0) {
    throw new Error(`yt-dlp download failed (code ${dlResult.code}): ${summarizeYtDlpStderr(dlResult.stderr)}`);
  }

  // yt-dlp may use different extensions, find the actual file
  const files = fs.readdirSync(outputDir).filter((f) => f.startsWith(info.id));
  if (files.length === 0) {
    throw new Error("Downloaded file not found");
  }

  const filePath = path.join(outputDir, files[files.length - 1]);
  return { filePath, info };
}

/**
 * Get info about a YouTube URL (single video or playlist).
 * Uses flat playlist probe flags (--yes-playlist --flat-playlist --dump-single-json --ignore-errors).
 * Music URLs are rewritten to www.youtube.com before invoking yt-dlp.
 */
export async function getYouTubeUrlInfo(
  url: string,
): Promise<{ type: "video" | "playlist"; items: YouTubeSearchResult[]; title?: string }> {
  const parsed = parseYouTubeUrl(url);
  // Prefer playlist endpoint when a list id is present (Music mixes, playlists).
  const probeUrl = parsed.listId ? parsed.playlistUrl! : parsed.canonicalUrl;

  const result = await runYtDlp(withMediaUrl([
    ...getCookieArgs(),
    "--no-warnings",
    "--yes-playlist",
    "--flat-playlist",
    "--dump-single-json",
    "--ignore-errors",
    "--no-download",
  ], probeUrl));

  const stdout = result.stdout.trim();
  if (!stdout) {
    throw new Error(`yt-dlp info failed (code ${result.code}): ${summarizeYtDlpStderr(result.stderr)}`);
  }

  let data: any;
  try {
    const jsonLine = stdout.split("\n").find((l) => l.trim().startsWith("{")) || stdout;
    data = JSON.parse(jsonLine);
  } catch {
    throw new Error(`Failed to parse yt-dlp output: ${summarizeYtDlpStderr(result.stderr || stdout)}`);
  }

  const entries: any[] = Array.isArray(data.entries)
    ? data.entries.filter((e: any) => e && e.id)
    : [];

  if (entries.length > 0) {
    const items: YouTubeSearchResult[] = entries.map((entry) => ({
      id: entry.id,
      title: entry.title || "Unknown",
      artist: entry.uploader || entry.channel || entry.artists?.[0] || "Unknown",
      duration: entry.duration || 0,
      thumbnail: entry.thumbnails?.[0]?.url || entry.thumbnail || "",
    }));
    return {
      type: items.length > 1 ? "playlist" : "video",
      items,
      title: data.title || undefined,
    };
  }

  // Single video dump
  if (data.id) {
    return {
      type: "video",
      title: data.title || undefined,
      items: [
        {
          id: data.id,
          title: data.title || "Unknown",
          artist: data.uploader || data.channel || "Unknown",
          duration: data.duration || 0,
          thumbnail: data.thumbnails?.[0]?.url || data.thumbnail || "",
        },
      ],
    };
  }

  // Fallback: if we already parsed a video id, return it without requiring yt-dlp metadata
  if (parsed.videoId) {
    return {
      type: "video",
      items: [
        {
          id: parsed.videoId,
          title: "Unknown",
          artist: "Unknown",
          duration: 0,
          thumbnail: "",
        },
      ],
    };
  }

  throw new Error(`yt-dlp info failed (code ${result.code}): ${summarizeYtDlpStderr(result.stderr)}`);
}

/**
 * Expand a YouTube / YouTube Music URL into concrete watch?v= URLs (capped).
 * Used by play-url and chat !play so Music playlist links never hit --no-playlist.
 */
export async function expandYouTubeToWatchUrls(
  url: string,
  cap = 25,
): Promise<{ type: "video" | "playlist"; urls: string[]; title?: string }> {
  const parsed = parseYouTubeUrl(url);

  if (parsed.listId || !parsed.videoId) {
    try {
      const info = await getYouTubeUrlInfo(url);
      if (info.items.length > 0) {
        return {
          type: info.type,
          title: info.title,
          urls: info.items.slice(0, cap).map((item) => `https://www.youtube.com/watch?v=${item.id}`),
        };
      }
    } catch {
      // Fall through to single-video canonicalization when possible.
    }
  }

  if (parsed.videoId) {
    return {
      type: "video",
      urls: [`https://www.youtube.com/watch?v=${parsed.videoId}`],
    };
  }

  // Last resort: try probe anyway
  const info = await getYouTubeUrlInfo(parsed.canonicalUrl);
  return {
    type: info.type,
    title: info.title,
    urls: info.items.slice(0, cap).map((item) => `https://www.youtube.com/watch?v=${item.id}`),
  };
}

/**
 * Search YouTube using yt-dlp
 */
export async function searchYouTube(query: string, maxResults: number = 10): Promise<YouTubeSearchResult[]> {
  if (query.trim().startsWith("-")) {
    throw new Error("Invalid search query");
  }
  const result = await runYtDlp([
    ...getCookieArgs(),
    "--no-warnings",
    `ytsearch${maxResults}:${query}`,
    "--dump-json",
    "--flat-playlist",
    "--no-download",
  ]);

  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(`yt-dlp search failed (code ${result.code}): ${summarizeYtDlpStderr(result.stderr)}`);
  }

  try {
    // yt-dlp outputs one JSON object per line
    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line);
        return {
          id: parsed.id,
          title: parsed.title || "Unknown",
          artist: parsed.uploader || parsed.channel || "Unknown",
          duration: parsed.duration || 0,
          thumbnail: parsed.thumbnails?.[0]?.url || "",
        };
      });
  } catch {
    return [];
  }
}
