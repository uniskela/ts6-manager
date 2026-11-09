import { spawnYtDlp, ytDlpTarget } from './yt-dlp-process.js';
import { parseFlatSearchOutput, youTubeMusicSongSearchUrl, type YouTubeSearchResult } from './youtube.js';

/** Listener remote max track length. Admin and chat playback do not use this. */
export const LISTENER_MAX_DURATION_SEC = 15 * 60;

export type ListenerDurationRefusal = 'too_long' | 'live_not_allowed' | 'unknown_duration';

export type ListenerDurationVerdict =
  | { ok: true; durationSec: number }
  | { ok: false; reason: ListenerDurationRefusal };

/** Metadata available before a download starts (search row or yt-dlp dump). */
export interface ListenerTrackMeta {
  durationSec?: number | null;
  isLive?: boolean | null;
  liveStatus?: string | null;
}

export function isListenerLive(meta: ListenerTrackMeta): boolean {
  return meta.isLive === true || meta.liveStatus === 'is_live';
}

/**
 * Refuse listener tracks that are live, longer than 15 minutes, or of unknown
 * length. Call before download (C1a / C2).
 */
export function checkListenerDuration(meta: ListenerTrackMeta): ListenerDurationVerdict {
  if (isListenerLive(meta)) return { ok: false, reason: 'live_not_allowed' };
  const durationSec = meta.durationSec;
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, reason: 'unknown_duration' };
  }
  if (durationSec > LISTENER_MAX_DURATION_SEC) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, durationSec };
}

/** Map one yt-dlp `--dump-single-json` object into listener duration metadata. */
export function listenerTrackMetaFromYtDlp(data: Record<string, unknown>): ListenerTrackMeta {
  const raw = typeof data.duration === 'number' ? data.duration : NaN;
  return {
    isLive: data.is_live === true || data.live_status === 'is_live',
    liveStatus: typeof data.live_status === 'string' ? data.live_status : null,
    durationSec: Number.isFinite(raw) && raw > 0 ? raw : null,
  };
}

export interface ListenerSearchResult {
  id: string;
  title: string;
  artist: string;
  durationSec: number | null;
  thumbnail: string;
  url: string;
  isLive?: boolean;
  liveStatus?: string | null;
}

const PLAYABLE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function toListenerResult(item: YouTubeSearchResult): ListenerSearchResult | null {
  if (!PLAYABLE_VIDEO_ID.test(item.id)) return null;
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    durationSec: item.duration > 0 ? item.duration : null,
    thumbnail: item.thumbnail,
    url: `https://www.youtube.com/watch?v=${item.id}`,
    isLive: item.isLive === true,
    liveStatus: item.liveStatus ?? null,
  };
}

/** True when a flat row already has verified, non-live duration usable for listener search. */
export function listenerSearchRowHasVerifiedDuration(row: ListenerSearchResult): boolean {
  return checkListenerDuration({
    durationSec: row.durationSec,
    isLive: row.isLive,
    liveStatus: row.liveStatus,
  }).ok;
}

const LISTENER_YT_DLP_BASE = [
  '--remote-components',
  'ejs:github',
  '--extractor-args',
  'youtube:player_client=tv_embedded,web,default',
  '--no-warnings',
  '--flat-playlist',
  '--dump-json',
  '--no-download',
] as const;

/**
 * Cookie-free yt-dlp args for a YouTube Music Songs search.
 * Never includes `--cookies`, even when an admin cookie file is configured.
 */
export function listenerMusicSearchArgs(query: string, maxResults: number): string[] {
  const trimmed = query.trim();
  if (!trimmed || trimmed.startsWith('-')) throw new Error('Invalid search query');
  const n = Math.max(1, Math.floor(maxResults));
  return [
    ...LISTENER_YT_DLP_BASE,
    '--playlist-items',
    `1-${n}`,
    '--',
    youTubeMusicSongSearchUrl(trimmed),
  ];
}

/**
 * Cookie-free yt-dlp args for regular YouTube search (`ytsearchN:`).
 * Used when Music flat rows lack verified duration. Never includes `--cookies`.
 */
export function listenerYouTubeSearchArgs(query: string, maxResults: number): string[] {
  const trimmed = query.trim();
  if (!trimmed || trimmed.startsWith('-')) throw new Error('Invalid search query');
  const n = Math.max(1, Math.floor(maxResults));
  return [
    ...LISTENER_YT_DLP_BASE,
    `ytsearch${n}:${trimmed}`,
  ];
}

