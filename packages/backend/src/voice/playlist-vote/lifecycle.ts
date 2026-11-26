import type { Binding, GrantInvalidationReason, ListenerRemoteService } from '../listener-remote.js';
import type { PlaylistVoteRuntime } from './runtime.js';

/** Process-local: one runtime per remote service (same cardinality as search cache). */
const runtimes = new WeakMap<ListenerRemoteService, PlaylistVoteRuntime>();
const bound = new WeakSet<ListenerRemoteService>();

/** Reasons that mean the listener is gone or was explicitly cut off — not mere credential TTL. */
function cancelsOpenVote(reason: GrantInvalidationReason): boolean {
  return reason === 'revoked' || reason === 'rejected';
}

/**
 * Wire grant invalidation → requester vote cancel (reason-aware), and remember
 * the runtime for bot disconnect paths that revoke without going through HTTP.
 *
 * #442: ordinary session expiry / !remote replacement must not cancel a vote.
 */
export function bindPlaylistVoteLifecycle(
  remote: ListenerRemoteService,
  runtime: PlaylistVoteRuntime,
): void {
  runtimes.set(remote, runtime);
  if (bound.has(remote)) return;
  bound.add(remote);
  remote.onGrantInvalidated((binding: Binding, reason: GrantInvalidationReason) => {
    if (!cancelsOpenVote(reason)) return;
    const votes = runtimes.get(remote);
    if (!votes) return;
    votes.cancelRequesterRevoked(binding.botId, binding.uid, Date.now());
  });
}

export function playlistVotesForRemote(
  remote: ListenerRemoteService | null | undefined,
): PlaylistVoteRuntime | undefined {
  return remote ? runtimes.get(remote) : undefined;
}

/** Bot move / disconnect / stop — cancel without waiting for a later HTTP request. */
export function cancelPlaylistVotesBotUnavailable(
  remote: ListenerRemoteService | null | undefined,
  botId: number,
  nowMs: number = Date.now(),
): void {
  playlistVotesForRemote(remote)?.cancelBotUnavailable(botId, nowMs);
}
