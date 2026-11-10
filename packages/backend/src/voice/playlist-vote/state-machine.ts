import { randomBytes } from 'node:crypto';
import { playlistVoteApprovalsNeeded } from '@ts6/common';

export type PlaylistVoteBallot = 'yes' | 'no';

export type PlaylistVoteStatus = 'open' | 'passed' | 'failed' | 'cancelled';

export type PlaylistVoteEndReason =
  | 'approved'
  | 'deadline'
  | 'requester_cancelled'
  | 'requester_left'
  | 'bot_unavailable'
  | 'revoked'
  | 'playlist_unavailable'
  | 'queue_full'
  | 'listeners_unavailable';

export type PlaylistVoteSettings = {
  /** Percent 1–100; approvals needed = ceil(percent/100 * listeners), at least 1. */
  thresholdPercent: number;
  windowMs: number;
  /** B3 supplies AppSetting `maxRequestSize` here. */
  maxTracks: number;
};

export type PlaylistVotePlaylist = {
  id: number;
  name: string;
  trackCount: number;
};

export type PlaylistVotePublic = {
  id: string;
  status: PlaylistVoteStatus;
  reason: PlaylistVoteEndReason | null;
  playlist: { id: number | null; name: string; trackCount: number };
  yes: number;
  no: number;
  needed: number;
  listeners: number;
  thresholdPercent: number;
  deadline: string;
  ownBallot: PlaylistVoteBallot | null;
  isRequester: boolean;
};

export type OpenPlaylistVoteInput = {
  botKey: string;
  channelId: string;
  requesterUid: string;
  playlist: PlaylistVotePlaylist;
  settings: PlaylistVoteSettings;
  /** Human listener UIDs currently in the bot channel (fresh). */
  listenerUids: readonly string[];
  nowMs: number;
};

export type BallotInput = {
  voteId: string;
  botKey: string;
  channelId: string;
  voterUid: string;
  choice: PlaylistVoteBallot;
  listenerUids: readonly string[];
  nowMs: number;
};

/**
 * All-or-nothing queue decision.
 * A refusal closes the vote as failed with that reason and emits no `queue` event.
 */
export type QueuePlaylistHook = (input: {
  voteId: string;
  botKey: string;
  channelId: string;
  requesterUid: string;
  playlist: PlaylistVotePlaylist;
  /** Wall clock for the decision; used with deadlineMs to refuse stale post-deadline stash. */
  nowMs: number;
  deadlineMs: number;
}) => 'queued' | 'queue_full' | 'playlist_unavailable';

type InternalVote = {
  id: string;
  botKey: string;
  channelId: string;
  requesterUid: string;
  playlist: PlaylistVotePlaylist;
  thresholdPercent: number;
  deadlineMs: number;
  ballots: Map<string, PlaylistVoteBallot>;
  status: PlaylistVoteStatus;
  reason: PlaylistVoteEndReason | null;
  closedAtMs: number | null;
  /** Listener set used for the final public tally (frozen at close). */
  closedListenerUids: readonly string[] | null;
  /** At most one open + one result announcement. */
  announcedOpen: boolean;
  announcedResult: boolean;
};

export type PlaylistVoteEvent =
  | { type: 'announce_open'; vote: PlaylistVotePublic }
  | { type: 'announce_result'; vote: PlaylistVotePublic }
  | { type: 'queue'; playlistId: number; trackCount: number; voteId: string };

export const BOT_COOLDOWN_MS = 120_000;
export const FAILED_REQUESTER_COOLDOWN_MS = 5 * 60_000;
export const OPEN_RATE_LIMIT = 3;
export const OPEN_RATE_WINDOW_MS = 10 * 60_000;

const DEFAULT_CLOSED_VISIBLE_MS = 30_000;

function opaqueVoteId(): string {
  return randomBytes(16).toString('base64url');
}

/** Authoritative approval math lives in `@ts6/common` so B1 UI and B2 stay aligned. */
export const approvalsNeeded = playlistVoteApprovalsNeeded;

