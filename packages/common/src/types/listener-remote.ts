// === Listener Remote Types ===
// Contract for the v1.12.0 listener remote API (K1, roadmap #442).
// See docs/internal/listener-remote-api.md, "Planned for v1.12.0".
// Types only: nothing below is implemented yet. Never add file paths, source
// URLs, TeamSpeak identities or voter names to these payloads.

/** Every `code` in the `{ error, code }` envelope, shipped and planned. */
export type ListenerRemoteErrorCode =
  | 'invalid_request'
  | 'invalid_access'
  | 'permission_denied'
  | 'not_found'
  | 'playlist_not_requestable'
  | 'vote_running'
  | 'playlist_empty'
  | 'request_too_large'
  | 'too_long'
  | 'live_not_allowed'
  | 'duration_unknown'
  | 'rate_limited'
  | 'unavailable';

export interface ListenerRemoteErrorBody {
  /** Static, credential-free text; branch on `code`. */
  error: string;
  code: ListenerRemoteErrorCode;
}

/** `POST /exchange`. */
export interface ListenerRemoteSession {
  session: string;
  expiresAt: string;
  botId: number;
}

/** A queue entry in `GET /state`. */
export interface ListenerRemoteTrack {
  id: string;
  title: string;
  artist: string | null;
  duration: number | null;
}

/** A library song, also used for a shared playlist's songs. */
export interface ListenerRemoteSong {
  id: number;
  title: string;
  artist: string | null;
  duration: number | null;
}

/** `GET /library`. */
export interface ListenerRemoteLibraryPage {
  songs: ListenerRemoteSong[];
  page: number;
  pageSize: number;
}

export interface ListenerRemotePermissions {
  searchLibrary: boolean;
  addToQueue: boolean;
  requestUrl: boolean;
  /** v1.12.0: read access to shared playlists. */
  browsePlaylists: boolean;
  /** v1.12.0: may propose or queue a whole playlist (`playlist` permission). */
  requestPlaylist: boolean;
  /** v1.12.0: may search and queue a result (queue permission). */
  searchMusic: boolean;
  /** v1.12.0: may cast a ballot (any current listener). */
  vote: boolean;
}

/** v1.12.0: whole-playlist request settings for the bot's server. */
export interface ListenerRemotePlaylistRequestSettings {
  voting: boolean;
  thresholdPercent: number;
  windowSeconds: number;
  /** Maximum tracks in one whole-playlist request, with voting on or off. */
  maxTracks: number;
}

/** v1.12.0: listener request limits. */
export interface ListenerRemoteLimits {
  /** Longest search result or pasted link a listener may request (900). */
  maxRequestSeconds: number;
}

/** `GET /state`. Fields marked v1.12.0 are planned. */
export interface ListenerRemoteState {
  bot: { id: number; name: string; status: string };
  nowPlaying: ListenerRemoteTrack | null;
  /** At most 50 items. */
  upNext: ListenerRemoteTrack[];
  upNextCount: number;
  permissions: ListenerRemotePermissions;
  /** v1.12.0 */
  playlistRequests: ListenerRemotePlaylistRequestSettings;
  /** v1.12.0 */
  limits: ListenerRemoteLimits;
  /** v1.12.0: the open vote on this bot and channel, or the last one for a short time after it closes. */
  vote: ListenerRemoteVote | null;
}

// --- A3: shared playlists ---

export interface ListenerRemotePlaylist {
  id: number;
  name: string;
  /** Songs on the session's server only. */
  trackCount: number;
  /** Total seconds; null when any track's duration is unknown. */
  duration: number | null;
  /** The playlist allows whole-playlist requests. */
  wholeRequest: boolean;
}

/** `GET /playlists`. */
export interface ListenerRemotePlaylistPage {
  playlists: ListenerRemotePlaylist[];
  page: number;
  pageSize: number;
}

/** `GET /playlists/:playlistId/songs`. */
export interface ListenerRemotePlaylistSongsPage {
  playlist: ListenerRemotePlaylist;
  songs: ListenerRemoteSong[];
  page: number;
  pageSize: number;
}

// --- B3: whole-playlist requests and votes ---

/** `POST /playlist-requests` body. */
export interface ListenerRemotePlaylistRequestBody {
  playlistId: number;
}

export type ListenerRemoteBallot = 'yes' | 'no';

/** `PUT /votes/:voteId/ballot` body. */
export interface ListenerRemoteBallotBody {
  choice: ListenerRemoteBallot;
}

export type ListenerRemoteVoteStatus = 'open' | 'passed' | 'failed' | 'cancelled';

export type ListenerRemoteVoteEndReason =
  | 'approved'
  | 'deadline'
  | 'requester_cancelled'
  | 'requester_left'
  | 'bot_unavailable'
  | 'revoked'
  | 'playlist_unavailable'
  | 'queue_full'
  | 'listeners_unavailable';

/** A playlist vote as one listener sees it: counts only, never voter names. */
export interface ListenerRemoteVote {
  /** Opaque, 22 base64url characters. */
  id: string;
  status: ListenerRemoteVoteStatus;
  /** Null while the vote is open. */
  reason: ListenerRemoteVoteEndReason | null;
  /** `id` is null when the playlist is not visible on the remote. */
  playlist: { id: number | null; name: string; trackCount: number };
  /** Includes the requester's automatic yes. */
  yes: number;
  no: number;
  /** Approvals needed with the current listeners. */
  needed: number;
  listeners: number;
  thresholdPercent: number;
  /** ISO timestamp. */
  deadline: string;
  ownBallot: ListenerRemoteBallot | null;
  isRequester: boolean;
}

/** `POST /playlist-requests` success. */
export type ListenerRemotePlaylistRequestResult =
  | { ok: true; outcome: 'queued'; trackCount: number }
  | { ok: true; outcome: 'vote'; created: boolean; vote: ListenerRemoteVote };

/** `PUT` and `DELETE /votes/:voteId/ballot` success. */
export interface ListenerRemoteBallotResult {
  ok: true;
  vote: ListenerRemoteVote;
}

// --- C2: search ---

/** `POST /search` body. */
export interface ListenerRemoteSearchBody {
  query: string;
}

/** Only results within the listener duration rules are returned, so `duration` is known. */
export interface ListenerRemoteSearchResult {
  /** Opaque, 22 base64url characters; valid for this listener's last search only. */
  id: string;
  title: string;
  artist: string | null;
  duration: number;
}

/** `POST /search` success. */
export interface ListenerRemoteSearchResponse {
  results: ListenerRemoteSearchResult[];
  /** When the result IDs stop being accepted (ISO timestamp). */
  expiresAt: string;
}

/** `POST /search/queue` body. */
export interface ListenerRemoteSearchQueueBody {
  resultId: string;
}

/** Success of `POST /queue`, `/requests`, `/search/queue`, `DELETE /votes/:voteId` and `DELETE /session`. */
export interface ListenerRemoteOk {
  ok: true;
}
