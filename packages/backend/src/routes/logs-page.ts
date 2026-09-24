/** Typed TeamSpeak logview page envelope (#91 Slice 3). */

export const LOGVIEW_MIN_LINES = 1;
export const LOGVIEW_MAX_LINES = 100;

export interface ServerLogEntry {
  /** Raw `l` field from TeamSpeak; never rewritten. */
  sourceText: string;
  /** Source byte cursor for this row when TeamSpeak provided it. */
  lastPos: string | null;
}

export interface ServerLogPageContext {
  configId: number;
  sid: number;
  /** When true, rows come from the instance/master logfile, not the selected VS logfile. */
  instance: boolean;
  reverse: boolean;
  lines: number;
  /** Requested begin_pos forwarded to TeamSpeak, if any. */
  beginPos: string | null;
}

export interface ServerLogPage {
  entries: ServerLogEntry[];
  context: ServerLogPageContext;
  fetchedAt: string;
  /** Source file_size when present on a verified row; never invented. */
  fileSize: string | null;
  /**
   * Verified continuation cursor for an Older page (TeamSpeak `last_pos`).
   * Null when absent, zero, malformed, or not sourced from TeamSpeak metadata.
   */
  nextBeginPos: string | null;
}

export interface ParseLogQueryResult {
  ok: true;
  lines: number;
  reverse: 0 | 1;
  instance: 0 | 1;
  beginPos: string | undefined;
}

export interface ParseLogQueryError {
  ok: false;
  message: string;
}

function parseFlag(raw: unknown, fallback: 0 | 1): 0 | 1 | null {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = String(value);
  if (text === '0') return 0;
  if (text === '1') return 1;
  return null;
}

function parseLines(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 100;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < LOGVIEW_MIN_LINES || n > LOGVIEW_MAX_LINES) return null;
  return n;
}

/** Accept only non-negative integer byte cursors from the client. */
function parseBeginPos(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  return text;
}

export function parseLogQuery(query: Record<string, unknown>): ParseLogQueryResult | ParseLogQueryError {
  const lines = parseLines(query.lines);
  if (lines === null) {
    return { ok: false, message: `lines must be an integer between ${LOGVIEW_MIN_LINES} and ${LOGVIEW_MAX_LINES}` };
  }
  const reverse = parseFlag(query.reverse, 1);
  if (reverse === null) {
    return { ok: false, message: 'reverse must be 0 or 1' };
  }
  const instance = parseFlag(query.instance, 0);
  if (instance === null) {
    return { ok: false, message: 'instance must be 0 or 1' };
  }
  const beginPos = parseBeginPos(query.begin_pos);
  if (beginPos === null) {
    return { ok: false, message: 'begin_pos must be a non-negative integer byte cursor' };
  }
  return { ok: true, lines, reverse, instance, beginPos };
}

function verifiedDigitString(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw);
  if (!/^\d+$/.test(text)) return null;
  return text;
}

/**
 * Continuation cursor for an Older page.
 * With reverse=1 (newest first), use the last row's last_pos so the next page
 * continues past the oldest line already shown. With reverse=0, use the first
 * row (TeamSpeak forward-read convention). Never derive a cursor from text length.
 */
export function verifiedNextBeginPos(
  rows: Array<Record<string, unknown>>,
  reverse: 0 | 1 = 1,
): string | null {
  if (!rows.length) return null;
  const cursorRow = reverse === 1 ? rows[rows.length - 1] : rows[0];
  const lastPos = verifiedDigitString(cursorRow?.last_pos);
  if (!lastPos || lastPos === '0') return null;
  const fileSize = verifiedDigitString(rows[0]?.file_size);
  if (fileSize !== null) {
    // Cursor past known file size is unusable (rotation / stale page).
    try {
      if (BigInt(lastPos) > BigInt(fileSize)) return null;
    } catch {
      return null;
    }
  }
  return lastPos;
}

export function buildServerLogPage(options: {
  configId: number;
  sid: number;
  lines: number;
  reverse: 0 | 1;
  instance: 0 | 1;
  beginPos: string | undefined;
  raw: unknown;
  fetchedAt?: string;
}): ServerLogPage {
  const rows = Array.isArray(options.raw)
    ? options.raw.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    : [];

  const entries: ServerLogEntry[] = rows.map((row) => {
    const sourceText =
      typeof row.l === 'string' ? row.l
        : typeof row.msg === 'string' ? row.msg
          : '';
    return {
      sourceText,
      lastPos: verifiedDigitString(row.last_pos),
    };
  });

  const fileSize = rows.length ? verifiedDigitString(rows[0].file_size) : null;

  return {
    entries,
    context: {
      configId: options.configId,
      sid: options.sid,
      instance: options.instance === 1,
      reverse: options.reverse === 1,
      lines: options.lines,
      beginPos: options.beginPos ?? null,
    },
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    fileSize,
    nextBeginPos: verifiedNextBeginPos(rows, options.reverse),
  };
}
