/**
 * Community Radio Browser client (https://api.radio-browser.info/).
 * Discovers a mirror via DNS, searches stations, and records clicks.
 */
import { promises as dns } from 'node:dns';
import { createRequire } from 'node:module';

const MIRROR_HOST = 'all.api.radio-browser.info';
const MIRROR_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_LIMIT = 25;

const require = createRequire(import.meta.url);
const backendPkg = require('../../package.json') as { version?: string };
const USER_AGENT = `ts6-manager/${backendPkg.version || '0.0.0'}`;

export interface RadioBrowserSearchQuery {
  name?: string;
  tag?: string;
  countrycode?: string;
  limit?: number;
}

export interface RadioBrowserStation {
  stationuuid: string;
  name: string;
  url: string;
  genre: string;
  imageUrl: string | null;
  countrycode: string;
  codec: string;
  bitrate: number;
}

type ResolveMirrors = () => Promise<string[]>;
type HttpGet = (url: string) => Promise<unknown>;

let cachedMirrors: { hosts: string[]; until: number } | null = null;

/** Shuffle in place (Fisher–Yates). Exported for tests. */
export function shuffleInPlace<T>(items: T[], random: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

async function defaultResolveMirrors(): Promise<string[]> {
  const now = Date.now();
  if (cachedMirrors && cachedMirrors.until > now && cachedMirrors.hosts.length > 0) {
    return [...cachedMirrors.hosts];
  }
  const ips = await dns.resolve4(MIRROR_HOST);
  const hosts: string[] = [];
  for (const ip of ips) {
    try {
      const names = await dns.reverse(ip);
      for (const name of names) {
        const host = name.replace(/\.$/, '');
        if (host && !hosts.includes(host)) hosts.push(host);
      }
    } catch {
      // Reverse DNS is optional; skip unresolvable IPs.
    }
  }
  if (hosts.length === 0) throw new Error('No Radio Browser mirrors found');
  cachedMirrors = { hosts, until: now + MIRROR_TTL_MS };
  return [...hosts];
}

async function defaultHttpGet(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Radio Browser HTTP ${res.status}`);
  return res.json();
}

/** Map a Radio Browser station JSON object to our import DTO. */
export function mapRadioBrowserStation(raw: unknown): RadioBrowserStation | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const stationuuid = String(s.stationuuid ?? '').trim();
  const name = String(s.name ?? '').trim();
  const url = String(s.url_resolved || s.url || '').trim();
  if (!stationuuid || !name || !url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  // Keep the first three distinct tags (case-insensitive); the UI splits them into mood chips.
  const seenTags = new Set<string>();
  const tags = String(s.tags ?? '')
    .split(',')
    .map((t) => t.trim().replace(/\s+/g, ' '))
    .filter((t) => {
      const key = t.toLowerCase();
      if (!t || seenTags.has(key)) return false;
      seenTags.add(key);
      return true;
    })
    .slice(0, 3)
    .join(', ');
  const favicon = String(s.favicon ?? '').trim();
  return {
    stationuuid,
    name,
    url,
    genre: tags,
    imageUrl: favicon && /^https?:\/\//i.test(favicon) ? favicon : null,
    countrycode: String(s.countrycode ?? '').trim().toUpperCase(),
    codec: String(s.codec ?? '').trim(),
    bitrate: Number(s.bitrate) || 0,
  };
}

export interface RadioBrowserClientOptions {
  resolveMirrors?: ResolveMirrors;
  httpGet?: HttpGet;
  random?: () => number;
}

/** Clear the mirror cache (tests). */
export function resetRadioBrowserMirrorCache(): void {
  cachedMirrors = null;
}

/**
 * Search online stations. Prefer working non-HLS streams ordered by votes.
 * Tries each discovered mirror until one succeeds.
 */
export async function searchRadioBrowserStations(
  query: RadioBrowserSearchQuery,
  opts: RadioBrowserClientOptions = {},
): Promise<RadioBrowserStation[]> {
  const name = query.name?.trim() ?? '';
  const tag = query.tag?.trim() ?? '';
  const countrycode = query.countrycode?.trim().toUpperCase() ?? '';
  if (!name && !tag && !countrycode) {
    throw new Error('Provide a search name, tag, or country code');
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? MAX_LIMIT)));
  const params = new URLSearchParams({
    lastcheckok: '1',
    hls: '0',
    order: 'votes',
    reverse: 'true',
    limit: String(limit),
    hidebroken: 'true',
  });
  if (name) params.set('name', name);
  if (tag) params.set('tag', tag);
  if (countrycode) params.set('countrycode', countrycode);

  const resolve = opts.resolveMirrors ?? defaultResolveMirrors;
  const httpGet = opts.httpGet ?? defaultHttpGet;
  const hosts = shuffleInPlace(await resolve(), opts.random);
  let lastError: unknown;
  for (const host of hosts) {
    try {
      const data = await httpGet(`https://${host}/json/stations/search?${params}`);
      if (!Array.isArray(data)) throw new Error('Unexpected Radio Browser response');
      return data.map(mapRadioBrowserStation).filter((s): s is RadioBrowserStation => !!s);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Radio Browser search failed');
}

/** Record a station click (helps popularity ranking). Best-effort; never throws. */
export async function recordRadioBrowserClick(
  stationuuid: string,
  opts: RadioBrowserClientOptions = {},
): Promise<void> {
  const id = stationuuid.trim();
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
  const resolve = opts.resolveMirrors ?? defaultResolveMirrors;
  const httpGet = opts.httpGet ?? defaultHttpGet;
  try {
    const hosts = shuffleInPlace(await resolve(), opts.random);
    for (const host of hosts) {
      try {
        await httpGet(`https://${host}/json/url/${encodeURIComponent(id)}`);
        return;
      } catch {
        // try next mirror
      }
    }
  } catch {
    // ignore
  }
}

export { USER_AGENT as radioBrowserUserAgent };

/** Mutable facade so route tests can stub without redefining ESM exports. */
export const radioBrowser = {
  searchStations: searchRadioBrowserStations,
  recordClick: recordRadioBrowserClick,
};
