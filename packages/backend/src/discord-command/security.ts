import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export type SecurityFailure = { ok: false; code: 'invalid_signature' | 'replay' };
export type SecurityResult = { ok: true; timestampMs?: number } | SecurityFailure;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const DEFAULT_MAX_AGE_MS = 60_000;
/** Soft cap so a flood of distinct interaction ids cannot grow without bound. */
const DEFAULT_REPLAY_MAX_ENTRIES = 50_000;

export interface ReplayGuard {
  /** Claim `nonce` until `expiresAtMs` (receiver clock). Defaults to `nowMs +` guard TTL. */
  claim(nonce: string, nowMs: number, expiresAtMs?: number): boolean;
}

/**
 * In-process replay cache. Survives neither process restart nor multi-instance
 * fan-out; callers that need cross-node dedupe must supply a shared ReplayGuard.
 *
 * When at capacity after GC, new claims fail closed (return false) rather than
 * evicting a still-valid nonce — eviction would reopen a replay window.
 */
export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_MAX_AGE_MS,
    private readonly maxEntries = DEFAULT_REPLAY_MAX_ENTRIES,
  ) {}

  /** Test/observability helper — not part of the hot path. */
  size(): number {
    return this.seen.size;
  }

  claim(nonce: string, nowMs: number, expiresAtMs = nowMs + this.ttlMs): boolean {
    this.gc(nowMs);
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.maxEntries) return false;
    this.seen.set(nonce, expiresAtMs);
    return true;
  }

  private gc(nowMs: number): void {
    // Keep the entry through expiresAt inclusive so it covers the last valid stamp.
    for (const [nonce, expiresAt] of this.seen) {
      if (nowMs > expiresAt) this.seen.delete(nonce);
    }
  }
}

/** Unix-seconds timestamp string used by Discord and the hosted HMAC envelope. */
export function parseUnixSecondsTimestamp(timestamp: string): number | null {
  if (typeof timestamp !== 'string' || !/^[0-9]+$/.test(timestamp)) return null;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return null;
  return seconds * 1000;
}

function timestampFresh(timestampMs: number, nowMs: number, maxAgeMs: number): boolean {
  return Math.abs(nowMs - timestampMs) <= maxAgeMs;
}

function equalHex(actual: string, expected: string): boolean {
  try {
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyDiscordSignature(opts: {
  publicKeyHex: string;
  timestamp: string;
  body: string;
  signatureHex: string;
  nowMs?: number;
  maxAgeMs?: number;
}): SecurityResult {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const timestampMs = parseUnixSecondsTimestamp(opts.timestamp);
  if (timestampMs == null || !timestampFresh(timestampMs, nowMs, maxAgeMs)) {
    return { ok: false, code: 'replay' };
  }
  try {
    const raw = Buffer.from(opts.publicKeyHex, 'hex');
    if (raw.length !== 32) return { ok: false, code: 'invalid_signature' };
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    const sig = Buffer.from(opts.signatureHex, 'hex');
    const ok = verify(null, Buffer.from(`${opts.timestamp}${opts.body}`), key, sig);
    return ok ? { ok: true, timestampMs } : { ok: false, code: 'invalid_signature' };
  } catch {
    return { ok: false, code: 'invalid_signature' };
  }
}

export function signInvokeHmac(opts: {
  secret: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  return createHmac('sha256', opts.secret)
    .update(`${opts.timestamp}.${opts.nonce}.${opts.body}`)
    .digest('hex');
}

export function verifyInvokeHmac(opts: {
  secret: string;
  timestamp: string;
  nonce: string;
  body: string;
  signatureHex: string;
  replay: ReplayGuard;
  nowMs?: number;
  maxAgeMs?: number;
}): SecurityResult {
  if (typeof opts.secret !== 'string' || opts.secret.length === 0) {
    return { ok: false, code: 'invalid_signature' };
  }
  if (typeof opts.nonce !== 'string' || opts.nonce.length === 0) {
    return { ok: false, code: 'replay' };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const timestampMs = parseUnixSecondsTimestamp(opts.timestamp);
  if (timestampMs == null || !timestampFresh(timestampMs, nowMs, maxAgeMs)) {
    return { ok: false, code: 'replay' };
  }
  const expected = signInvokeHmac(opts);
  if (!equalHex(opts.signatureHex, expected)) return { ok: false, code: 'invalid_signature' };
  // Retain until the signed stamp's last acceptable instant (covers future-dated abs() window).
  const expiresAtMs = timestampMs + maxAgeMs;
  if (!opts.replay.claim(opts.nonce, nowMs, expiresAtMs)) return { ok: false, code: 'replay' };
  return { ok: true };
}
