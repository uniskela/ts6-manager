import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export type SecurityFailure = { ok: false; code: 'invalid_signature' | 'replay' };
export type SecurityResult = { ok: true } | SecurityFailure;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DEFAULT_MAX_AGE_MS = 60_000;

export interface ReplayGuard {
  claim(nonce: string, nowMs: number): boolean;
}

export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_MAX_AGE_MS) {}

  claim(nonce: string, nowMs: number): boolean {
    this.gc(nowMs);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowMs);
    return true;
  }

  private gc(nowMs: number): void {
    for (const [nonce, at] of this.seen) {
      if (nowMs - at > this.ttlMs) this.seen.delete(nonce);
    }
  }
}

function timestampFresh(timestamp: string, nowMs: number, maxAgeMs: number): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(nowMs - seconds * 1000) <= maxAgeMs;
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
  if (!timestampFresh(opts.timestamp, nowMs, maxAgeMs)) return { ok: false, code: 'replay' };
  try {
    const raw = Buffer.from(opts.publicKeyHex, 'hex');
    if (raw.length !== 32) return { ok: false, code: 'invalid_signature' };
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    const sig = Buffer.from(opts.signatureHex, 'hex');
    const ok = verify(null, Buffer.from(`${opts.timestamp}${opts.body}`), key, sig);
    return ok ? { ok: true } : { ok: false, code: 'invalid_signature' };
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
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!timestampFresh(opts.timestamp, nowMs, maxAgeMs)) return { ok: false, code: 'replay' };
  const expected = signInvokeHmac(opts);
  if (!equalHex(opts.signatureHex, expected)) return { ok: false, code: 'invalid_signature' };
  if (!opts.replay.claim(opts.nonce, nowMs)) return { ok: false, code: 'replay' };
  return { ok: true };
}
