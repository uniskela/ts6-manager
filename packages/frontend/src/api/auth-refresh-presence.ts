/**
 * Cross-tab presence beacon for refresh ownership.
 *
 * BroadcastChannel is same-origin and cheap, but it is **not atomic**, it does
 * **not order** messages, and it gives **no bound** on delivery latency. A
 * refresh election that decides ownership purely from BroadcastChannel
 * messages therefore cannot distinguish "no peer exists" from "a peer's
 * message is still in flight" — both look like silence, and two tabs can
 * conclude they both own the refresh and POST the same refresh token. The
 * server then sees a genuine replay and revokes the whole token family.
 *
 * This module closes that gap with a *presence* signal that is readable
 * **synchronously** and therefore cannot be missed by a slow message:
 *
 *   - every tab publishes a heartbeat record under a shared localStorage key
 *   - a tab enumerates live peers by reading that key directly
 *   - records older than a staleness bound are ignored
 *
 * IMPORTANT — what this does and does not guarantee:
 *
 *   - It does NOT provide atomic ownership. localStorage has no compare-and-set,
 *     so two tabs can still write concurrently. Nothing here relies on a
 *     localStorage write being exclusive, and no localStorage value is ever
 *     treated as a lease or a lock.
 *   - It DOES provide a complete, immediately-readable view of which tabs are
 *     alive right now. Ownership is then decided deterministically over that
 *     complete set (smallest live tab id wins) and re-checked immediately
 *     before the network call, so a tab that started late learns that it lost
 *     instead of racing.
 *
 * A tab whose heartbeat is stale is treated as gone. If that tab was actually
 * mid-refresh, the server-side replay detector still applies as the last
 * line of defence; this module never weakens it.
 *
 * PARTICIPATION vs ALIVENESS
 *
 * Aliveness alone is not enough to own a refresh. A tab that is open but idle
 * (never asked for a refresh) must not be able to win ownership: if it did,
 * an active tab would defer to it and no refresh would happen at all. Each
 * record therefore also carries whether its tab is *participating* in the
 * current refresh round. Only participating tabs take part in the ownership
 * tie-break; non-participating tabs are still listed as alive so that a stale
 * participant can be identified, but they never block an active tab.
 */

/** localStorage key holding the presence records. */
export const PRESENCE_STORAGE_KEY = 'ts6-auth-refresh-presence';

/**
 * A peer whose heartbeat is older than this is considered gone. Must be
 * comfortably larger than the heartbeat write interval so a busy tab is not
 * mistaken for a dead one, and comfortably smaller than the follower wait so
 * a crashed tab is not waited on forever.
 */
export const PRESENCE_STALE_MS = 5_000;

export type PresenceRecord = {
  tabId: string;
  /** Epoch milliseconds of the last heartbeat write. */
  at: number;
  /**
   * True while this tab is taking part in a refresh round.
   *
   * Only participating tabs may own the refresh. A tab that is merely open
   * (alive but idle) must never block an active tab from refreshing.
   */
  refreshing: boolean;
  /**
   * Identifier of the refresh round this tab participates in. Two tabs only
   * coordinate when they share the same round, so a late joiner cannot be
   * dragged into an unrelated election.
   */
  roundId: string | null;
  /**
   * The refresh token this tab minted for the round, once it has rotated.
   *
   * A tab that lost the election can adopt this successor instead of
   * presenting the now-consumed token again. Without it, two tabs can read
   * the same persisted token and both present it — a genuine replay that the
   * server has to reject (and which may revoke the whole family).
   */
  successor: string | null;
};

/** In-memory mirror of the presence records this tab knows about. */
const localPeers = new Map<string, PresenceRecord>();

function now(): number {
  return Date.now();
}

/**
 * Access the storage object, or null when it is unavailable or blocked.
 *
 * Accessing `localStorage` itself throws in some hardened/partitioned
 * contexts, so even the property access is guarded.
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Access can throw in hardened/partitioned contexts.
    return null;
  }
}

/**
 * Read the presence key.
 *
 * `getItem` can throw (quota pressure, a corrupted storage backend, or a
 * browser that blocks storage access on this origin). A throw here must never
 * escape: presence is advisory, so a failed read degrades to "no records"
 * rather than breaking refresh or application startup.
 */
function readRecords(store: Storage | null): PresenceRecord[] {
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(PRESENCE_STORAGE_KEY);
  } catch {
    return [];
  }
  return parse(raw);
}

