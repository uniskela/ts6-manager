import crypto from 'crypto';

/** SHA-256 fingerprint of a raw SSH host key (hex, lowercase). */
export function fingerprintHostKey(rawKey: Buffer): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export function hostKeyMatches(stored: string | null | undefined, rawKey: Buffer): boolean {
  if (!stored) return true;
  return stored.toLowerCase() === fingerprintHostKey(rawKey);
}