function countBallots(
  ballots: Map<string, PlaylistVoteBallot>,
  listeners: ReadonlySet<string>,
): { yes: number; no: number } {
  let yes = 0;
  let no = 0;
  for (const [uid, choice] of ballots) {
    if (!listeners.has(uid)) continue;
    if (choice === 'yes') yes += 1;
    else no += 1;
  }
  return { yes, no };
}

function toPublic(
  vote: InternalVote,
  viewerUid: string | null,
  listenerUids: readonly string[],
  playlistVisible = true,
): PlaylistVotePublic {
  // Closed tallies stay frozen at the electorate that decided the result.
  const tallyUids = vote.status === 'open' || !vote.closedListenerUids
    ? listenerUids
    : vote.closedListenerUids;
  const listeners = new Set(tallyUids);
  const { yes, no } = countBallots(vote.ballots, listeners);
  const listenerCount = listeners.size;
  return {
    id: vote.id,
    status: vote.status,
    reason: vote.reason,
    playlist: {
      id: playlistVisible ? vote.playlist.id : null,
      name: vote.playlist.name,
      trackCount: vote.playlist.trackCount,
    },
    yes,
    no,
    needed: approvalsNeeded(vote.thresholdPercent, listenerCount),
    listeners: listenerCount,
    thresholdPercent: vote.thresholdPercent,
    deadline: new Date(vote.deadlineMs).toISOString(),
    ownBallot: viewerUid ? vote.ballots.get(viewerUid) ?? null : null,
    isRequester: viewerUid === vote.requesterUid,
  };
}

export type PlaylistVoteMachineOptions = {
  closedVisibleMs?: number;
  queuePlaylist?: QueuePlaylistHook;
  botCooldownMs?: number;
  failedRequesterCooldownMs?: number;
  openRateLimit?: number;
  openRateWindowMs?: number;
};

/**
 * Process restart drops open votes and queues nothing.
 * Voting-off paths stay outside this module.
 */
export class PlaylistVoteMachine {
  private readonly open = new Map<string, InternalVote>();
  private readonly closed = new Map<string, InternalVote>();
  private readonly closedVisibleMs: number;
  private readonly queuePlaylist: QueuePlaylistHook;
  private readonly botCooldownMs: number;
  private readonly failedRequesterCooldownMs: number;
  private readonly openRateLimit: number;
  private readonly openRateWindowMs: number;
  private readonly botCooldownUntil = new Map<string, number>();
  private readonly failedRequesterUntil = new Map<string, number>();
  private readonly openAttempts = new Map<string, number[]>();

  constructor(opts?: PlaylistVoteMachineOptions) {
    this.closedVisibleMs = opts?.closedVisibleMs ?? DEFAULT_CLOSED_VISIBLE_MS;
    this.queuePlaylist = opts?.queuePlaylist ?? (() => 'queued');
    this.botCooldownMs = opts?.botCooldownMs ?? BOT_COOLDOWN_MS;
    this.failedRequesterCooldownMs = opts?.failedRequesterCooldownMs ?? FAILED_REQUESTER_COOLDOWN_MS;
    this.openRateLimit = opts?.openRateLimit ?? OPEN_RATE_LIMIT;
    this.openRateWindowMs = opts?.openRateWindowMs ?? OPEN_RATE_WINDOW_MS;
  }

  private key(botKey: string, channelId: string): string {
    return `${botKey}\0${channelId}`;
  }

  private identityKey(botKey: string, uid: string): string {
    return `${botKey}\0${uid}`;
  }

  clear(): void {
    this.open.clear();
    this.closed.clear();
  }

  onRestart(): void {
    this.open.clear();
  }

  getOpen(botKey: string, channelId: string): InternalVote | undefined {
    return this.open.get(this.key(botKey, channelId));
  }

  /** Open votes for one bot (any channel). Snapshot for lifecycle cancel. */
  listOpenForBot(botKey: string): Array<{ id: string; channelId: string; requesterUid: string }> {
    const out: Array<{ id: string; channelId: string; requesterUid: string }> = [];
    for (const vote of this.open.values()) {
      if (vote.botKey === botKey && vote.status === 'open') {
        out.push({ id: vote.id, channelId: vote.channelId, requesterUid: vote.requesterUid });
      }
    }
    return out;
  }

