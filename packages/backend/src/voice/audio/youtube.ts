import { parseDownloadProgress, type ProgressUpdate } from './download-progress.js';
import { spawnYtDlp, ytDlpTarget } from './yt-dlp-process.js';
import { cacheKey, identityFromInfo, MAX_CACHE_FILE_BYTES, MediaCacheError, mediaCacheFor } from './media-cache.js';
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

/** Permissive best-audio chain — ffmpeg converts whatever we get in the audio pipeline. */
const YT_AUDIO_FORMAT = "ba/b/bestaudio/best";

/** Rotate YouTube player clients to reduce bot-check and empty-format failures. */
const YT_EXTRACTOR_CLIENT_ROTATION = [
  "tv_embedded,web,default",
  "web,default",
  "tv_embedded",
  "android_vr,web",
] as const;

function buildYtDlpBaseArgs(playerClients: string): string[] {
  const args: string[] = [
    "--remote-components",
    "ejs:github",
    "--extractor-args",
    `youtube:player_client=${playerClients}`,
  ];
  if (ytCookieFile) {
    args.push("--cookies", ytCookieFile);
  }
  return args;
}

export function getCookieArgs(): string[] {
  return buildYtDlpBaseArgs(YT_EXTRACTOR_CLIENT_ROTATION[0]);
}

function formatYtDlpFailure(phase: string, code: number | null, stderr: string): string {
  const summary = summarizeYtDlpStderr(stderr);
  if (/sign in to confirm|not a bot/i.test(stderr) && !ytCookieFile) {
    return `${phase} (code ${code}): ${summary}. Add YouTube cookies in Settings → YouTube (or YT_COOKIE_FILE) to bypass bot checks.`;
  }
  return `${phase} (code ${code}): ${summary}`;
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

/** Exact Spotify hosts allowed for Open Graph title fetches (no wildcard suffixes). */
type SpotifyFetchHost =
  | "open.spotify.com"
  | "www.spotify.com"
  | "spotify.com"
  | "spotify.link"
  | "play.spotify.com";

/**
 * Map a hostname to an allowlisted Spotify host constant.
 * Returning string literals (not the input) keeps the fetch target host untainted for SSRF analysis.
 */
export function resolveSpotifyFetchHost(hostname: string): SpotifyFetchHost | null {
  switch (normalizeHostname(hostname)) {
    case "open.spotify.com":
      return "open.spotify.com";
    case "www.spotify.com":
      return "www.spotify.com";
    case "spotify.com":
      return "spotify.com";
    case "spotify.link":
      return "spotify.link";
    case "play.spotify.com":
      return "play.spotify.com";
    default:
      return null;
  }
}

/** Spotify share hosts we are willing to fetch for Open Graph titles. */
export function isSpotifyShareHostname(hostname: string): boolean {
  return resolveSpotifyFetchHost(hostname) !== null;
}

/** True for Spotify share links that must be resolved before yt-dlp sees them. */
export function isSpotifyShareUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/\.+$/, "");
    return host === "spotify.com" || host.endsWith(".spotify.com") || host === "spotify.link";
  } catch {
    return false;
  }
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
 * Rebuild an https URL on an allowlisted host. Path/query are taken from the
 * parsed URL; scheme, host, userinfo, and hash are not taken from user input.
 */
function buildSpotifyFetchUrl(allowedHost: SpotifyFetchHost, from: URL): URL {
  const safe = new URL(`https://${allowedHost}`);
  safe.pathname = from.pathname;
  safe.search = from.search;
  return safe;
}

/**
 * Fetch a Spotify share URL while re-validating the host on every redirect hop.
 * The request URL is rebuilt from an allowlisted host constant (not the raw user URL)
 * so redirects cannot pivot SSRF off an open redirect.
 */
async function fetchSpotifyOgPage(initialUrl: URL, maxRedirects = 5, signal?: AbortSignal): Promise<Response> {
  return (await fetchSpotifyPage(initialUrl, maxRedirects, signal)).response;
}

/**
 * Same as {@link fetchSpotifyOgPage}, also returning the final allowlisted URL after
 * redirects (short `spotify.link` URLs land on `open.spotify.com/<kind>/<id>`).
 */
