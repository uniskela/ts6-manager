import { createHash, randomBytes } from 'node:crypto';
import { RateWindows, monotonicNow } from '../utils/rate-windows.js';

export interface Binding {
  botId: number;
  serverConfigId: number;
  virtualServerId: number;
  channelId: number;
  clid: number;
  uid: string;
}

export class ListenerRemoteError extends Error {
  /** Audit result when it differs from `code` (a full queue answers `rate_limited` but is audited as `queue_full`). */
  public auditCode?: string;

  /** `retryAfter`: whole seconds until a rate limit's window resets. */
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly retryAfter?: number) {
    super(message);
    this.name = 'ListenerRemoteError';
  }
}

type ValidateBinding = (binding: Binding) => Promise<boolean>;
interface Grant {
  binding: Binding;
  expiresAt: number;
  tokenHash?: string;
  sessionHash?: string;
}

const TOKEN_TTL = 5 * 60_000;
const SESSION_TTL = 15 * 60_000;
const MAX_ENTRIES = 10_000;
const RATE_WINDOW = 60_000;
/** One window per client address: all requests, and exchanges. */
const ADDRESS_LIMITS = [120, 10] as const;
const ALL_REQUESTS = 0;
const EXCHANGES = 1;
/** One window per listener: issued links, authentications, URL requests. */
const IDENTITY_LIMITS = [3, 60, 5] as const;
const ISSUES = 0;
const AUTHENTICATIONS = 1;
const URL_REQUESTS = 2;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const bindingKey = (binding: Binding): string => JSON.stringify([binding.botId, binding.uid]);
/** Rate key for one listener on one bot; it survives a new `!remote`. */
const identityKey = (binding: Binding): string => hash(bindingKey(binding));
const denied = (): ListenerRemoteError => new ListenerRemoteError(401, 'invalid_access', 'Remote access is invalid or expired');

/** Process-local credentials deliberately disappear on restart. Raw credentials are never stored. */
// shortcut: one backend replica, use atomic shared storage before horizontal scaling.
export class ListenerRemoteService {
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, Grant>();
  private readonly sessions = new Map<string, Grant>();
  private readonly now: () => number;
  /** Client address windows. Kept apart so an address flood cannot push out listener limits. */
  private readonly rates: RateWindows;
  /**
   * Listener identity windows. Entries are created only for listeners that hold
   * a grant, so unknown credentials cannot fill this store.
   */
  private readonly credentialRates: RateWindows;

  /** A test clock drives both credential lifetimes and rate windows; otherwise rate windows are monotonic. */
  constructor(now?: () => number) {
    this.now = now ?? Date.now;
    this.rates = new RateWindows(MAX_ENTRIES, RATE_WINDOW, now ?? monotonicNow);
    this.credentialRates = new RateWindows(MAX_ENTRIES, RATE_WINDOW, now ?? monotonicNow);
  }

  /** `ip` is a client address key (see utils/client-address); only its hash is kept. */
  checkIp(ip: string, exchange: boolean): void {
    this.prune();
    const ipHash = hash(ip);
    // Both counts share one window, so making room for one can never discard the other.
    this.limit(this.rates, `ip:${ipHash}`, ADDRESS_LIMITS, ALL_REQUESTS);
    if (exchange) this.limit(this.rates, `ip:${ipHash}`, ADDRESS_LIMITS, EXCHANGES);
  }

  /**
   * Rate key of the listener behind a live session, or undefined. It creates no
   * state, so it is safe to call for any value a client sends.
   */
  sessionRateKey(session: string | undefined): string | undefined {
    const binding = this.sessionBinding(session);
    return binding ? `listener:${identityKey(binding)}` : undefined;
  }

