import { createHash } from 'node:crypto';
import type { Binding as ListenerRemoteBinding, ListenerRemoteService } from '../../voice/listener-remote.js';
import { RateWindows, monotonicNow } from '../../utils/rate-windows.js';

/** Opaque per-identity search result maps (URLs never leave process memory). */
export interface CachedTrack {
  url: string;
  title: string;
  artist: string | null;
  duration: number;
}

export interface IdentityResults {
  byId: Map<string, CachedTrack>;
  expiresAt: number;
}

export interface SearchRuntime {
  queryCache: Map<string, { tracks: CachedTrack[]; expiresAt: number }>;
  identityResults: Map<string, IdentityResults>;
  identityInFlight: Set<string>;
  serverInFlight: Map<number, number>;
  serviceInFlight: number;
  now: () => number;
  searchRates: RateWindows;
}

const SEARCH_RATE_WINDOW_MS = 60_000;

/** Process-local runtimes keyed by the remote service instance. */
const searchRuntimes = new WeakMap<ListenerRemoteService, SearchRuntime>();
/** Remotes that already clear search maps from ListenerRemoteService.remove(). */
const searchInvalidationBound = new WeakSet<ListenerRemoteService>();

export function identityKey(binding: Pick<ListenerRemoteBinding, 'botId' | 'uid'>): string {
  return createHash('sha256').update(JSON.stringify([binding.botId, binding.uid])).digest('hex');
}

/** Wire grant removal → identity result clear once per remote service. */
function bindGrantInvalidation(remote: ListenerRemoteService): void {
  if (searchInvalidationBound.has(remote)) return;
  searchInvalidationBound.add(remote);
  remote.onGrantInvalidated((binding) => {
    // Clear on every reason (expiry, replace, revoke, reject) — search maps are credential-bound.
    clearListenerSearchResults(remote, binding);
  });
}

/** Create or return the process-local search runtime for this remote service. */
export function getOrCreateSearchRuntime(
  remote: ListenerRemoteService,
  clock: () => number = Date.now,
): SearchRuntime {
  bindGrantInvalidation(remote);
  let runtime = searchRuntimes.get(remote);
  if (!runtime) {
    runtime = {
      queryCache: new Map(),
      identityResults: new Map(),
      searchRates: new RateWindows(10_000, SEARCH_RATE_WINDOW_MS, clock === Date.now ? monotonicNow : clock),
      identityInFlight: new Set(),
      serverInFlight: new Map(),
      serviceInFlight: 0,
      now: clock,
    };
    searchRuntimes.set(remote, runtime);
  }
  return runtime;
}

/** Clear cached search results for one identity (session revoke / DELETE /session). */
export function clearListenerSearchResults(
  remote: ListenerRemoteService,
  binding: Pick<ListenerRemoteBinding, 'botId' | 'uid'>,
): void {
  searchRuntimes.get(remote)?.identityResults.delete(identityKey(binding));
}

/**
 * Admin revoke without a UID clears every cached search map for this process-local
 * remote service (no reverse index from botId → hashed identity keys).
 */
export function clearAllListenerSearchResults(remote: ListenerRemoteService): void {
  searchRuntimes.get(remote)?.identityResults.clear();
}