export async function fetchSpotifyPage(
  initialUrl: URL,
  maxRedirects = 5,
  signal?: AbortSignal,
): Promise<{ response: Response; url: URL }> {
  let current = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.username || current.password) {
      throw new Error("URL credentials are not allowed");
    }
    if (current.protocol !== "https:") {
      throw new Error("Invalid URL protocol: only https is allowed");
    }

    const allowedHost = resolveSpotifyFetchHost(current.hostname);
    if (!allowedHost) {
      throw new Error(`Refusing fetch to disallowed host: ${normalizeHostname(current.hostname)}`);
    }

    const safeUrl = buildSpotifyFetchUrl(allowedHost, current);
    const res = await fetch(safeUrl.href, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ts6-manager/1.0)" },
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("Redirect missing Location header");
      }
      // Resolve relative redirect targets against the *safe* URL (https + allowlisted host).
      current = new URL(location, safeUrl);
      continue;
    }

    return { response: res, url: safeUrl };
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

/** Longest one yt-dlp process may run. */
const YT_DLP_TIMEOUT_MS = 180_000;

/**
 * Bound all downloader/playlist jobs, including listener requests without caller cancellation.
 * On POSIX yt-dlp runs in its own process group, and a timeout or cancellation kills the whole
 * group, so an ffmpeg it started for conversion stops with it instead of writing on afterwards.
 */
