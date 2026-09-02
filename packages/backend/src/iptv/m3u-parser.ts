/**
 * Minimal M3U / M3U8 (extended) playlist parser for IPTV sources.
 *
 * Understands the common IPTV `#EXTINF` form emitted by Xtream Codes,
 * Threadfin, Dispatcharr, etc.:
 *
 *   #EXTM3U
 *   #EXTINF:-1 tvg-id="BBC1.uk" tvg-logo="http://logo/bbc1.png" group-title="UK",BBC One
 *   http://provider/live/user/pass/1234.m3u8
 *
 * The attribute block is optional; the display name is whatever follows the
 * last comma on the EXTINF line.
 */

export interface ParsedChannel {
  name: string;
  url: string;
  logo?: string;
  groupTitle?: string;
  tvgId?: string;
}

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(line)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

/**
 * Parse an M3U playlist body into a list of channels.
 * Lines that aren't part of a valid EXTINF+URL pair are ignored.
 */
export function parseM3U(content: string): ParsedChannel[] {
  const channels: ParsedChannel[] = [];
  // Normalize newlines, keep order.
  const lines = content.split(/\r?\n/);

  let pending: { name: string; attrs: Record<string, string> } | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      // Everything after the first comma is the display name.
      const commaIdx = line.indexOf(',');
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
      const attrs = parseAttributes(line);
      pending = { name: name || attrs['tvg-name'] || 'Unnamed', attrs };
      continue;
    }

    // Skip other directives (#EXTM3U, #EXTGRP handled below, #KODIPROP, etc.)
    if (line.startsWith('#EXTGRP:')) {
      if (pending) pending.attrs['group-title'] = line.slice('#EXTGRP:'.length).trim();
      continue;
    }
    if (line.startsWith('#')) continue;

    // A non-comment line is the stream URL for the pending EXTINF.
    if (pending) {
      channels.push({
        name: pending.name,
        url: line,
        logo: pending.attrs['tvg-logo'] || undefined,
        groupTitle: pending.attrs['group-title'] || undefined,
        tvgId: pending.attrs['tvg-id'] || undefined,
      });
      pending = null;
    }
    // A URL with no preceding EXTINF is ignored (malformed entry).
  }

  return channels;
}
