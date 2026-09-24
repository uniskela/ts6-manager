/**
 * In-memory client identity cache for EventBridge enrichment (#74).
 * Allow-listed fields only — never store IPs, chat, or raw notifications.
 */

export const CLIENT_IDENTITY_FIELDS = [
  'client_nickname',
  'client_type',
  'client_unique_identifier',
  'client_database_id',
] as const;

export type ClientIdentityField = (typeof CLIENT_IDENTITY_FIELDS)[number];

export type ClientIdentitySnapshot = Partial<Record<ClientIdentityField, string>>;

const MAX_FIELD_LEN: Record<ClientIdentityField, number> = {
  client_nickname: 30,
  client_type: 8,
  client_unique_identifier: 64,
  client_database_id: 16,
};

export function pickAllowlistedIdentity(data: Record<string, string>): ClientIdentitySnapshot {
  const out: ClientIdentitySnapshot = {};
  for (const field of CLIENT_IDENTITY_FIELDS) {
    const raw = data[field];
    if (raw === undefined || raw === '') continue;
    out[field] = String(raw).slice(0, MAX_FIELD_LEN[field]);
  }
  return out;
}

/** Event fields win; fill only missing/empty keys from cache. */
export function mergeIdentityPreferringEvent(
  event: Record<string, string>,
  cached: ClientIdentitySnapshot | undefined,
): Record<string, string> {
  if (!cached) return { ...event };
  const out = { ...event };
  for (const field of CLIENT_IDENTITY_FIELDS) {
    const current = out[field];
    if ((current === undefined || current === '') && cached[field]) {
      out[field] = cached[field]!;
    }
  }
  return out;
}

export class ClientMetadataCache {
  /** key: configId:sid:generation:clid → allow-listed identity */
  private cache = new Map<string, ClientIdentitySnapshot>();
  /** key: configId:sid → generation */
  private generations = new Map<string, number>();

  private pairKey(configId: number, sid: number): string {
    return `${configId}:${sid}`;
  }

  private entryKey(configId: number, sid: number, generation: number, clid: string): string {
    return `${configId}:${sid}:${generation}:${clid}`;
  }

  getGeneration(configId: number, sid: number): number {
    return this.generations.get(this.pairKey(configId, sid)) ?? 0;
  }

  /** Bump generation and drop all cached entries for this connection/SID. */
  beginGeneration(configId: number, sid: number): number {
    const pair = this.pairKey(configId, sid);
    const next = (this.generations.get(pair) ?? 0) + 1;
    this.generations.set(pair, next);
    this.clearPair(configId, sid, { keepGeneration: true });
    return next;
  }

  clearPair(configId: number, sid: number, opts?: { keepGeneration?: boolean }): void {
    const prefix = `${configId}:${sid}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
    if (!opts?.keepGeneration) {
      this.generations.delete(this.pairKey(configId, sid));
    }
  }

  clearAll(): void {
    this.cache.clear();
    this.generations.clear();
  }

  remember(configId: number, sid: number, data: Record<string, string>): void {
    const clid = data.clid;
    if (!clid) return;
    const identity = pickAllowlistedIdentity(data);
    if (Object.keys(identity).length === 0) return;
    const gen = this.getGeneration(configId, sid);
    const key = this.entryKey(configId, sid, gen, clid);
    const prev = this.cache.get(key) || {};
    this.cache.set(key, { ...prev, ...identity });
  }

  /** Seed from clientlist rows without manufacturing journal join events. */
  seedFromClientList(configId: number, sid: number, clients: Record<string, string>[]): string[] {
    const clids: string[] = [];
    for (const row of clients) {
      const clid = row.clid;
      if (!clid) continue;
      this.remember(configId, sid, row);
      clids.push(clid);
    }
    return clids;
  }

  lookup(configId: number, sid: number, clid: string): ClientIdentitySnapshot | undefined {
    const gen = this.getGeneration(configId, sid);
    return this.cache.get(this.entryKey(configId, sid, gen, clid));
  }

  take(configId: number, sid: number, clid: string): ClientIdentitySnapshot | undefined {
    const gen = this.getGeneration(configId, sid);
    const key = this.entryKey(configId, sid, gen, clid);
    const value = this.cache.get(key);
    this.cache.delete(key);
    return value;
  }

  /**
   * Enrich a TeamSpeak notification. Remembers enter identity; merges+evicts on leave.
   * Always returns a payload (never drops events when cache misses).
   */
  enrich(
    configId: number,
    sid: number,
    eventName: string,
    data: Record<string, string>,
  ): Record<string, string> {
    if (eventName === 'notifycliententerview') {
      this.remember(configId, sid, data);
      return { ...data };
    }

    if (eventName === 'notifyclientleftview') {
      const clid = data.clid;
      if (!clid) return { ...data };
      const cached = this.take(configId, sid, clid);
      return mergeIdentityPreferringEvent(data, cached);
    }

    // Channel moves: refresh cache identity if present on the event, keep entry.
    if (eventName === 'notifyclientmoved' && data.clid) {
      this.remember(configId, sid, data);
    }

    return { ...data };
  }
}
