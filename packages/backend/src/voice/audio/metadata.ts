import path from 'path';
import { spawn } from 'child_process';

/**
 * Decode a filename / ID3-ish string that may be mojibake from Windows-1251 or Latin-1.
 * Prefers UTF-8; falls back to common mis-decodings when high bytes look wrong.
 */
export function decodeMetadataText(raw: string): string {
  if (!raw) return raw;
  // Already valid-looking Unicode with CJK / Cyrillic
  if (/[\u0400-\u04FF\u4E00-\u9FFF]/.test(raw)) return raw;

  try {
    const asLatin1 = Buffer.from(raw, 'latin1');
    let high = 0;
    for (const b of asLatin1) if (b >= 0x80) high++;
    if (high < 2) return raw;

    // Prefer TextDecoder when the Node ICU build supports windows-1251
    try {
      const decoder = new TextDecoder('windows-1251' as unknown as string);
      const decoded = decoder.decode(asLatin1);
      if (/[\u0400-\u04FF]/.test(decoded)) return decoded;
    } catch {
      /* encoding unavailable */
    }
  } catch {
    /* ignore */
  }

  return raw;
}

export function parseTitleArtistFromFilename(fileName: string): { title: string; artist: string | null } {
  const baseName = path.basename(fileName, path.extname(fileName));
  const decoded = decodeMetadataText(baseName);
  let title = decoded;
  let artist: string | null = null;
  const dashIdx = decoded.indexOf(' - ');
  if (dashIdx > 0) {
    artist = decoded.substring(0, dashIdx).trim();
    title = decoded.substring(dashIdx + 3).trim();
  }
  return { title, artist };
}

/** Read title/artist via ffprobe tags when present. */
export function probeAudioTags(filePath: string): Promise<{ title?: string; artist?: string; duration?: number }> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath,
    ], { shell: false });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return resolve({});
      try {
        const parsed = JSON.parse(output);
        const tags = parsed.format?.tags || {};
        const title = tags.title || tags.TITLE;
        const artist = tags.artist || tags.ARTIST || tags.album_artist;
        const duration = parseFloat(parsed.format?.duration) || undefined;
        resolve({
          title: title ? decodeMetadataText(String(title)) : undefined,
          artist: artist ? decodeMetadataText(String(artist)) : undefined,
          duration,
        });
      } catch {
        resolve({});
      }
    });
    proc.on('error', () => resolve({}));
  });
}