export interface ListenerMusicSearchDump {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ListenerMusicSearchDeps {
  dumpMusicSearch: (query: string, maxResults: number, signal?: AbortSignal) => Promise<ListenerMusicSearchDump>;
  /** Cookie-free YouTube search dump. Required when injecting deps so tests cannot omit it and spawn real yt-dlp. */
  dumpYouTubeSearch: (query: string, maxResults: number, signal?: AbortSignal) => Promise<ListenerMusicSearchDump>;
}

const SEARCH_TIMEOUT_MS = 180_000;

function summarizeStderr(stderr: string, maxLen = 280): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = lines.filter((line) => /ERROR:/i.test(line));
  const chosen = errors.length > 0 ? errors : lines;
  return chosen.join(' | ').slice(0, maxLen) || 'unknown yt-dlp error';
}

async function runListenerDump(
  args: string[],
  signal?: AbortSignal,
): Promise<ListenerMusicSearchDump> {
  signal?.throwIfAborted();
  const group = process.platform !== 'win32';
  const { proc, redact } = await spawnYtDlp(args, {
    target: ytDlpTarget(args),
    timeoutMs: SEARCH_TIMEOUT_MS,
    detached: group,
  });
  return new Promise((resolve, reject) => {
    let running = true;
    const killTree = () => {
      if (!running || proc.pid === undefined) return;
      if (!group) {
        proc.kill('SIGKILL');
        return;
      }
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    };
    const timer = setTimeout(killTree, SEARCH_TIMEOUT_MS);
    signal?.addEventListener('abort', killTree, { once: true });
    if (signal?.aborted) killTree();
    let stdout = '';
    let stderr = '';
    const finished = () => {
      running = false;
      clearTimeout(timer);
      signal?.removeEventListener('abort', killTree);
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-8 * 1024 * 1024);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    proc.on('close', (code) => {
      finished();
      if (signal?.aborted) reject(signal.reason);
      else resolve({ code, stdout: redact(stdout), stderr: redact(stderr) });
    });
    proc.on('error', (err) => {
      finished();
      reject(signal?.aborted ? signal.reason : new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}

async function defaultDumpMusicSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<ListenerMusicSearchDump> {
  return runListenerDump(listenerMusicSearchArgs(query, maxResults), signal);
}

async function defaultDumpYouTubeSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<ListenerMusicSearchDump> {
  return runListenerDump(listenerYouTubeSearchArgs(query, maxResults), signal);
}

function parseDumpRows(stdout: string): ListenerSearchResult[] {
  return parseFlatSearchOutput(stdout)
    .map(toListenerResult)
    .filter((item): item is ListenerSearchResult => item !== null);
}

async function dumpOrThrow(
  label: 'music' | 'youtube',
  dump: (query: string, maxResults: number, signal?: AbortSignal) => Promise<ListenerMusicSearchDump>,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ListenerSearchResult[]> {
  const result = await dump(query, maxResults, signal);
  signal.throwIfAborted();
  if (result.code !== 0) {
    throw new Error(
      `yt-dlp ${label} search failed (code ${result.code}): ${summarizeStderr(result.stderr)}`,
    );
  }
  return parseDumpRows(result.stdout);
}

/**
 * List search results without administrator YouTube cookies.
 *
 * Prefer YouTube Music Songs. When every Music row lacks a verified duration
 * (or Music fails), fall back once to cookie-free `ytsearchN:`. Live /
 * over-limit / unknown-duration filtering still happens at the route layer.
 * Does not download media.
 *
 * Error semantics (owner decision on #639): if neither provider yields a
 * usable verified-duration row and the YouTube dump fails (or Music dump
 * fails and YouTube then fails), this throws. The listener search route maps
 * that to HTTP 503 — not soft 200 []. Soft empty is only when both dumps
 * succeed but every row fails duration/live checks at the route.
 */
export async function searchListenerMusic(
  query: string,
  maxResults = 10,
  signal: AbortSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  deps: ListenerMusicSearchDeps = {
    dumpMusicSearch: defaultDumpMusicSearch,
    dumpYouTubeSearch: defaultDumpYouTubeSearch,
  },
): Promise<ListenerSearchResult[]> {
  signal.throwIfAborted();
  const trimmed = query.trim();
  if (!trimmed) throw new Error('Invalid search query');

  let musicRows: ListenerSearchResult[] | null = null;
  let musicError: unknown;

  try {
    musicRows = await dumpOrThrow('music', deps.dumpMusicSearch, trimmed, maxResults, signal);
  } catch (err) {
    signal.throwIfAborted();
    if (err instanceof Error && err.name === 'AbortError') throw err;
    musicError = err;
  }

  if (musicRows && musicRows.some(listenerSearchRowHasVerifiedDuration)) {
    return musicRows;
  }

  signal.throwIfAborted();
  try {
    return await dumpOrThrow('youtube', deps.dumpYouTubeSearch, trimmed, maxResults, signal);
  } catch (err) {
    signal.throwIfAborted();
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Prefer the Music error when both providers fail; otherwise surface YouTube.
    // Music HTTP-success with only unusable rows leaves musicError unset, so a
    // YouTube dump failure throws here → route 503 (intentional, not soft []).
    if (musicError instanceof Error) throw musicError;
    throw err;
  }
}
