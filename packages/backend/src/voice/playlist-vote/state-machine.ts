/**
 * Whole-playlist vote state machine (roadmap #442 B2 / K1).
 * Pure: no I/O, no Prisma, no chat. Callers inject clock and listener lists.
 * Unreachable from routes until B3 wires it.
 */

import { randomBytes } from 'node:crypto';

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
  /** Open-window length in ms (K1 default 60_000). */
  windowMs: number;
  /** Maximum tracks allowed in one whole-playlist request. */
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
  /** At most one open + one result announcement. */
  announcedOpen: boolean;
  announcedResult: boolean;
};

export type PlaylistVoteEvent =
  | { type: 'announce_open'; vote: PlaylistVotePublic }
  | { type: 'announce_result'; vote: PlaylistVotePublic }
  | { type: 'queue'; playlistId: number; trackCount: number; voteId: string };

const DEFAULT_CLOSED_VISIBLE_MS = 30_000;

function opaqueVoteId(): string {
  return randomBytes(16).toString('base64url');
}

/** Approvals needed = ceil(threshold% × listeners), at least 1. Zero listeners → 1 (but open is refused). */
export function approvalsNeeded(thresholdPercent: number, listenerCount: number): number {
  if (listenerCount <= 0) return 1;
  const pct = Math.min(100, Math.max(1, Math.floor(thresholdPercent)));
  return Math.max(1, Math.ceil((pct / 100) * listenerCount));
}

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
  const listeners = new Set(listenerUids);
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

/**
 * In-memory registry: one open vote per bot+channel.
 * Process restart drops everything (product rule).
 */
export class PlaylistVoteMachine {
  private readonly open = new Map<string, InternalVote>();
  private readonly closed = new Map<string, InternalVote>();
  private readonly closedVisibleMs: number;

  constructor(opts?: { closedVisibleMs?: number }) {
    this.closedVisibleMs = opts?.closedVisibleMs ?? DEFAULT_CLOSED_VISIBLE_MS;
  }

  private key(botKey: string, channelId: string): string {
    return `${botKey}\0${channelId}`;
  }

  clear(): void {
    this.open.clear();
    this.closed.clear();
  }

  /** Drop every open vote (bot restart / process recycle). Nothing is queued. */
  onRestart(): void {
    this.open.clear();
  }

  getOpen(botKey: string, channelId: string): InternalVote | undefined {
    return this.open.get(this.key(botKey, channelId));
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
   * Caller must already have refused oversize playlists and voting-off / sole-listener direct queue.
   */
  openVote(input: OpenPlaylistVoteInput): {
    ok: true;
    created: boolean;
    vote: PlaylistVotePublic;
    events: PlaylistVoteEvent[];
  } | {
    ok: false;
    code: 'vote_running' | 'request_too_large' | 'playlist_empty' | 'listeners_unavailable';
  } {
    const { playlist, settings, listenerUids, requesterUid, nowMs } = input;
    if (playlist.trackCount <= 0) return { ok: false, code: 'playlist_empty' };
    if (playlist.trackCount > settings.maxTracks) return { ok: false, code: 'request_too_large' };
    if (!listenerUids.includes(requesterUid)) return { ok: false, code: 'listeners_unavailable' };
    if (listenerUids.length === 0) return { ok: false, code: 'listeners_unavailable' };

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

    // Sole listener: caller should have queued directly; if they still open, treat as instant pass.
    if (listenerUids.length === 1 && listenerUids[0] === requesterUid) {
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
        status: 'passed',
        reason: 'approved',
        closedAtMs: nowMs,
        announcedOpen: false,
        announcedResult: true,
      };
      this.closed.set(k, vote);
      const pub = toPublic(vote, requesterUid, listenerUids);
      return {
        ok: true,
        created: true,
        vote: pub,
        events: [
          { type: 'queue', playlistId: playlist.id, trackCount: playlist.trackCount, voteId: id },
          { type: 'announce_result', vote: pub },
        ],
      };
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
      announcedOpen: true,
      announcedResult: false,
    };
    this.open.set(k, vote);
    const pub = toPublic(vote, requesterUid, listenerUids);
    const events: PlaylistVoteEvent[] = [{ type: 'announce_open', vote: pub }];

    // Requester's automatic yes may already meet the bar (e.g. 1 of 1 already handled).
    const passed = this.tryPass(vote, listenerUids, nowMs);
    if (passed) {
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
    if (!input.listenerUids.includes(input.voterUid)) {
      return { ok: false, code: 'listeners_unavailable' };
    }

    if (input.voterUid === vote.requesterUid && input.choice === 'no') {
      return this.close(vote, 'cancelled', 'requester_cancelled', input.listenerUids, input.nowMs, input.voterUid);
    }

    vote.ballots.set(input.voterUid, input.choice);
    const events: PlaylistVoteEvent[] = [];
    if (this.tryPass(vote, input.listenerUids, input.nowMs)) {
      const pub = toPublic(vote, input.voterUid, input.listenerUids);
      events.push(
        { type: 'queue', playlistId: vote.playlist.id, trackCount: vote.playlist.trackCount, voteId: vote.id },
        { type: 'announce_result', vote: pub },
      );
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
    if (input.voterUid === vote.requesterUid) return { ok: false, code: 'invalid_request' };
    if (!input.listenerUids.includes(input.voterUid)) {
      return { ok: false, code: 'listeners_unavailable' };
    }
    vote.ballots.delete(input.voterUid);
    return { ok: true, vote: toPublic(vote, input.voterUid, input.listenerUids) };
  }

  /** Requester cancel (DELETE /votes/:id). */
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
    if (this.tryPass(vote, input.listenerUids, input.nowMs)) {
      const pub = toPublic(vote, null, input.listenerUids);
      return [
        { type: 'queue', playlistId: vote.playlist.id, trackCount: vote.playlist.trackCount, voteId: vote.id },
        { type: 'announce_result', vote: pub },
      ];
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

  private tryPass(vote: InternalVote, listenerUids: readonly string[], nowMs: number): boolean {
    if (vote.status !== 'open') return false;
    const listeners = new Set(listenerUids);
    // Drop ballots from leavers.
    for (const uid of [...vote.ballots.keys()]) {
      if (!listeners.has(uid)) vote.ballots.delete(uid);
    }
    if (!listeners.has(vote.requesterUid)) {
      this.close(vote, 'cancelled', 'requester_left', listenerUids, nowMs, null);
      return false;
    }
    // Requester always counts as yes while present.
    vote.ballots.set(vote.requesterUid, 'yes');
    const { yes } = countBallots(vote.ballots, listeners);
    const needed = approvalsNeeded(vote.thresholdPercent, listeners.size);
    if (yes < needed) return false;

    vote.status = 'passed';
    vote.reason = 'approved';
    vote.closedAtMs = nowMs;
    vote.announcedResult = true;
    const k = this.key(vote.botKey, vote.channelId);
    this.open.delete(k);
    this.closed.set(k, vote);
    return true;
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
    vote.announcedResult = true;
    const k = this.key(vote.botKey, vote.channelId);
    this.open.delete(k);
    this.closed.set(k, vote);
    const pub = toPublic(vote, viewerUid, listenerUids);
    return { ok: true, vote: pub, events: [{ type: 'announce_result', vote: pub }] };
  }
}