  /**
   * View for `/state`: open vote, or last closed vote while within visibility window.
   */
  viewForState(
    botKey: string,
    channelId: string,
    viewerUid: string,
    listenerUids: readonly string[],
    nowMs: number,
  ): PlaylistVotePublic | null {
    const k = this.key(botKey, channelId);
    const open = this.open.get(k);
    if (open) return toPublic(open, viewerUid, listenerUids);
    const closed = this.closed.get(k);
    if (!closed || closed.closedAtMs === null) return null;
    if (nowMs - closed.closedAtMs > this.closedVisibleMs) {
      this.closed.delete(k);
      return null;
    }
    return toPublic(closed, viewerUid, listenerUids);
  }

  /**
   * Open a vote, or return the existing one for the same requester+playlist.
   * Sole-listener auto-pass queues through the hook with no open window.
   */
  openVote(input: OpenPlaylistVoteInput): {
    ok: true;
    created: boolean;
    vote: PlaylistVotePublic;
    events: PlaylistVoteEvent[];
  } | {
    ok: false;
    code: 'vote_running' | 'request_too_large' | 'playlist_empty' | 'listeners_unavailable' | 'rate_limited';
    retryAfterMs?: number;
  } {
    const { playlist, settings, listenerUids, requesterUid, nowMs } = input;
    if (playlist.trackCount <= 0) return { ok: false, code: 'playlist_empty' };
    if (playlist.trackCount > settings.maxTracks) return { ok: false, code: 'request_too_large' };
    if (listenerUids.length === 0) return { ok: false, code: 'listeners_unavailable' };
    if (!listenerUids.includes(requesterUid)) return { ok: false, code: 'listeners_unavailable' };

    const k = this.key(input.botKey, input.channelId);
    const existing = this.open.get(k);
    if (existing) {
      if (existing.requesterUid === requesterUid && existing.playlist.id === playlist.id) {
        return {
          ok: true,
          created: false,
          vote: toPublic(existing, requesterUid, listenerUids),
          events: [],
        };
      }
      return { ok: false, code: 'vote_running' };
    }

    const limited = this.checkOpenRate(input.botKey, requesterUid, nowMs);
    if (limited) return { ok: false, code: 'rate_limited', retryAfterMs: limited };
    this.recordOpenAttempt(input.botKey, requesterUid, nowMs);

    if (listenerUids.length === 1 && listenerUids[0] === requesterUid) {
      const id = opaqueVoteId();
      const deadlineMs = nowMs + settings.windowMs;
      const queued = this.queuePlaylist({
        voteId: id,
        botKey: input.botKey,
        channelId: input.channelId,
        requesterUid,
        playlist,
        nowMs,
        deadlineMs,
      });
      const vote: InternalVote = {
        id,
        botKey: input.botKey,
        channelId: input.channelId,
        requesterUid,
        playlist: { ...playlist },
        thresholdPercent: settings.thresholdPercent,
        deadlineMs,
        ballots: new Map([[requesterUid, 'yes']]),
        status: queued === 'queued' ? 'passed' : 'failed',
        reason: queued === 'queued' ? 'approved' : queued,
        closedAtMs: nowMs,
        closedListenerUids: [...listenerUids],
        announcedOpen: false,
        announcedResult: true,
      };
      this.closed.set(k, vote);
      this.armBotCooldown(input.botKey, nowMs);
      if (queued !== 'queued') this.markFailedRequester(input.botKey, requesterUid, nowMs);
      const pub = toPublic(vote, requesterUid, listenerUids);
      const events: PlaylistVoteEvent[] = [{ type: 'announce_result', vote: pub }];
      if (queued === 'queued') {
        events.unshift({ type: 'queue', playlistId: playlist.id, trackCount: playlist.trackCount, voteId: id });
      }
      return { ok: true, created: true, vote: pub, events };
    }

    const id = opaqueVoteId();
    const vote: InternalVote = {
      id,
      botKey: input.botKey,
      channelId: input.channelId,
      requesterUid,
      playlist: { ...playlist },
      thresholdPercent: settings.thresholdPercent,
      deadlineMs: nowMs + settings.windowMs,
      ballots: new Map([[requesterUid, 'yes']]),
      status: 'open',
      reason: null,
      closedAtMs: null,
      closedListenerUids: null,
      announcedOpen: true,
      announcedResult: false,
    };
    this.open.set(k, vote);
    const pub = toPublic(vote, requesterUid, listenerUids);
    const events: PlaylistVoteEvent[] = [{ type: 'announce_open', vote: pub }];

    const resolved = this.tryPass(vote, listenerUids, nowMs);
    if (resolved === 'passed') {
      const after = toPublic(vote, requesterUid, listenerUids);
      return {
        ok: true,
        created: true,
        vote: after,
        events: [
          ...events,
          { type: 'queue', playlistId: playlist.id, trackCount: playlist.trackCount, voteId: id },
          { type: 'announce_result', vote: after },
        ],
      };
    }
    if (resolved === 'queue_failed' || resolved === 'cancelled') {
      const after = toPublic(vote, requesterUid, listenerUids);
      return {
        ok: true,
        created: true,
        vote: after,
        events: [...events, { type: 'announce_result', vote: after }],
      };
    }

    return { ok: true, created: true, vote: pub, events };
  }

