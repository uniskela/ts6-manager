import type { Binding, ListenerRemoteService } from '../listener-remote.js';
import type { PlaylistVoteRuntime } from './runtime.js';

/** Process-local: one runtime per remote service (same cardinality as search cache). */
const runtimes = new WeakMap<ListenerRemoteService, PlaylistVoteRuntime>();
const bound = new WeakSet<ListenerRemoteService>();

/**
 * Wire grant invalidation → requester vote cancel, and remember the runtime for
 * bot disconnect paths that revoke without going through HTTP.
 */
export function bindPlaylistVoteLifecycle(
  remote: ListenerRemoteService,
  runtime: PlaylistVoteRuntime,
): void {
  runtimes.set(remote, runtime);
  if (bound.has(remote)) return;
  bound.add(remote);
  remote.onGrantInvalidated((binding: Binding) => {
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
