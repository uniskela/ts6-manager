/**
 * Channel-chat delivery for PlaylistVoteMachine announce_* events.
 * Best-effort only: never throws into the authoritative vote/queue path.
 */
import type { PlaylistVoteEvent, PlaylistVotePublic } from './state-machine.js';

/** Keep in sync with PLAYLIST_VOTE_WINDOW_MS in runtime.ts (avoid import cycle). */
const WINDOW_SECONDS = 60;
const MAX_PLAYLIST_NAME = 64;
const MAX_MESSAGE = 400;

/** Optional channel chatter (VoiceBot). Narrow VoteBot doubles may omit methods. */
export type AnnounceBot = unknown;

/** Process-local dedupe so concurrent paths cannot double-post the same vote event. */
const delivered = new Map<string, number>();
const DELIVERED_TTL_MS = 10 * 60_000;
const DELIVERED_MAX = 500;

function pruneDelivered(now: number): void {
  if (delivered.size <= DELIVERED_MAX) return;
  for (const [key, at] of delivered) {
    if (now - at > DELIVERED_TTL_MS) delivered.delete(key);
  }
  while (delivered.size > DELIVERED_MAX) {
    const first = delivered.keys().next().value;
    if (first === undefined) break;
    delivered.delete(first);
  }
}

/** Strip controls/URLs and bound length — never trust playlist names for chat. */
export function sanitizePlaylistAnnounceName(raw: string): string {
  let name = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`"\\]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return 'playlist';
  if (name.length > MAX_PLAYLIST_NAME) name = `${name.slice(0, MAX_PLAYLIST_NAME - 1)}…`;
  return name;
}

function clampMessage(msg: string): string {
  if (msg.length <= MAX_MESSAGE) return msg;
  return `${msg.slice(0, MAX_MESSAGE - 1)}…`;
}

/** Plain channel copy — no UIDs, voter names, tokens, or URLs. */
export function formatPlaylistVoteAnnounce(event: Extract<PlaylistVoteEvent, { type: `announce_${string}` }>): string {
  const vote = event.vote;
  const name = sanitizePlaylistAnnounceName(vote.playlist.name);
  const tracks = Number.isFinite(vote.playlist.trackCount) ? Math.max(0, Math.floor(vote.playlist.trackCount)) : 0;
  if (event.type === 'announce_open') {
    return clampMessage(
      `Playlist vote: "${name}" (${tracks} track${tracks === 1 ? '' : 's'}) — `
      + `${vote.yes} yes, needs ${vote.needed} of ${vote.listeners} · ${WINDOW_SECONDS}s. `
      + 'Type !playlistvote yes or !playlistvote no.',
    );
  }
  return clampMessage(formatResult(vote, name, tracks));
}

function formatResult(vote: PlaylistVotePublic, name: string, tracks: number): string {
  if (vote.status === 'passed') {
    return `Playlist vote passed: "${name}" (${tracks} track${tracks === 1 ? '' : 's'}) — queued.`;
  }
  if (vote.status === 'cancelled') {
    return `Playlist vote cancelled: "${name}".`;
  }
  const reason = vote.reason === 'deadline'
    ? 'not enough yes votes'
    : vote.reason === 'queue_full'
      ? 'queue full'
      : vote.reason === 'playlist_unavailable' || vote.reason === 'listeners_unavailable'
        ? 'playlist unavailable'
        : 'ended';
  return `Playlist vote failed: "${name}" — ${reason}.`;
}

/**
 * Deliver at most the announce_* events already emitted by the machine.
 * Skips when the bot left the vote channel; flood hold drops inside sendChannelMessage.
 */
export function deliverPlaylistVoteAnnouncements(
  bot: AnnounceBot,
  voteChannelId: number,
  events: readonly PlaylistVoteEvent[],
  nowMs: number = Date.now(),
): void {
  if (!bot || typeof bot !== 'object') return;
  const chatter = bot as {
    sendChannelMessage?: (msg: string) => void;
    getCurrentChannelId?: () => number | null | undefined;
  };
  if (typeof chatter.sendChannelMessage !== 'function' || typeof chatter.getCurrentChannelId !== 'function') return;
  if (!Number.isSafeInteger(voteChannelId) || voteChannelId <= 0) return;
  try {
    if (chatter.getCurrentChannelId() !== voteChannelId) return;
    pruneDelivered(nowMs);
    for (const event of events) {
      if (event.type !== 'announce_open' && event.type !== 'announce_result') continue;
      const key = `${event.vote.id}:${event.type}`;
      if (delivered.has(key)) continue;
      delivered.set(key, nowMs);
      chatter.sendChannelMessage(formatPlaylistVoteAnnounce(event));
    }
  } catch {
    // Chat delivery must never change the authoritative vote/queue decision.
  }
}

/** Test helper — clear delivery dedupe between cases. */
export function resetPlaylistVoteAnnounceDedupeForTests(): void {
  delivered.clear();
}