  castBallot(input: BallotInput): {
    ok: true;
    vote: PlaylistVotePublic;
    events: PlaylistVoteEvent[];
  } | {
    ok: false;
    code: 'not_found' | 'invalid_request' | 'listeners_unavailable';
  } {
    const vote = this.requireOpen(input.voteId, input.botKey, input.channelId);
    if (!vote) return { ok: false, code: 'not_found' };
    if (!this.ensureOpenBeforeDeadline(vote, input.listenerUids, input.nowMs)) {
      return { ok: false, code: 'not_found' };
    }
    if (!input.listenerUids.includes(input.voterUid)) {
      return { ok: false, code: 'listeners_unavailable' };
    }

    if (input.voterUid === vote.requesterUid && input.choice === 'no') {
      return this.close(vote, 'cancelled', 'requester_cancelled', input.listenerUids, input.nowMs, input.voterUid);
    }

    vote.ballots.set(input.voterUid, input.choice);
    const events: PlaylistVoteEvent[] = [];
    const resolved = this.tryPass(vote, input.listenerUids, input.nowMs);
    if (resolved === 'passed') {
      const pub = toPublic(vote, input.voterUid, input.listenerUids);
      events.push(
        { type: 'queue', playlistId: vote.playlist.id, trackCount: vote.playlist.trackCount, voteId: vote.id },
        { type: 'announce_result', vote: pub },
      );
      return { ok: true, vote: pub, events };
    }
    if (resolved === 'queue_failed' || resolved === 'cancelled') {
      const pub = toPublic(vote, input.voterUid, input.listenerUids);
      events.push({ type: 'announce_result', vote: pub });
      return { ok: true, vote: pub, events };
    }
    return { ok: true, vote: toPublic(vote, input.voterUid, input.listenerUids), events };
  }

  withdrawBallot(input: Omit<BallotInput, 'choice'>): {
    ok: true;
    vote: PlaylistVotePublic;
  } | {
    ok: false;
    code: 'not_found' | 'invalid_request' | 'listeners_unavailable';
  } {
    const vote = this.requireOpen(input.voteId, input.botKey, input.channelId);
    if (!vote) return { ok: false, code: 'not_found' };
    if (!this.ensureOpenBeforeDeadline(vote, input.listenerUids, input.nowMs)) {
      return { ok: false, code: 'not_found' };
    }
    if (input.voterUid === vote.requesterUid) return { ok: false, code: 'invalid_request' };
    if (!input.listenerUids.includes(input.voterUid)) {
      return { ok: false, code: 'listeners_unavailable' };
    }
    vote.ballots.delete(input.voterUid);
    return { ok: true, vote: toPublic(vote, input.voterUid, input.listenerUids) };
  }

