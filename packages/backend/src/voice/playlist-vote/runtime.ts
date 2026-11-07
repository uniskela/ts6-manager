import {
  BOT_COOLDOWN_MS,
  FAILED_REQUESTER_COOLDOWN_MS,
  OPEN_RATE_LIMIT,
  OPEN_RATE_WINDOW_MS,
  PlaylistVoteMachine,
  type PlaylistVoteEvent,
  type PlaylistVotePublic,
} from './state-machine.js';
import { QueueFullError, type QueueItem } from '../playlist/queue.js';

/** Same upcoming cap as listener append (F1). */
const MAX_UPCOMING_TRACKS = 500;

/** Ballot cast/change/withdraw: 10 per minute per identity (#442). */
export const BALLOT_RATE_LIMIT = 10;
export const BALLOT_RATE_WINDOW_MS = 60_000;
export const PLAYLIST_VOTE_WINDOW_MS = 60_000;

export type VoteBot = {
  status: string;
  queue: {
    upcomingCount: number;
    length: number;
    assertRoom: (count: number) => void;
    addMany: (items: QueueItem[]) => void;
    playAt: (index: number) => QueueItem | null;
  };
  videoSessionInfo?: () => unknown;
  play?: (item: QueueItem, opts?: { replaceSessionIds: string[] }) => Promise<unknown>;
  playStream?: (item: QueueItem, opts?: { replaceSessionIds: string[] }) => Promise<unknown>;
};

type Pending = {
  botId: number;
  playlistId: number;
  maxTracks: number;
  items: QueueItem[];
  /**
   * Clock when this stash was last loaded from live playlist state.
   * Post-deadline queue requires refreshedAtMs >= vote.deadlineMs so open-time
   * contents cannot be queued without an approval-time re-read.
   */
  refreshedAtMs: number;
};

function chan(botKey: string, channelId: string): string {
  return `${botKey}\0${channelId}`;
}

function ident(botKey: string, uid: string): string {
  return `${botKey}\0${uid}`;
}

/**
 * B2 machine plus the track stash the sync queue hook needs.
 * One pending playlist per bot+channel (same cardinality as open votes).
 */
export class PlaylistVoteRuntime {
  readonly machine: PlaylistVoteMachine;
  private readonly pending = new Map<string, Pending>();
  private readonly starts = new Map<string, { botId: number; item: QueueItem; items: QueueItem[] }>();
  private readonly getBot: (botId: number) => VoteBot | null | undefined;

  private readonly botCooldownUntil = new Map<string, number>();
  private readonly failedRequesterUntil = new Map<string, number>();
  private readonly openAttempts = new Map<string, number[]>();
  private readonly ballotAttempts = new Map<string, number[]>();

  constructor(getBot: (botId: number) => VoteBot | null | undefined) {
    this.getBot = getBot;
    this.machine = new PlaylistVoteMachine({
      queuePlaylist: (input) => {
        const key = chan(input.botKey, input.channelId);
        const pending = this.pending.get(key);
        if (!pending || pending.playlistId !== input.playlist.id) return 'playlist_unavailable';
        if (pending.items.length === 0 || pending.items.length > pending.maxTracks) {
          return 'playlist_unavailable';
        }
        // Defense in depth: never queue a pre-deadline stash after the window ends.
        if (input.nowMs >= input.deadlineMs && pending.refreshedAtMs < input.deadlineMs) {
          return 'playlist_unavailable';
        }
        const queued = this.addAllOrNothing(pending.botId, pending.items);
        // Always retain the queued snapshot for history / start — even when the bot
        // is already playing (startItem null) so deadline/ballot callers can persist once.
        if (queued.result === 'queued' && pending.items.length > 0) {
          this.starts.set(input.voteId, {
            botId: pending.botId,
            item: queued.startItem ?? pending.items[0]!,
            items: pending.items.slice(),
          });
        }
        this.pending.delete(key);
        return queued.result === 'queued' ? 'queued' : queued.result;
      },
    });
  }

  stash(botKey: string, channelId: string, pending: Pending): void {
    this.pending.set(chan(botKey, channelId), pending);
  }

  clearStash(botKey: string, channelId: string): void {
    this.pending.delete(chan(botKey, channelId));
  }

  takeStart(voteId: string): { botId: number; item: QueueItem; items: QueueItem[] } | null {
    const start = this.starts.get(voteId) ?? null;
    if (start) this.starts.delete(voteId);
    return start;
  }

  /** Process / bot restart: drop open votes and any pending stash (no queue). */
  onRestart(): void {
    this.machine.onRestart();
    this.pending.clear();
    this.starts.clear();
  }

  /** Bot move / disconnect / stop — cancel every open vote for this bot. */
  cancelBotUnavailable(botId: number, nowMs: number): void {
    const botKey = botKeyFor(botId);
    for (const open of this.machine.listOpenForBot(botKey)) {
      this.machine.cancelExternal({
        botKey,
        channelId: open.channelId,
        reason: 'bot_unavailable',
        listenerUids: [],
        nowMs,
      });
      this.clearStash(botKey, open.channelId);
    }
  }

  /** Admin/session revoke of one listener — cancel if they are the requester. */
  cancelRequesterRevoked(botId: number, uid: string, nowMs: number): void {
    const botKey = botKeyFor(botId);
    for (const open of this.machine.listOpenForBot(botKey)) {
      if (open.requesterUid !== uid) continue;
      this.machine.cancelExternal({
        botKey,
        channelId: open.channelId,
        reason: 'revoked',
        listenerUids: [],
        nowMs,
      });
      this.clearStash(botKey, open.channelId);
    }
  }