async function runYtDlp(
  args: string[],
  onProgress?: (p: ProgressUpdate) => void,
  signal?: AbortSignal,
  /** What the run fetches, when no URL follows `--` (a download from a saved info document). */
  target?: string,
): Promise<{ code: number | null; stdout: string; stderr: string; stdoutTruncated: boolean }> {
  signal?.throwIfAborted();
  // Own process group on POSIX; Windows has no process groups to kill, so it keeps the old behaviour.
  const group = process.platform !== "win32";
  const { proc, redact } = await spawnYtDlp(args, { target: target ?? ytDlpTarget(args), timeoutMs: YT_DLP_TIMEOUT_MS, detached: group });
  return new Promise((resolve, reject) => {
    let running = true;
    const killTree = () => {
      if (!running || proc.pid === undefined) return;
      if (!group) { proc.kill("SIGKILL"); return; }
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    };
    const timer = setTimeout(killTree, YT_DLP_TIMEOUT_MS);
    signal?.addEventListener("abort", killTree, { once: true });
    // Cancelled while the job's proxy access was being set up.
    if (signal?.aborted) killTree();
    const finished = () => {
      running = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", killTree);
    };
    let stdout = "";
    let stderr = "";
    const pending = { stdout: '', stderr: '' };
    const consumeProgress = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (!onProgress) return;
      pending[stream] += chunk.toString();
      const lines = pending[stream].split(/\r?\n/);
      pending[stream] = (lines.pop() || '').slice(-16384);
      for (const line of lines) {
        const progress = parseDownloadProgress(line);
        if (progress) onProgress(progress);
      }
    };
    let stdoutTruncated = false;
    proc.stdout.on("data", (chunk: Buffer) => {
      const joined = stdout + chunk.toString();
      if (joined.length > 8 * 1024 * 1024) stdoutTruncated = true;
      stdout = joined.slice(-8 * 1024 * 1024);
      consumeProgress('stdout', chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
      consumeProgress('stderr', chunk);
    });
    proc.on("close", (code) => {
      finished();
      if (signal?.aborted) reject(signal.reason);
      else resolve({ code, stdout: redact(stdout), stderr: redact(stderr), stdoutTruncated });
    });
    proc.on("error", (err) => {
      finished();
      reject(signal?.aborted ? signal.reason : new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}

/** Resolve Spotify track/album/playlist share links to a YouTube search query / best match URL. */
export async function resolveSpotifyToYouTube(url: string, signal?: AbortSignal): Promise<string> {
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
  if (parsed.protocol !== "https:") {
    throw new Error("Invalid Spotify URL protocol: only https is allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL credentials are not allowed");
  }

  // Fetch Open Graph tags from the Spotify page (no Spotify API key required).
  // Redirects are followed manually; each hop is rebuilt onto an allowlisted https host.
  let query = "";
  try {
    const res = await fetchSpotifyOgPage(parsed, undefined, signal);
    query = spotifySearchQueryFromOg(await res.text());
  } catch {
    /* fall through */
  }

  if (!query) {
    query = decodeURIComponent(parsed.pathname.split("/").pop() || "").replace(/-/g, " ");
  }

  signal?.throwIfAborted();
  const song = await findSongForQuery(query, undefined, signal);
  if (!song) throw new Error(`No YouTube match found for Spotify title: ${query}`);
  return song.url;
}

/** Read one Open Graph `content` value from a page (either attribute order). */
function readOgContent(html: string, property: "title" | "description"): string {
  // Same <meta> tag, attributes in either order, other attributes allowed in between.
  const og = html.match(
    new RegExp(`<meta\\b(?=[^>]*\\bproperty="og:${property}")[^>]*\\bcontent="([^"]*)"`, "i"),
  );
  return og?.[1] ? decodeBasicHtmlEntities(og[1]).trim() : "";
}

/**
 * Build a search query from a Spotify page's Open Graph tags. Track pages describe
 * themselves as `Artist · Song · 1987`, so the artist is added to the title when present.
 */
export function spotifySearchQueryFromOg(html: string): string {
  const title = readOgContent(html, "title");
  if (!title) return "";
  const parts = readOgContent(html, "description").split("·").map((p) => p.trim());
  const artist = parts.length >= 2 && /^song$/i.test(parts[1]) ? parts[0] : "";
  return artist ? `${artist} ${title}` : title;
}

/**
 * Metadata for one track, trying the YouTube player clients in turn. The
 * output must hold exactly one item; a client that returns no downloadable
 * formats is skipped, so the download can use the next one.
 */
/** True when the metadata offers something to download besides storyboard images. */
function hasPlayableFormat(info: Record<string, unknown>): boolean {
  if (typeof info.url === "string" && info.ext !== "mhtml") return true;
  if (!Array.isArray(info.formats)) return false;
  return info.formats.some((format: { ext?: unknown; protocol?: unknown; format_note?: unknown }) =>
    format?.ext !== "mhtml" && format?.protocol !== "mhtml" && format?.format_note !== "storyboard");
}

async function ytDlpDumpJson(mediaUrl: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let lastCode: number | null = null;
  let lastStderr = "";

  for (const clients of YT_EXTRACTOR_CLIENT_ROTATION) {
    const infoResult = await runYtDlp(
      withMediaUrl(
        [
          ...buildYtDlpBaseArgs(clients),
          "--no-warnings",
          "--dump-json",
          "--no-playlist",
          "--ignore-no-formats-error",
        ],
        mediaUrl,
      ), undefined, signal,
    );

    lastCode = infoResult.code;
    lastStderr = infoResult.stderr;

    // Output that did not fit, or a record that does not parse, cannot prove there is only one item.
    if (infoResult.stdoutTruncated) throw new MediaCacheError("The link's metadata is too large.");
    const records: Record<string, unknown>[] = [];
    for (const line of infoResult.stdout.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        throw new MediaCacheError("The link's metadata could not be read.");
      }
    }
    // More than one item means a playlist or a multi-item page, never one track.
    if (records.length > 1) throw new MediaCacheError("The link is not a single track.");
    const info = records[0];
    if (!info || typeof info.id !== "string") continue;
    if (hasPlayableFormat(info)) return info;
  }

  throw new Error(formatYtDlpFailure("yt-dlp info failed", lastCode, lastStderr));
}

/**
 * Download the audio described by a saved info document into `stagingDir`,
 * trying the format strategies in turn. Downloading from the document means
 * the download uses exactly the metadata that was checked. Returns the lines
 * yt-dlp printed for its final file.
 */
async function ytDlpDownloadAudio(
  infoFile: string,
  stagingDir: string,
  mediaUrl: string,
  onProgress?: (p: ProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  const formatStrategies: string[][] = [
    ["-f", YT_AUDIO_FORMAT, "-x", "--audio-quality", "0"],
    ["-f", YT_AUDIO_FORMAT],
    ["-f", "b/best"],
  ];

  let lastCode: number | null = null;
  let lastStderr = "";

  for (const fmtArgs of formatStrategies) {
    // A failed attempt may leave partial files; each attempt starts from an empty folder.
    for (const name of await fs.promises.readdir(stagingDir)) {
      if (name !== "info.json") await fs.promises.rm(path.join(stagingDir, name), { recursive: true, force: true });
    }
    const dlResult = await runYtDlp(
      [
        ...getCookieArgs(),
        "--no-warnings",
        "--newline", "--progress",
        "--progress-template", 'download:ts6-progress:%(progress)j',
        "--progress-template", 'postprocess:ts6-processing',
        ...fmtArgs,
        "--no-playlist",
        "--max-filesize", `${MAX_CACHE_FILE_BYTES}`,
        "--load-info-json", infoFile,
        "-o", path.join(stagingDir, "media.%(ext)s"),
        "--print", "after_move:filepath",
      ],
      onProgress, signal, mediaUrl,
    );

    lastCode = dlResult.code;
    lastStderr = dlResult.stderr;

    if (dlResult.code === 0) {
      return dlResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^ts6-(progress|processing)/.test(line) && !line.startsWith("["));
    }
  }

  throw new Error(formatYtDlpFailure("yt-dlp download failed", lastCode, lastStderr));
}

/**
 * Download audio for a URL into the music folder's download cache, or reuse
 * the cached file for the same source. YouTube Music URLs are canonicalised to
 * www.youtube.com/watch?v=… first. The cache never reuses files outside its
 * own folder (see media-cache.ts).
 */
export async function downloadYouTube(
  url: string,
  outputDir: string,
  onProgress?: (p: ProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<{ filePath: string; info: YouTubeInfo }> {
  const parsed = parseYouTubeUrl(url);
  if (parsed.listId && !parsed.videoId) {
    throw new Error(
      "Refusing to download a playlist URL as a single track — expand the playlist first",
    );
  }
  const mediaUrl = parsed.watchUrl || parsed.canonicalUrl;

  const parsedInfo = await ytDlpDumpJson(mediaUrl, signal);
  // The identity comes from what the backend parsed, checked against the metadata.
  const identity = identityFromInfo(
    { youtubeVideoId: parsed.videoId && isYouTubeHostUrl(mediaUrl) ? parsed.videoId : undefined, url: mediaUrl },
    parsedInfo,
  );

  const duration = typeof parsedInfo.duration === "number" && parsedInfo.duration > 0 ? parsedInfo.duration : 0;
  const info: YouTubeInfo = {
    id: String(parsedInfo.id),
    title: (parsedInfo.title as string) || "Unknown",
    artist: (parsedInfo.uploader as string) || (parsedInfo.channel as string) || "Unknown",
    duration,
    thumbnail: (parsedInfo.thumbnail as string) || "",
    url: mediaUrl,
  };

  const filePath = await mediaCacheFor(outputDir).fetch<ProgressUpdate>(cacheKey(identity), async (stagingDir, jobSignal, report) => {
    const infoFile = path.join(stagingDir, "info.json");
    // Private: it can hold signed media links and, with cookies configured, cookie values.
    await fs.promises.writeFile(infoFile, JSON.stringify(parsedInfo), { flag: "wx", mode: 0o600 });
    const reportedPaths = await ytDlpDownloadAudio(infoFile, stagingDir, mediaUrl, report, jobSignal);
    return {
      reportedPaths,
      expectedDurationSec: duration > 0 ? duration : null,
      kind: identity.kind,
      extractor: String(parsedInfo.extractor_key),
    };
  }, { signal, onProgress });

  return { filePath, info };
}

/** Resolve a direct audio stream URL for YouTube without downloading (prankroker approach). */
export async function resolveYouTubeAudioStream(
  url: string,
): Promise<{ streamUrl: string; info: YouTubeInfo }> {
  const parsed = parseYouTubeUrl(url);
  const mediaUrl = parsed.watchUrl || parsed.canonicalUrl;
  const result = await runYtDlp(withMediaUrl([
    ...getCookieArgs(),
    '--no-warnings',
    '--no-playlist',
    // A single file over HTTP(S), never a playlist: the backend's ffmpeg plays this URL.
    '-f', "ba[protocol~='^https?$']/b[protocol~='^https?$']",
    '--dump-single-json',
    '--no-download',
  ], mediaUrl));

  if (result.code !== 0) {
    throw new Error(`yt-dlp stream resolve failed: ${summarizeYtDlpStderr(result.stderr)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result.stdout.trim().split('\n').find((l) => l.startsWith('{')) || result.stdout.trim());
  } catch {
    throw new Error('Failed to parse yt-dlp stream output');
  }

  const streamUrl = typeof data.url === 'string' ? data.url : '';
  if (!streamUrl) throw new Error('No stream URL in yt-dlp output');

  const info: YouTubeInfo = {
    id: String(data.id ?? parsed.videoId ?? ''),
    title: (data.title as string) || 'Unknown',
    artist: (data.uploader as string) || (data.channel as string) || 'Unknown',
    duration: (data.duration as number) || 0,
    thumbnail: (data.thumbnail as string) || '',
    url: mediaUrl,
  };

  return { streamUrl, info };
}

/**
 * Lightweight metadata lookup for a single YouTube video id (no download).
 * Used when scanning `%(id)s.ext` files that were downloaded without library rows.
 */
export async function fetchYouTubeVideoMeta(
  videoId: string,
): Promise<{ title: string; artist: string; duration: number; url: string } | null> {
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  const mediaUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const infoResult = await runYtDlp(
    withMediaUrl(
      [
        ...getCookieArgs(),
        "--no-warnings",
        "--dump-json",
        "--no-playlist",
        "--no-download",
        "--ignore-no-formats-error",
      ],
      mediaUrl,
    ),
  );
  if (infoResult.code !== 0 && !infoResult.stdout.trim()) return null;
  try {
    const jsonLine = infoResult.stdout
      .trim()
      .split("\n")
      .find((l) => l.trim().startsWith("{"));
    const parsedInfo = JSON.parse(jsonLine || infoResult.stdout);
    return {
      title: parsedInfo.title || videoId,
      artist: parsedInfo.uploader || parsedInfo.channel || "Unknown",
      duration: parsedInfo.duration || 0,
      url: mediaUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Get info about a YouTube URL (single video or playlist).
 * Uses flat playlist probe flags (--yes-playlist --flat-playlist --dump-single-json --ignore-errors).
 * Music URLs are rewritten to www.youtube.com before invoking yt-dlp.
 */
export async function getYouTubeUrlInfo(
  url: string,
  signal?: AbortSignal,
): Promise<{ type: "video" | "playlist"; items: YouTubeSearchResult[]; title?: string }> {
  // Apple Music / Spotify must be resolved before yt-dlp — never pass them through.
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/\.+$/, "");
    if (
      host === "music.apple.com" ||
      host === "itunes.apple.com" ||
      host === "geo.itunes.apple.com" ||
      host === "apple.co" ||
      host === "open.spotify.com" ||
      host === "spotify.com" ||
      host.endsWith(".spotify.com") ||
      host === "spotify.link"
    ) {
      throw new Error(
        `Unsupported URL for yt-dlp info: ${host} — resolve Apple Music / Spotify before probing`,
      );
    }
  } catch (err) {
    if (err instanceof TypeError) {
      /* invalid URL — let yt-dlp path handle */
    } else {
      throw err;
    }
  }

  const parsed = parseYouTubeUrl(url);
  // Only probe as playlist when the URL is a bare playlist (no v=). Video URLs
  // with &list= (opened from a playlist or Mix) must stay single-track.
  const probeUrl =
    parsed.listId && !parsed.videoId
      ? (parsed.playlistUrl ?? parsed.canonicalUrl)
      : (parsed.watchUrl ?? parsed.canonicalUrl);

  const result = await runYtDlp(withMediaUrl([
    ...getCookieArgs(),
    "--no-warnings",
    "--yes-playlist",
    "--flat-playlist",
    "--dump-single-json",
    "--ignore-errors",
    "--no-download",
  ], probeUrl), undefined, signal);

  const stdout = result.stdout.trim();
  if (!stdout) {
    if (parsed.videoId) {
      return {
        type: "video",
        items: [{
          id: parsed.videoId,
          title: "Unknown",
          artist: "Unknown",
          duration: 0,
          thumbnail: "",
        }],
      };
    }
    throw new Error(`yt-dlp info failed (code ${result.code}): ${summarizeYtDlpStderr(result.stderr)}`);
  }

  const mapped = mapYtDlpInfoJson(stdout, parsed.videoId);
  if (mapped) return mapped;

  throw new Error(`yt-dlp info failed (code ${result.code}): ${summarizeYtDlpStderr(result.stderr)}`);
}

/** Parse yt-dlp JSON stdout into search results; null-safe when dump is `null` / malformed. */
export function mapYtDlpInfoJson(
  stdout: string,
  fallbackVideoId?: string,
): { type: "video" | "playlist"; items: YouTubeSearchResult[]; title?: string } | null {
  let data: any = null;
  try {
    const jsonLine = stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("{") || l === "null") || stdout.trim();
    data = JSON.parse(jsonLine);
  } catch {
    // Fall through to NDJSON / video-id fallbacks below.
  }

  // dump-single-json can print literal `null` when extraction fails with --ignore-errors.
  if (data != null && typeof data === "object") {
    const rawEntries = (data as { entries?: unknown }).entries;
    const entries: any[] = Array.isArray(rawEntries)
      ? rawEntries.filter((e: any) => e && e.id)
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
  }

  // NDJSON fallback: one JSON object per line (some yt-dlp modes).
  const ndjsonItems: YouTubeSearchResult[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj.id && !Array.isArray(obj.entries)) {
        ndjsonItems.push({
          id: obj.id,
          title: obj.title || "Unknown",
          artist: obj.uploader || obj.channel || "Unknown",
          duration: obj.duration || 0,
          thumbnail: obj.thumbnails?.[0]?.url || obj.thumbnail || "",
        });
      }
    } catch {
      /* skip bad line */
    }
  }
  if (ndjsonItems.length > 0) {
    return {
      type: ndjsonItems.length > 1 ? "playlist" : "video",
      items: ndjsonItems,
    };
  }

  if (fallbackVideoId) {
    return {
      type: "video",
      items: [
        {
          id: fallbackVideoId,
          title: "Unknown",
          artist: "Unknown",
          duration: 0,
          thumbnail: "",
        },
      ],
    };
  }

  return null;
}

/**
 * Expand a YouTube / YouTube Music URL into concrete watch?v= URLs (capped).
 * Used by play-url and chat !play so Music playlist links never hit --no-playlist.
 */
export async function expandYouTubeToWatchUrls(
  url: string,
  cap = 25,
  signal?: AbortSignal,
): Promise<{
  type: "video" | "playlist";
  urls: string[];
  title?: string;
  /** Per-entry details from the playlist probe, in the order of `urls`. */
  items?: Array<{ url: string; title?: string; durationSec?: number }>;
}> {
  const parsed = parseYouTubeUrl(url);

  // Expand only bare playlist URLs. A video with &list= plays that video only.
  const isPlaylist = parsed.listId && !parsed.videoId;

  if (isPlaylist) {
    try {
      const info = await getYouTubeUrlInfo(url, signal);
      if (info.items.length > 0) {
        const items = info.items.slice(0, cap).map((item) => ({
          url: `https://www.youtube.com/watch?v=${item.id}`,
          title: item.title || undefined,
          durationSec: item.duration > 0 ? item.duration : undefined,
        }));
        return {
          type: info.type,
          title: info.title,
          urls: items.map((item) => item.url),
          items,
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

  // Last resort: probe again; never throw a raw TypeError from null JSON.
  signal?.throwIfAborted();
  try {
    const info = await getYouTubeUrlInfo(parsed.canonicalUrl, signal);
    if (info.items.length > 0) {
      return {
        type: info.type,
        title: info.title,
        urls: info.items.slice(0, cap).map((item) => `https://www.youtube.com/watch?v=${item.id}`),
      };
    }
  } catch (err) {
    throw new Error(
      `Could not resolve YouTube URL: ${(err as Error).message || String(err)}`,
    );
  }

  throw new Error("Could not resolve any videos from that YouTube URL");
}

/**
 * Search YouTube using yt-dlp, aborting the process when the caller cancels.
 */
export async function searchYouTube(query: string, maxResults: number = 10, signal: AbortSignal = AbortSignal.timeout(180_000)): Promise<YouTubeSearchResult[]> {
  signal?.throwIfAborted();
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
  ], undefined, signal);
  signal?.throwIfAborted();

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

/** YouTube Music search URL limited to the Songs section (handled by yt-dlp's music search extractor). */
export function youTubeMusicSongSearchUrl(query: string): string {
  return `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`;
}

/** Map one line of yt-dlp `--flat-playlist --dump-json` output; null when it is not a usable entry. */
function mapFlatSearchEntry(line: string): YouTubeSearchResult | null {
  try {
    const entry = JSON.parse(line);
    if (!entry || typeof entry.id !== "string" || !entry.id) return null;
    return {
      id: entry.id,
      title: entry.title || "Unknown",
      artist:
        (Array.isArray(entry.artists) && entry.artists[0]) ||
        entry.artist ||
        entry.uploader ||
        entry.channel ||
        "Unknown",
      duration: entry.duration || 0,
      thumbnail: entry.thumbnails?.[0]?.url || entry.thumbnail || "",
    };
  } catch {
    return null;
  }
}

/** Search YouTube Music songs (best match first), aborting yt-dlp on cancellation. */
export async function searchYouTubeMusic(query: string, maxResults: number = 5, signal: AbortSignal = AbortSignal.timeout(180_000)): Promise<YouTubeSearchResult[]> {
  signal?.throwIfAborted();
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Invalid search query");
  const result = await runYtDlp(withMediaUrl([
    ...getCookieArgs(),
    "--no-warnings",
    "--flat-playlist",
    "--dump-json",
    "--no-download",
    "--playlist-items",
    `1-${Math.max(1, Math.floor(maxResults))}`,
  ], youTubeMusicSongSearchUrl(trimmed)), undefined, signal);
  signal?.throwIfAborted();

  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(`yt-dlp music search failed (code ${result.code}): ${summarizeYtDlpStderr(result.stderr)}`);
  }

  return parseFlatSearchOutput(result.stdout);
}

/** Parse yt-dlp `--flat-playlist --dump-json` output (one JSON entry per line). */
export function parseFlatSearchOutput(stdout: string): YouTubeSearchResult[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map(mapFlatSearchEntry)
    .filter((item): item is YouTubeSearchResult => item !== null);
}

/** Search entries must be single videos (11-char IDs), not channels or playlists. */
function isPlayableSearchResult(item: YouTubeSearchResult): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(item.id);
}

export interface SongSearchDeps {
  searchMusic: (query: string, signal?: AbortSignal) => Promise<YouTubeSearchResult[]>;
  searchVideos: (query: string, signal?: AbortSignal) => Promise<YouTubeSearchResult[]>;
}

/**
 * Find the most relevant song for a free-text query: the top YouTube Music song result,
 * falling back to the top regular YouTube result when Music returns nothing or fails.
 * Cancellation stops the search without starting a fallback or returning stale results.
 */
export async function findSongForQuery(
  query: string,
  deps: SongSearchDeps = {
    searchMusic: (q, signal) => searchYouTubeMusic(q, 1, signal),
    searchVideos: (q, signal) => searchYouTube(q, 1, signal),
  },
  signal?: AbortSignal,
): Promise<(YouTubeSearchResult & { url: string; source: "youtube-music" | "youtube" }) | null> {
  signal?.throwIfAborted();
  const trimmed = query.trim();
  if (!trimmed) return null;

  try {
    const results = await deps.searchMusic(trimmed, signal);
    signal?.throwIfAborted();
    const top = results.find(isPlayableSearchResult);
    if (top) return { ...top, url: `https://www.youtube.com/watch?v=${top.id}`, source: "youtube-music" };
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.warn("[YouTube] Music search failed, falling back to YouTube search:", (err as Error)?.message ?? err);
  }

  signal?.throwIfAborted();
  const results = await deps.searchVideos(trimmed, signal);
  signal?.throwIfAborted();
  const top = results.find(isPlayableSearchResult);
  if (top) return { ...top, url: `https://www.youtube.com/watch?v=${top.id}`, source: "youtube" };
  return null;
}

/** Best YouTube watch URL for an artist + title pair (Apple Music / Spotify tracks), or null. */
export async function trackToYouTubeUrl(track: { artist?: string; title: string }, signal?: AbortSignal): Promise<string | null> {
  const query = [track.artist, track.title].filter(Boolean).join(" ").trim();
  if (!query) return null;
  return (await findSongForQuery(query, undefined, signal))?.url ?? null;
}