  cancelByRequester(input: {
    voteId: string;
    botKey: string;
    channelId: string;
    requesterUid: string;
    listenerUids: readonly string[];
    nowMs: number;
  }): { ok: true; vote: PlaylistVotePublic; events: PlaylistVoteEvent[] } | { ok: false; code: 'not_found' | 'permission_denied' } {
    const vote = this.requireOpen(input.voteId, input.botKey, input.channelId);
    if (!vote) return { ok: false, code: 'not_found' };
    if (vote.requesterUid !== input.requesterUid) return { ok: false, code: 'permission_denied' };
    if (!this.ensureOpenBeforeDeadline(vote, input.listenerUids, input.nowMs)) {
      return { ok: false, code: 'not_found' };
    }
    return this.close(vote, 'cancelled', 'requester_cancelled', input.listenerUids, input.nowMs, input.requesterUid);
  }

  tickDeadline(input: {
    botKey: string;
    channelId: string;
    listenerUids: readonly string[] | null;
    nowMs: number;
  }): PlaylistVoteEvent[] {
    const vote = this.open.get(this.key(input.botKey, input.channelId));
    if (!vote || vote.status !== 'open') return [];
    if (input.nowMs < vote.deadlineMs) return [];
    if (input.listenerUids === null) {
      const closed = this.close(vote, 'failed', 'listeners_unavailable', [], input.nowMs, null);
      return closed.ok ? closed.events : [];
    }
    if (input.listenerUids.length === 0) {
      return this.closeSilent(vote, 'failed', 'deadline', input.nowMs);
    }
    const resolved = this.tryPass(vote, input.listenerUids, input.nowMs);
    if (resolved === 'passed') {
      const pub = toPublic(vote, null, input.listenerUids);
      return [
        { type: 'queue', playlistId: vote.playlist.id, trackCount: vote.playlist.trackCount, voteId: vote.id },
        { type: 'announce_result', vote: pub },
      ];
    }
    if (resolved === 'queue_failed' || resolved === 'cancelled') {
      const pub = toPublic(vote, null, input.listenerUids);
      return [{ type: 'announce_result', vote: pub }];
    }
    const closed = this.close(vote, 'failed', 'deadline', input.listenerUids, input.nowMs, null);
    return closed.ok ? closed.events : [];
  }

  cancelExternal(input: {
    botKey: string;
    channelId: string;
    reason: Extract<
      PlaylistVoteEndReason,
      'requester_left' | 'bot_unavailable' | 'revoked' | 'playlist_unavailable' | 'queue_full'
    >;
    listenerUids: readonly string[];
    nowMs: number;
  }): PlaylistVoteEvent[] {
    const vote = this.open.get(this.key(input.botKey, input.channelId));
    if (!vote) return [];
    const closed = this.close(vote, 'cancelled', input.reason, input.listenerUids, input.nowMs, null);
    return closed.ok ? closed.events : [];
  }

  private requireOpen(voteId: string, botKey: string, channelId: string): InternalVote | null {
    const vote = this.open.get(this.key(botKey, channelId));
    if (!vote || vote.id !== voteId || vote.status !== 'open') return null;
    return vote;
  }

  /**
   * Ballot and cancel paths must not mutate a vote after its window ends.
   * Expire through the same deadline path as `tickDeadline`, then refuse the action.
   */
  private ensureOpenBeforeDeadline(
    vote: InternalVote,
    listenerUids: readonly string[],
    nowMs: number,
  ): boolean {
    if (nowMs < vote.deadlineMs) return true;
    this.tickDeadline({
      botKey: vote.botKey,
      channelId: vote.channelId,
      listenerUids,
      nowMs,
    });
    return false;
  }