  /** Admin bot-wide revoke — cancel every open vote on that bot. */
  cancelAllRevoked(botId: number, nowMs: number): void {
    const botKey = botKeyFor(botId);
    for (const open of this.machine.listOpenForBot(botKey)) {
      this.machine.cancelExternal({
        botKey,
        channelId: open.channelId,
        reason: 'revoked',
        listenerUids: [],
        nowMs,
      });
      this.clearStash(botKey, open.channelId);
    }
  }

  /** Voting-off path: same all-or-nothing rules as the vote hook. */
  queueDirect(botId: number, items: QueueItem[]): { result: 'queued' | 'queue_full'; startItem: QueueItem | null } {
    const queued = this.addAllOrNothing(botId, items);
    if (queued.result === 'queued') return { result: 'queued', startItem: queued.startItem };
    return { result: 'queue_full', startItem: null };
  }

  private addAllOrNothing(
    botId: number,
    items: QueueItem[],
  ): { result: 'queued' | 'queue_full' | 'playlist_unavailable'; startItem: QueueItem | null } {
    const bot = this.getBot(botId);
    if (!bot) return { result: 'playlist_unavailable', startItem: null };
    try {
      if (bot.queue.upcomingCount + items.length > MAX_UPCOMING_TRACKS) {
        throw new QueueFullError(
          items.length,
          Math.max(0, MAX_UPCOMING_TRACKS - bot.queue.upcomingCount),
        );
      }
      bot.queue.assertRoom(items.length);
      const playIndex = bot.queue.length;
      bot.queue.addMany(items);
      const idle = bot.status === 'connected' && !bot.videoSessionInfo?.();
      const startItem = idle && items.length > 0 ? bot.queue.playAt(playIndex) : null;
      return { result: 'queued', startItem };
    } catch {
      return { result: 'queue_full', startItem: null };
    }
  }

  checkDirectOpenRate(botKey: string, requesterUid: string, nowMs: number): number | null {
    const botUntil = this.botCooldownUntil.get(botKey) ?? 0;
    if (nowMs < botUntil) return botUntil - nowMs;
    const failedUntil = this.failedRequesterUntil.get(ident(botKey, requesterUid)) ?? 0;
    if (nowMs < failedUntil) return failedUntil - nowMs;
    const key = ident(botKey, requesterUid);
    const recent = (this.openAttempts.get(key) ?? []).filter((t) => nowMs - t < OPEN_RATE_WINDOW_MS);
    this.openAttempts.set(key, recent);
    if (recent.length >= OPEN_RATE_LIMIT) return OPEN_RATE_WINDOW_MS - (nowMs - recent[0]!);
    return null;
  }

  recordDirectOpen(botKey: string, requesterUid: string, nowMs: number): void {
    const key = ident(botKey, requesterUid);
    const recent = (this.openAttempts.get(key) ?? []).filter((t) => nowMs - t < OPEN_RATE_WINDOW_MS);
    recent.push(nowMs);
    this.openAttempts.set(key, recent);
  }

  armDirectCooldown(botKey: string, requesterUid: string, nowMs: number, failed: boolean): void {
    this.botCooldownUntil.set(botKey, nowMs + BOT_COOLDOWN_MS);
    if (failed) {
      this.failedRequesterUntil.set(ident(botKey, requesterUid), nowMs + FAILED_REQUESTER_COOLDOWN_MS);
    }
  }

  checkBallotRate(botKey: string, voterUid: string, nowMs: number): number | null {
    const key = ident(botKey, voterUid);
    const recent = (this.ballotAttempts.get(key) ?? []).filter((t) => nowMs - t < BALLOT_RATE_WINDOW_MS);
    this.ballotAttempts.set(key, recent);
    if (recent.length >= BALLOT_RATE_LIMIT) return BALLOT_RATE_WINDOW_MS - (nowMs - recent[0]!);
    return null;
  }

  recordBallot(botKey: string, voterUid: string, nowMs: number): void {
    const key = ident(botKey, voterUid);
    const recent = (this.ballotAttempts.get(key) ?? []).filter((t) => nowMs - t < BALLOT_RATE_WINDOW_MS);
    recent.push(nowMs);
    this.ballotAttempts.set(key, recent);
  }

  view(
    botKey: string,
    channelId: string,
    viewerUid: string,
    listenerUids: readonly string[],
    nowMs: number,
  ): PlaylistVotePublic | null {
    return this.machine.viewForState(botKey, channelId, viewerUid, listenerUids, nowMs);
  }
}

export function botKeyFor(botId: number): string {
  return String(botId);
}

export function channelIdFor(channelId: number): string {
  return String(channelId);
}

export function eventsQueued(events: readonly PlaylistVoteEvent[]): boolean {
  return events.some((event) => event.type === 'queue');
}

/** Best-effort start after an accepted all-or-nothing queue; never undoes the queue. */
export async function startCurrentIfIdle(bot: VoteBot, item: QueueItem | null | undefined): Promise<void> {
  if (!item) return;
  if (bot.status !== 'connected') return;
  if (bot.videoSessionInfo?.()) return;
  try {
    if (item.streamUrl && bot.playStream) await bot.playStream(item, { replaceSessionIds: [] });
    else if (bot.play) await bot.play(item, { replaceSessionIds: [] });
  } catch {
    /* queue already accepted */
  }
}

export function playlistVotesOf(app: { locals: Record<string, unknown> }, getBot: (botId: number) => VoteBot | null | undefined): PlaylistVoteRuntime {
  const existing = app.locals.playlistVotes;
  if (existing instanceof PlaylistVoteRuntime) return existing;
  const runtime = new PlaylistVoteRuntime(getBot);
  app.locals.playlistVotes = runtime;
  return runtime;
}