  /**
   * Binding of a live session, or undefined, without verifying the listener's
   * identity. It creates no state; callers must still authenticate.
   */
  sessionBinding(session: string | undefined): Binding | undefined {
    if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session)) return undefined;
    const grant = this.sessions.get(hash(session));
    return grant && grant.expiresAt > this.now() ? grant.binding : undefined;
  }

  checkRequest(session: string): void {
    this.prune();
    const grant = this.sessions.get(this.credentialHash(session));
    if (!grant) throw denied();
    this.limit(this.credentialRates, identityKey(grant.binding), IDENTITY_LIMITS, URL_REQUESTS);
  }

  issue(binding: Binding): { token: string; expiresAt: number } {
    this.prune();
    if (![binding.botId, binding.serverConfigId, binding.virtualServerId, binding.channelId, binding.clid]
      .every((id) => Number.isSafeInteger(id) && id > 0)
      || typeof binding.uid !== 'string' || !binding.uid.trim() || binding.uid.length > 256) {
      throw new ListenerRemoteError(400, 'invalid_request', 'Invalid remote listener identity');
    }
    const key = bindingKey(binding);
    this.limit(this.credentialRates, hash(key), IDENTITY_LIMITS, ISSUES);
    const previous = this.grants.get(key);
    if (!previous && this.grants.size >= MAX_ENTRIES) this.unavailable();
    if (previous) this.remove(previous);
    const token = randomBytes(32).toString('base64url');
    const grant: Grant = {
      binding: Object.freeze({ ...binding }), expiresAt: this.now() + TOKEN_TTL, tokenHash: hash(token),
    };
    this.grants.set(key, grant);
    this.tokens.set(grant.tokenHash!, grant);
    return { token, expiresAt: grant.expiresAt };
  }

  async exchange(token: string, validate: ValidateBinding): Promise<{ session: string; expiresAt: number; binding: Binding }> {
    this.prune();
    const tokenHash = this.credentialHash(token);
    const grant = this.tokens.get(tokenHash);
    // Unknown, expired and consumed tokens are indistinguishable and keep no state here;
    // guessing is bounded by the per-address exchange limit.
    if (!grant) throw denied();
    // Consume synchronously before TeamSpeak validation; parallel exchanges cannot reuse this token.
    this.tokens.delete(tokenHash);
    delete grant.tokenHash;
    await this.validate(grant, validate);
    const session = randomBytes(32).toString('base64url');
    grant.sessionHash = hash(session);
    grant.expiresAt = this.now() + SESSION_TTL;
    this.sessions.set(grant.sessionHash, grant);
    return { session, expiresAt: grant.expiresAt, binding: { ...grant.binding } };
  }

  async authenticate(session: string, validate: ValidateBinding): Promise<Binding> {
    this.prune();
    const sessionHash = this.credentialHash(session);
    const grant = this.sessions.get(sessionHash);
    if (!grant) throw denied();
    this.limit(this.credentialRates, identityKey(grant.binding), IDENTITY_LIMITS, AUTHENTICATIONS);
    await this.validate(grant, validate);
    return { ...grant.binding };
  }

  revoke(botId: number, uid?: string): number {
    this.prune();
    let count = 0;
    for (const grant of this.grants.values()) {
      if (grant.binding.botId === botId && (uid === undefined || grant.binding.uid === uid)) {
        this.remove(grant);
        count++;
      }
    }
    return count;
  }

  revokeClient(serverConfigId: number, virtualServerId: number, clid: number): void {
    this.prune();
    for (const grant of this.grants.values()) {
      const binding = grant.binding;
      if (binding.serverConfigId === serverConfigId && binding.virtualServerId === virtualServerId && binding.clid === clid) {
        this.remove(grant);
      }
    }
  }

  private async validate(grant: Grant, validate: ValidateBinding): Promise<void> {
    let valid: boolean;
    try {
      valid = await validate({ ...grant.binding });
    } catch {
      this.remove(grant);
      throw denied();
    }
    if (!valid || grant.expiresAt <= this.now() || this.grants.get(bindingKey(grant.binding)) !== grant) {
      this.remove(grant);
      throw denied();
    }
  }

  private credentialHash(credential: string): string {
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw denied();
    return hash(credential);
  }

  private remove(grant: Grant): void {
    const key = bindingKey(grant.binding);
    if (this.grants.get(key) === grant) this.grants.delete(key);
    if (grant.tokenHash) this.tokens.delete(grant.tokenHash);
    if (grant.sessionHash) this.sessions.delete(grant.sessionHash);
  }

  private prune(): void {
    const now = this.now();
    for (const grant of this.grants.values()) if (grant.expiresAt <= now) this.remove(grant);
    this.rates.prune();
    this.credentialRates.prune();
  }

  /** Count one use of counter `index` of `key`. A full store makes room; it never refuses (see RateWindows). */
  private limit(store: RateWindows, key: string, limits: readonly number[], index: number): void {
    const rate = store.hit(key, limits, index);
    if (rate.count > rate.limit) {
      const retryAfter = Math.max(1, Math.ceil(rate.remainingMs / 1000));
      throw new ListenerRemoteError(429, 'rate_limited', 'Too many remote requests', retryAfter);
    }
  }

  private unavailable(): never {
    throw new ListenerRemoteError(503, 'unavailable', 'Remote access is temporarily unavailable');
  }
}
