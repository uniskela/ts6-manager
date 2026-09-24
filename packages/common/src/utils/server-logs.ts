/** Conservative TeamSpeak server-log line parsing for Logs 2.0. */

export type ServerLogLevel = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' | 'UNKNOWN';

export type LogTimestampZoneMode = 'source' | 'utc' | 'local';

const KNOWN_LEVELS = new Set(['ERROR', 'WARNING', 'INFO', 'DEBUG']);

/** Typical TS log prefix: `YYYY-MM-DD HH:mm:ss[.fraction]|LEVEL|…` */
const STRUCTURED_LOG_RE =
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\|([A-Za-z]+)\s*\|([\s\S]*)$/;

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

export function parseServerLogLine(sourceText: string): ParsedServerLogLine {
  const text = sourceText ?? '';
  const match = STRUCTURED_LOG_RE.exec(text);
  if (!match) {
    return {
      sourceText: text,
      level: 'UNKNOWN',
      rawLevel: null,
      sourceTimestamp: null,
      message: null,
      timezoneEstablished: false,
    };
  }

  const sourceTimestamp = match[1];
  const rawLevel = match[2].toUpperCase();
  const level: ServerLogLevel = KNOWN_LEVELS.has(rawLevel)
    ? (rawLevel as ServerLogLevel)
    : 'UNKNOWN';

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
 * the source fragment and never invent Local/UTC conversions.
 */
export function formatLogTimestamp(
  parsed: ParsedServerLogLine,
  _mode: LogTimestampZoneMode = 'source',
): { text: string; zoneLabel: string | null } {
  if (!parsed.sourceTimestamp) {
    return { text: '', zoneLabel: null };
  }
  if (!parsed.timezoneEstablished) {
    return { text: parsed.sourceTimestamp, zoneLabel: 'timezone unknown' };
  }
  // Reserved for when a future source establishes timezone.
  return { text: parsed.sourceTimestamp, zoneLabel: 'UTC' };
}

export function levelBadgeLabel(level: ServerLogLevel): string {
  if (level === 'UNKNOWN') return 'UNK';
  return level.slice(0, 3);
}
