import { createHash, randomBytes } from 'node:crypto';
import { RateWindows } from '../utils/rate-windows.js';

export interface Binding {
  botId: number;
  serverConfigId: number;
  virtualServerId: number;
  channelId: number;
  clid: number;
  uid: string;
}

export class ListenerRemoteError extends Error {
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
  /** Client address windows. Kept apart so an address flood cannot push out listener limits. */
  private readonly rates: RateWindows;
  /**
   * Listener identity windows. Entries are created only for grants that exist,
   * so unknown credentials cannot fill this store.
   */
  private readonly credentialRates: RateWindows;

  constructor(private readonly now: () => number = Date.now) {
    this.rates = new RateWindows(MAX_ENTRIES, RATE_WINDOW, now);
    this.credentialRates = new RateWindows(MAX_ENTRIES, RATE_WINDOW, now);
  }

  /** `ip` is a client address key (see utils/client-address); only its hash is kept. */
  checkIp(ip: string, exchange: boolean): void {
    this.prune();
    const ipHash = hash(ip);
    this.limit(this.rates, `ip:${ipHash}`, 120);
    if (exchange) this.limit(this.rates, `exchange-ip:${ipHash}`, 10);
  }

  /**
   * Rate key of the listener behind a live session, or undefined. It creates no
   * state, so it is safe to call for any value a client sends.
   */
  sessionRateKey(session: string | undefined): string | undefined {
    if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session)) return undefined;
    const grant = this.sessions.get(hash(session));
    if (!grant || grant.expiresAt <= this.now()) return undefined;
    return `listener:${identityKey(grant.binding)}`;
  }

  checkRequest(session: string): void {
    this.prune();
    const grant = this.sessions.get(this.credentialHash(session));
    if (!grant) throw denied();
    this.limit(this.credentialRates, `request:${identityKey(grant.binding)}`, 5);
  }

  issue(binding: Binding): { token: string; expiresAt: number } {
    this.prune();
    if (![binding.botId, binding.serverConfigId, binding.virtualServerId, binding.channelId, binding.clid]
      .every((id) => Number.isSafeInteger(id) && id > 0)
      || typeof binding.uid !== 'string' || !binding.uid.trim() || binding.uid.length > 256) {
      throw new ListenerRemoteError(400, 'invalid_request', 'Invalid remote listener identity');
    }
    const key = bindingKey(binding);
    this.limit(this.credentialRates, `issue:${hash(key)}`, 3);
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
    this.limit(this.credentialRates, `session:${identityKey(grant.binding)}`, 60);
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
    this.rates.prune(now);
    this.credentialRates.prune(now);
  }

  /** Count one use of `key`; a full store refuses only new keys, never everyone (see RateWindows). */
  private limit(store: RateWindows, key: string, max: number): void {
    const rate = store.hit(key, max);
    if (rate.count > max) {
      const retryAfter = Math.max(1, Math.ceil((rate.expiresAt - this.now()) / 1000));
      throw new ListenerRemoteError(429, 'rate_limited', 'Too many remote requests', retryAfter);
    }
  }

  private unavailable(): never {
    throw new ListenerRemoteError(503, 'unavailable', 'Remote access is temporarily unavailable');
  }
}
