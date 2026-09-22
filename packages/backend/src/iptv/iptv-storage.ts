/**
 * Persistent storage helpers for uploaded IPTV playlist source files.
 * Files live under data/iptv/ (Docker backend-data volume). Paths stored in
 * the DB are relative basenames only — never absolute container paths.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export const MAX_IPTV_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MB (aligned with fetch cap)
export const IPTV_STORAGE_DIR = path.resolve('data', 'iptv');

const SAFE_BASENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/;

export function ensureIptvStorageDir(): void {
  fs.mkdirSync(IPTV_STORAGE_DIR, { recursive: true });
}

/** Resolve a stored relative basename to an absolute path inside IPTV_STORAGE_DIR. */
export function resolveIptvSourcePath(relativeName: string): string {
  if (!relativeName || typeof relativeName !== 'string') {
    throw new Error('Invalid IPTV source path');
  }
  const base = path.basename(relativeName);
  if (base !== relativeName || !SAFE_BASENAME_RE.test(base)) {
    throw new Error('Invalid IPTV source path');
  }
  const absolute = path.resolve(IPTV_STORAGE_DIR, base);
  const rootWithSep = IPTV_STORAGE_DIR.endsWith(path.sep)
    ? IPTV_STORAGE_DIR
    : IPTV_STORAGE_DIR + path.sep;
  if (absolute !== IPTV_STORAGE_DIR && !absolute.startsWith(rootWithSep)) {
    throw new Error('IPTV source path escapes storage directory');
  }
  return absolute;
}

export function buildStoredFilename(originalFilename?: string | null): string {
  const ext = extensionFromFilename(originalFilename);
  return `${randomUUID()}${ext}`;
}

function extensionFromFilename(originalFilename?: string | null): string {
  if (!originalFilename) return '.m3u';
  const ext = path.extname(originalFilename).toLowerCase();
  if (ext === '.m3u' || ext === '.m3u8' || ext === '.txt') return ext;
  return '.m3u';
}

/** Atomic write: temp file in same directory then rename. Returns relative basename. */
export function writeIptvSourceFile(
  content: Buffer | string,
  originalFilename?: string | null,
): string {
  ensureIptvStorageDir();
  const relative = buildStoredFilename(originalFilename);
  const absolute = resolveIptvSourcePath(relative);
  const tmp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, absolute);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return relative;
}

export function readIptvSourceFile(relativeName: string): string {
  const absolute = resolveIptvSourcePath(relativeName);
  const stat = fs.statSync(absolute);
  if (stat.size > MAX_IPTV_UPLOAD_BYTES) {
    throw new Error(`Stored playlist exceeds ${MAX_IPTV_UPLOAD_BYTES} byte limit`);
  }
  return fs.readFileSync(absolute, 'utf-8');
}

export function deleteIptvSourceFile(relativeName: string | null | undefined): void {
  if (!relativeName) return;
  try {
    const absolute = resolveIptvSourcePath(relativeName);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch {
    // Best-effort cleanup; do not fail playlist delete on orphaned path issues.
  }
}

/**
 * Decode upload buffer as UTF-8 text. Rejects empty buffers and obvious binary
 * (NUL bytes). BOM is stripped when present.
 */
export function decodePlaylistUpload(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) {
    throw new Error('Uploaded playlist file is empty');
  }
  if (buffer.length > MAX_IPTV_UPLOAD_BYTES) {
    throw new Error(`Playlist exceeds ${MAX_IPTV_UPLOAD_BYTES} byte limit`);
  }
  // Reject files with NUL bytes (binary) — M3U is text.
  if (buffer.includes(0)) {
    throw new Error('Uploaded file does not look like a text playlist');
  }
  let text = buffer.toString('utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) {
    throw new Error('Uploaded playlist file is empty');
  }
  return text;
}

export function sanitizeOriginalFilename(name: string | undefined | null): string | null {
  if (!name || typeof name !== 'string') return null;
  const base = path.basename(name).replace(/[\0\r\n]/g, '').trim();
  if (!base) return null;
  return base.slice(0, 255);
}
