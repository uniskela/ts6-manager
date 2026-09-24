/** Conservative TeamSpeak server-log line parsing for Logs 2.0. */

export type ServerLogLevel = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' | 'UNKNOWN';

export type LogTimestampZoneMode = 'source' | 'utc' | 'local';

/** Canonical levels operators can filter on. */
export const SERVER_LOG_LEVELS: readonly ServerLogLevel[] = [
  'ERROR',
  'WARNING',
  'INFO',
  'DEBUG',
  'UNKNOWN',
] as const;

/**
 * Map TeamSpeak level tokens (full names and common abbreviations) onto the
 * filter/badge enum. Badges still show the first three letters (WAR, ERR, …).
 */
const LEVEL_ALIASES: Record<string, ServerLogLevel> = {
  ERROR: 'ERROR',
  ERR: 'ERROR',
  ERRO: 'ERROR',
  WARNING: 'WARNING',
  WARN: 'WARNING',
  WAR: 'WARNING',
  INFO: 'INFO',
  INF: 'INFO',
  DEBUG: 'DEBUG',
  DBG: 'DEBUG',
  DEB: 'DEBUG',
};

/** Typical TS log prefix: `YYYY-MM-DD HH:mm:ss[.fraction]|LEVEL|…` */
const STRUCTURED_LOG_RE =
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\|\s*([A-Za-z]+)\s*\|([\s\S]*)$/;

/**
 * Fallback when the line is not a normal structured prefix (separators, wrapped
 * fragments) but still embeds a `|LEVEL|` token — including `|WARNING|` / `|WAR|`.
 */
const EMBEDDED_LEVEL_RE =
  /\|\s*(ERROR|ERR|ERRO|WARNING|WARN|WAR|INFO|INF|DEBUG|DBG|DEB)\s*\|/i;

export interface ParsedServerLogLine {
  sourceText: string;
  level: ServerLogLevel;
  /** Raw level token when present but not in the known set. */
  rawLevel: string | null;
  /** Source timestamp fragment when structure was recognized. */
  sourceTimestamp: string | null;
  /** Remainder after level when structure was recognized. */
  message: string | null;
  /** True only when the source timezone is established for conversion. */
  timezoneEstablished: boolean;
}

/** Normalize a raw TeamSpeak level token to the filter enum (or UNKNOWN). */
export function normalizeServerLogLevel(raw: string | null | undefined): ServerLogLevel {
  if (!raw) return 'UNKNOWN';
  const token = String(raw).trim().toUpperCase();
  return LEVEL_ALIASES[token] ?? 'UNKNOWN';
}

/**
 * Whether a parsed row matches the page-local level filter.
 * Accepts canonical values and the same aliases the parser understands
 * (e.g. filter WARNING matches WAR / WARN / WARNING).
 */
export function logLevelMatchesFilter(
  level: ServerLogLevel,
  filter: string,
): boolean {
  if (!filter || filter === 'ALL') return true;
  const wanted = normalizeServerLogLevel(filter);
  if (wanted === 'UNKNOWN') {
    // Explicit Unknown filter: only UNKNOWN rows (not a failed alias lookup for junk).
    return filter.toUpperCase() === 'UNKNOWN' && level === 'UNKNOWN';
  }
  return level === wanted;
}

function levelFromEmbeddedToken(text: string): { level: ServerLogLevel; rawLevel: string } | null {
  const embedded = EMBEDDED_LEVEL_RE.exec(text);
  if (!embedded) return null;
  const rawLevel = embedded[1].toUpperCase();
  return { level: normalizeServerLogLevel(rawLevel), rawLevel };
}

export function parseServerLogLine(sourceText: string): ParsedServerLogLine {
  const text = sourceText ?? '';
  const match = STRUCTURED_LOG_RE.exec(text);
  if (!match) {
    const embedded = levelFromEmbeddedToken(text);
    return {
      sourceText: text,
      level: embedded?.level ?? 'UNKNOWN',
      rawLevel: embedded?.rawLevel ?? null,
      sourceTimestamp: null,
      message: null,
      timezoneEstablished: false,
    };
  }

  const sourceTimestamp = match[1];
  const rawLevel = match[2].toUpperCase();
  let level = normalizeServerLogLevel(rawLevel);

  // Structured token was unrecognized (NOTICE, …) — still try an embedded
  // `|WARNING|` elsewhere so separator-style rows are filterable.
  if (level === 'UNKNOWN') {
    const embedded = levelFromEmbeddedToken(text);
    if (embedded && embedded.level !== 'UNKNOWN') {
      level = embedded.level;
    }
  }

  return {
    sourceText: text,
    level,
    rawLevel,
    sourceTimestamp,
    message: match[3],
    // TSSERVER_LOG_TIMEZONE may be utc or local; WebQuery does not expose which.
    timezoneEstablished: false,
  };
}

/**
 * Present a parsed timestamp. Without an established source zone, always return
 * the source fragment and never invent Local/UTC conversions. Callers should
 * surface {@link LOG_TIMESTAMP_ZONE_UNKNOWN_HINT} once per page — not per row.
 */
export function formatLogTimestamp(
  parsed: ParsedServerLogLine,
  _mode: LogTimestampZoneMode = 'source',
): { text: string; zoneLabel: string | null } {
  if (!parsed.sourceTimestamp) {
    return { text: '', zoneLabel: null };
  }
  if (!parsed.timezoneEstablished) {
    // No per-row "timezone unknown" — WebQuery does not report the zone.
    return { text: parsed.sourceTimestamp, zoneLabel: null };
  }
  // Reserved for when a future source establishes timezone.
  return { text: parsed.sourceTimestamp, zoneLabel: 'UTC' };
}

/** One-line operator note when logview timestamps lack an established zone. */
export const LOG_TIMESTAMP_ZONE_UNKNOWN_HINT =
  'Timestamps are shown as TeamSpeak wrote them. WebQuery does not report whether the server log zone is UTC or local.';

export function levelBadgeLabel(level: ServerLogLevel): string {
  if (level === 'UNKNOWN') return 'UNK';
  return level.slice(0, 3);
}
