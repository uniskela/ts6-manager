import { createHash } from 'node:crypto';
import type { Binding as ListenerRemoteBinding, ListenerRemoteService } from '../../voice/listener-remote.js';

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
  // RateWindows typed loosely here to avoid pulling the full search module graph.
  searchRates: {
    hit: (key: string, limits: readonly number[], index: number) => { count: number; limit: number; remainingMs: number };
    decrement: (key: string, index: number) => void;
  };
}

export const searchRuntimes = new WeakMap<ListenerRemoteService, SearchRuntime>();

export function identityKey(binding: Pick<ListenerRemoteBinding, 'botId' | 'uid'>): string {
  return createHash('sha256').update(JSON.stringify([binding.botId, binding.uid])).digest('hex');
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