  private tryPass(
    vote: InternalVote,
    listenerUids: readonly string[],
    nowMs: number,
  ): 'passed' | 'queue_failed' | 'cancelled' | false {
    if (vote.status !== 'open') return false;
    const listeners = new Set(listenerUids);
    for (const uid of [...vote.ballots.keys()]) {
      if (!listeners.has(uid)) vote.ballots.delete(uid);
    }
    if (!listeners.has(vote.requesterUid)) {
      this.close(vote, 'cancelled', 'requester_left', listenerUids, nowMs, null);
      return 'cancelled';
    }
    vote.ballots.set(vote.requesterUid, 'yes');
    const { yes } = countBallots(vote.ballots, listeners);
    const needed = approvalsNeeded(vote.thresholdPercent, listeners.size);
    if (yes < needed) return false;

    const queued = this.queuePlaylist({
      voteId: vote.id,
      botKey: vote.botKey,
      channelId: vote.channelId,
      requesterUid: vote.requesterUid,
      playlist: vote.playlist,
      nowMs,
      deadlineMs: vote.deadlineMs,
    });
    if (queued !== 'queued') {
      this.close(vote, 'failed', queued, listenerUids, nowMs, null);
      return 'queue_failed';
    }

    vote.status = 'passed';
    vote.reason = 'approved';
    vote.closedAtMs = nowMs;
    vote.closedListenerUids = [...listenerUids];
    vote.announcedResult = true;
    const k = this.key(vote.botKey, vote.channelId);
    this.open.delete(k);
    this.closed.set(k, vote);
    this.armBotCooldown(vote.botKey, nowMs);
    return 'passed';
  }

  private close(
    vote: InternalVote,
    status: 'passed' | 'failed' | 'cancelled',
    reason: PlaylistVoteEndReason,
    listenerUids: readonly string[],
    nowMs: number,
    viewerUid: string | null,
  ): { ok: true; vote: PlaylistVotePublic; events: PlaylistVoteEvent[] } {
    vote.status = status;
    vote.reason = reason;
    vote.closedAtMs = nowMs;
    vote.closedListenerUids = [...listenerUids];
    vote.announcedResult = true;
    const k = this.key(vote.botKey, vote.channelId);
    this.open.delete(k);
    this.closed.set(k, vote);
    this.armBotCooldown(vote.botKey, nowMs);
    if (status === 'failed') this.markFailedRequester(vote.botKey, vote.requesterUid, nowMs);
    const pub = toPublic(vote, viewerUid, listenerUids);
    return { ok: true, vote: pub, events: [{ type: 'announce_result', vote: pub }] };
  }

  private closeSilent(
    vote: InternalVote,
    status: 'failed',
    reason: PlaylistVoteEndReason,
    nowMs: number,
  ): PlaylistVoteEvent[] {
    vote.status = status;
    vote.reason = reason;
    vote.closedAtMs = nowMs;
    vote.closedListenerUids = [];
    const k = this.key(vote.botKey, vote.channelId);
    this.open.delete(k);
    this.closed.set(k, vote);
    this.armBotCooldown(vote.botKey, nowMs);
    this.markFailedRequester(vote.botKey, vote.requesterUid, nowMs);
    return [];
  }

  private checkOpenRate(botKey: string, requesterUid: string, nowMs: number): number | null {
    const botUntil = this.botCooldownUntil.get(botKey) ?? 0;
    if (nowMs < botUntil) return botUntil - nowMs;
    const failedUntil = this.failedRequesterUntil.get(this.identityKey(botKey, requesterUid)) ?? 0;
    if (nowMs < failedUntil) return failedUntil - nowMs;
    const key = this.identityKey(botKey, requesterUid);
    const recent = (this.openAttempts.get(key) ?? []).filter((t) => nowMs - t < this.openRateWindowMs);
    this.openAttempts.set(key, recent);
    if (recent.length >= this.openRateLimit) {
      return this.openRateWindowMs - (nowMs - recent[0]!);
    }
    return null;
  }

  private recordOpenAttempt(botKey: string, requesterUid: string, nowMs: number): void {
    const key = this.identityKey(botKey, requesterUid);
    const recent = (this.openAttempts.get(key) ?? []).filter((t) => nowMs - t < this.openRateWindowMs);
    recent.push(nowMs);
    this.openAttempts.set(key, recent);
  }

  private armBotCooldown(botKey: string, nowMs: number): void {
    this.botCooldownUntil.set(botKey, nowMs + this.botCooldownMs);
  }

  private markFailedRequester(botKey: string, requesterUid: string, nowMs: number): void {
    this.failedRequesterUntil.set(this.identityKey(botKey, requesterUid), nowMs + this.failedRequesterCooldownMs);
  }
}