function parse(raw: string | null): PresenceRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PresenceRecord[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Partial<PresenceRecord>;
      if (typeof rec.tabId !== 'string' || rec.tabId.length === 0) continue;
      if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue;
      out.push({
        tabId: rec.tabId,
        at: rec.at,
        // Older records (written before participation tracking existed) are
        // treated as alive but NOT participating, so they cannot own a refresh.
        refreshing: rec.refreshing === true,
        roundId: typeof rec.roundId === 'string' ? rec.roundId : null,
        successor: typeof rec.successor === 'string' ? rec.successor : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function serialize(records: PresenceRecord[]): string {
  return JSON.stringify(records);
}

/**
 * Write the presence key.
 *
 * `setItem` can throw (quota exceeded, storage disabled). Presence is
 * advisory, so a failed write is ignored rather than propagated.
 */
function writeRecords(store: Storage | null, records: PresenceRecord[]): void {
  if (!store) return;
  try {
    store.setItem(PRESENCE_STORAGE_KEY, serialize(records));
  } catch {
    // Quota or privacy mode — presence is advisory, so continue without it.
  }
}

/**
 * Publish this tab's heartbeat and read every peer record.
 *
 * The write and the read happen in the same synchronous turn, so the returned
 * set reflects the state of localStorage at that instant. Records are
 * refreshed in place and stale ones are pruned.
 */
export function publishPresence(
  tabId: string,
  at: number = now(),
  refreshing = false,
  roundId: string | null = null,
  successor: string | null = null,
): PresenceRecord[] {
  const store = storage();
  if (!store) return [...localPeers.values()];

  // localStorage has no compare-and-set, so a read-modify-write can lose a
  // concurrent writer's record, and can also resurrect an OLDER version of a
  // record (if our snapshot predates a peer's newer write).
  //
  // The write therefore MERGES and never regresses a record:
  //   - per tab id, the record with the NEWEST timestamp wins;
  //   - a record is dropped only when it is genuinely stale;
  //   - the in-memory mirror is consulted so a record we already know about
  //     is never overwritten with an older copy.
  const existing = readRecords(store);
  const byId = new Map<string, PresenceRecord>();
  for (const rec of existing) {
    const known = localPeers.get(rec.tabId);
    const freshest = known && known.at > rec.at ? known : rec;
    if (at - freshest.at <= PRESENCE_STALE_MS) byId.set(rec.tabId, freshest);
  }
  // Our own record always wins for our own id, but only if it is not older
  // than what is already stored (a heartbeat with an older timestamp must not
  // rewind our own participation flag).
  const ownStored = byId.get(tabId);
  const own: PresenceRecord = ownStored && ownStored.at > at
    ? ownStored
    : {
      tabId,
      at,
      refreshing,
      roundId,
      // Never drop a successor we already published.
      successor: successor ?? ownStored?.successor ?? null,
    };
  byId.set(tabId, own);

  localPeers.clear();
  for (const rec of byId.values()) localPeers.set(rec.tabId, rec);

  writeRecords(store, [...byId.values()]);
  return [...byId.values()];
}

/**
 * Merge the records read from storage into the in-memory mirror.
 *
 * The mirror is MERGED, never replaced. localStorage has no compare-and-set,
 * so a concurrent write can remove a record from storage; replacing the
 * mirror with the stored copy would make that peer invisible, and an
 * invisible peer cannot take part in the ownership decision — which is how
 * two tabs end up owning the same refresh.
 */
function mergeRecords(records: PresenceRecord[]): void {
  for (const rec of records) {
    const known = localPeers.get(rec.tabId);
    if (!known || rec.at >= known.at) localPeers.set(rec.tabId, rec);
  }
}

/**
 * Live peer tab ids, excluding this tab.
 *
 * Combines the synchronous localStorage read with the in-memory mirror so a
 * storage failure degrades to "no peers known" rather than throwing.
 */
export function readLivePeers(tabId: string, at: number = now()): string[] {
  mergeRecords(readRecords(storage()));
  const out: string[] = [];
  for (const rec of localPeers.values()) {
    if (rec.tabId === tabId) continue;
    if (at - rec.at > PRESENCE_STALE_MS) continue;
    out.push(rec.tabId);
  }
  return out;
}

/**
 * Live peers that are *participating in the given refresh round*.
 *
 * These are the only tabs allowed to own the refresh. A tab that is alive but
 * idle is excluded, so it can never block an active tab from refreshing.
 */
export function readParticipatingPeers(
  tabId: string,
  roundId: string,
  at: number = now(),
): string[] {
  mergeRecords(readRecords(storage()));
  const out: string[] = [];
  for (const rec of localPeers.values()) {
    if (rec.tabId === tabId) continue;
    if (at - rec.at > PRESENCE_STALE_MS) continue;
    if (!rec.refreshing) continue;
    // A peer in a *different* round is not part of this election.
    if (rec.roundId !== roundId) continue;
    out.push(rec.tabId);
  }
  return out;
}

/**
 * The successor refresh token published by a participating peer of this round,
 * if any.
 *
 * When the winner of the election has rotated, it publishes the new token
 * here. A tab that lost the election can then adopt the successor instead of
 * presenting the now-consumed token again — presenting it again is a genuine
 * replay, which the server rejects and which may revoke the whole family.
 */
export function readRoundSuccessor(
  tabId: string,
  roundId: string,
  at: number = now(),
): string | null {
  mergeRecords(readRecords(storage()));
  let best: { at: number; successor: string } | null = null;
  for (const rec of localPeers.values()) {
    if (rec.tabId === tabId) continue;
    if (at - rec.at > PRESENCE_STALE_MS) continue;
    if (!rec.refreshing) continue;
    if (rec.roundId !== roundId) continue;
    if (!rec.successor) continue;
    if (!best || rec.at > best.at) best = { at: rec.at, successor: rec.successor };
  }
  return best ? best.successor : null;
}

/** Remove this tab's presence record (on unload or explicit teardown). */
export function clearPresence(tabId: string): void {
  localPeers.delete(tabId);
  const store = storage();
  if (!store) return;
  const existing = readRecords(store).filter((r) => r.tabId !== tabId);
  writeRecords(store, existing);
}

/** Test-only reset. */
export function resetPresenceForTests(): void {
  localPeers.clear();
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PRESENCE_STORAGE_KEY);
  } catch {
    // Best effort.
  }
}
