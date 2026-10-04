/**
 * HTTP play-url playlist expansion generation — independent of chat
 * (`invalidateChatPlaylistExpansion`). Both must be advanced on stop/clear
 * so a leftover expansion from the other path cannot refill the queue.
 */
const playlistExpandGeneration = new Map<number, number>();

/** Advance so pending HTTP play-url background work for this bot is discarded. */
export function invalidatePlaylistExpansion(botId: number): number {
  const next = (playlistExpandGeneration.get(botId) ?? 0) + 1;
  playlistExpandGeneration.set(botId, next);
  return next;
}

export function playlistExpansionGeneration(botId: number): number {
  return playlistExpandGeneration.get(botId) ?? 0;
}
