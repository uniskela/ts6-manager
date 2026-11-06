# Listener remote API — T04 / T05 contract

This is the Slice 2 contract for roadmap #253. The phone UI is the frontend
`/remote` route and uses this API. It depends on the merged Slice 1 (PR #393).

## Browser lifecycle

1. A human in the media bot's channel types `!remote` (optionally selecting a
   bot using the normal chat targeting). The bot sends a **private** link to
   `<Public URL>/remote#token=<one-time token>`. Never use a query parameter.
2. T05 reads the fragment and immediately removes it with `history.replaceState`.
   POST the token once to `/api/listener-remote/exchange` as JSON `{ "token": "…" }`.
3. Response: `{ "session": "…", "expiresAt": "ISO timestamp", "botId": 12 }`.
   Keep the session in memory and send `Authorization: Bearer <session>` on
   every request below. Do not persist either secret in local/session storage,
   analytics, logs, URLs, or the PWA cache. This session does not authenticate
   the administrative API. No cookies, refresh tokens, or WebSocket access.
4. On 401, clear the session and ask the listener to type `!remote` again.
   On 403, refresh state (permissions may have changed). Respect 429 and avoid
   automatic retries of mutations. Poll state at most every five seconds while
   visible. Stop polling in the background.

Use the same Public URL origin and any configured base path for frontend and
API. Fetch with `cache: 'no-store'`; exclude these paths from service-worker
caching. Responses carry `Cache-Control: no-store` and `Referrer-Policy:
no-referrer`. Do not embed third-party assets on the token landing page.

## Listener endpoints

All endpoints use JSON. No caller-supplied bot, channel, server, UID, group or
media settings are accepted. Bodies are strict: extra keys are rejected.

| Method/path under `/api/listener-remote` | Request | Success |
| --- | --- | --- |
| POST `/exchange` | `{token: string}` | 200, session response above |
| GET `/state` | Bearer session | 200, state below |
| GET `/library?search=…&page=1` | search ≤200 characters; page 1–10000 | 200, `{songs: Song[], page: number, pageSize: 25}` |
| POST `/queue` | `{songId: positive integer}` | 200, `{ok: true}`; appends a library song |
| POST `/requests` | `{url: string}`; HTTP(S) URL ≤2048 characters | 200, `{ok: true}`; resolves and appends one track |
| DELETE `/session` | Bearer session | 200, `{ok: true}`; invalidates this bot/identity's access |

v1.12.0 adds playlist, vote and search endpoints, new `/state` fields and
duration rules for `POST /requests`; see
[Planned for v1.12.0](#planned-for-v1120-not-implemented).

`Song = {id: number, title: string, artist: string|null, duration: number|null}`.
State:

```ts
{
  bot: { id: number; name: string; status: string };
  nowPlaying: { id: string; title: string; artist: string|null; duration: number|null } | null;
  upNext: Array<{ id: string; title: string; artist: string|null; duration: number|null }>;
  upNextCount: number;
  permissions: { searchLibrary: boolean; addToQueue: boolean; requestUrl: boolean };
}
```

Up next is capped at 50 items. Metadata excludes file paths, source URLs,
credentials, TeamSpeak identities and internal connection details. Appending
does not interrupt playback or change streaming defaults. URL playlists add
only their first item in this slice. No library management, arbitrary chat
commands, playback controls, administrative actions or media switching.

Every request verifies the current human UID/client ID and bot channel through
TeamSpeak. `/state` uses `np`/read-only `queue` authorization; `/library` uses
read-only `queue`. Both mutations use `add` with nonempty arguments through
the shared Slice 1 authorization service. State permission flags are hints;
the backend rechecks policy and identity before queue insertion, including
after slow URL resolution and audit writes. An explicit music or video Stop,
or a queue clear, on the bot (`VoiceBot.stopGeneration`) after the request
arrived drops it with `cancelled` (409), so a slow link cannot restart music
that was stopped. Stopping or restarting the bot drops it too (the bot instance
is compared as well). Skips, track changes, Auto-DJ and automatic video stops
do not drop it.
Pasted URLs use the existing SSRF validator without the admin LAN allowlist,
followed by the normal media URL pipeline. URLs containing userinfo are
rejected.

Order of checks for `/queue` and `/requests` (cheapest first): body schema and,
for links, URL syntax plus blocked hosts and private or reserved literals (no
I/O) → authentication → authorization (`add`) → queue room → the request's own
check (song lookup; for links: link-request limit, a free resolving slot, the
destination's DNS check) → audit attempt opened → authorization again →
resolve → authorization again → stop check and queue room again → queue. A
link request uses up one of the session's link requests even when the bot's
resolving slot is taken. One 120-second deadline, the
session checks and the client-disconnect check cover a link from its slot
reservation to the end of its download. Refusals before the attempt are kept
in `ListenerRemoteRefusalAudit` (bounded per-window totals; 401, 403, 429 and
409 `queue_full`), routine 400/404 and unavailable or timed-out 503/504 refusals are
only counted in the log, and refusals after the attempt is opened complete that
attempt with a specific result code.

## Administrative revocation

`POST /api/listener-remote-admin/bots/:botId/revoke`, with the normal admin
JWT, accepts `{uid?: string}`. Omit `uid` to revoke all grants and sessions for
the bot; otherwise revoke that TeamSpeak unique identity. Response:
`{revoked: number}`. A listener session cannot call this endpoint. Revocation
also cancels exchanges and delayed queue insertions already in progress.

## Errors and security limits

Errors are `{error: string, code: string}` with static, credential-free text.
Codes: `invalid_request` (400), `invalid_access` (401; missing, consumed,
expired, revoked or departed access), `permission_denied` (403), `not_found`
(404; song/bot), `cancelled` (409; stopped or cleared while resolving),
`queue_full` (409; the bot's queue has no room), `rate_limited` (429),
`unavailable` (503), `timeout` (504; a pasted link took
longer than two minutes to load). The remote surface never returns resolver,
Query, database or credential-bearing exception text.
v1.12.0 adds codes; the full planned table is under
[Planned error codes](#planned-error-codes).

Tokens expire after five minutes; sessions expire absolutely after fifteen
minutes, with no extension on activity. A new `!remote` replaces earlier
access for that bot/identity. Leaving/moving channels, reused client IDs, bot
movement/disconnection, or admin revocation invalidates access. Only SHA-256
hashes of random 256-bit credentials are retained. Consumption happens before
asynchronous validation so concurrent exchanges cannot both succeed.

The store and rate windows are bounded and process-local. Restarting the
backend invalidates all access. Run one backend replica for this slice; shared
atomic storage is required before horizontal scaling. See the public reverse
proxy guide for Public URL, HTTPS and trusted proxy configuration.

One-minute limits: three issued links per bot/identity, sixty authentications
per bot/identity (queue mutations check again at insertion), five URL
resolutions per bot/identity, 120 requests per client address, and ten
exchanges per client address. Identity limits survive a new `!remote`, so
asking for a new link does not reset them. Identity windows are created only
for sessions that exist. Unknown, expired, revoked and consumed credentials all
get the same 401, keep no per-credential state, and count only against the
caller's address; token guessing is bounded by the per-address exchange limit.

A client address is an IPv4 address, or the /64 network of an IPv6 address;
IPv4-mapped IPv6 counts as its IPv4 address. When `req.ip` (which honours
`TRUST_PROXY`) is not a valid IP address, the connecting peer's address is used.
A request carrying a live session is limited per listener instead of per
address, so listeners behind one shared address do not use up each other's
budget; exchanges and requests without a live session count against the
address.

Address windows and identity windows are kept in separate stores of 10,000
entries each. One window per address holds both its request and exchange
counts, and one window per listener holds its link, authentication and URL
counts, so making room for one count never discards another. Capacity never
refuses a key: when a store is full, a new key first frees expired windows,
then replaces the oldest window still under all its limits. A window that has
reached a limit is dropped only when every window has, oldest first. Windows
run on a monotonic clock.

This is an accepted trade-off. Under sustained saturation by very many distinct
addresses, a partly used quota (and, in the extreme, an exhausted one) can
restart early. Refusing new keys on a full store was rejected because it let a
flood deny service to everyone. The grant store is still capped at 10,000 and
answers 503 when full. Queue insertion is capped at 500 items.

The app also applies two standard Express limiters after the bounded guard,
before JSON parsing and authentication on every public remote endpoint: one per
client address for requests without a live session, and one per listener for
requests with one. The listener limiter's store can only be filled by verified
sessions, so address traffic never affects a signed-in listener. These two
limiters and the sign-in limiter use bounded stores with the same policy; the
sign-in store holds 100,000 entries.

A 429 from a rate limit carries `Retry-After` with the whole seconds left in
that window (at least 1). A pending link resolution answers 429 with
`Retry-After: 60`. A full queue is not a rate limit: it answers 409
`queue_full`, with no `Retry-After`.

**Change in 1.11.2:** a full queue answered 429 `rate_limited` with
`Retry-After: 60` before. Clients that waited and retried on that 429 should
treat 409 `queue_full` as "no room now" and let the listener try again later;
it is not retried automatically. The bundled listener page already shows the
message and keeps the session. A second pending link is still 429
`rate_limited`.
URL resolution permits one pending job per bot and four across the remote
service. A pasted link has two minutes, including the URL check, to resolve
and download; the work is cancelled when that deadline passes (504 `timeout`),
when the client disconnects (also before the link step starts), or when the
session ends (checked every two seconds; 401). A link whose client left during
the final access check is not queued. Its slots are released once the work has
stopped. Cancellation kills the yt-dlp processes the request started,
including the YouTube searches behind Spotify and Apple Music links. yt-dlp
runs in its own process group, and a cancellation or its three-minute timeout
kills the whole group, so an ffmpeg conversion stops with it. Provider page fetches that take no signal keep their own
three-minute timeout but no longer hold a slot: the Spotify playlist and album
lookup and the Apple Music lookup. The Spotify track page fetch is cancelled. A cancelled request never
enqueues.
JSON request bodies are limited to 4 KiB. T05 should serialize mutations and
disable the request button while resolution is pending.

## Planned for v1.12.0 (not implemented)

> **Status: owner-accepted working contract (K1 in roadmap #442). Nothing
> below is implemented.** The sections above describe what ships today. API
> PRs (A3, B3, C1a, C2) edit only their own subsection and must match this
> contract or update it in the same PR. Types are in `@ts6/common`
> (`packages/common/src/types/listener-remote.ts`), where `RemoteVote` below
> is `ListenerRemoteVote` and so on. PIN sign-in and the installable app are
> deferred to v1.12.x (#464) and are not specified here. Working decisions are
> listed at the end of this section; item 11 follows shipped `409 queue_full`.

Everything in [Listener endpoints](#listener-endpoints) and
[Errors and security limits](#errors-and-security-limits) still applies:
bearer session, strict JSON bodies and query strings (extra keys rejected),
the 4 KiB body limit, the `{error, code}` envelope with static text,
`Cache-Control: no-store`, a live identity and channel check on every request,
and a recheck of identity and permission after every slow step and immediately
before any queue mutation. No endpoint accepts a bot, channel, server, UID,
group, duration or media setting from the browser.

**Identity key.** "Per identity" below means the bot and TeamSpeak unique
identity of the session's binding (`botId`, `uid`), the key G1b shipped. It
survives a new `!remote`. 429 responses carry `Retry-After` as G1b defines it.

**Permissions.** Names refer to the shared media command authorization:

| Name used below | Check |
| --- | --- |
| read | `np` and read-only `queue` (group `info`), as `GET /library` today |
| queue | `add` with nonempty arguments (group `queue`), as `POST /queue` today |
| playlist | `playlist` with nonempty arguments (group `queue`) |
| listener | current human listener in the bot's channel (group `listener`, as `!voteskip`) |

### A3: shared playlists

A playlist is visible to the remote when `remoteAccess` (schema 1, A1) is
`browse` or `request` and its `serverConfigId` is the binding's server or null
(a global playlist, as chat `!playlist` treats it). Every read applies this
filter in the database query; nothing is cached.

`RemotePlaylist`:

```ts
{
  id: number;
  name: string;              // as stored
  trackCount: number;        // songs on the binding's server only
  duration: number | null;   // total seconds; null when any track's duration is unknown
  wholeRequest: boolean;     // remoteAccess === 'request'
}
```

| Method/path | Auth | Request | Success |
| --- | --- | --- | --- |
| GET `/playlists?search=…&page=1` | read | search ≤200 characters (name contains); page 1–10000 | 200, `{playlists: RemotePlaylist[], page, pageSize: 25}`, ordered by name then id |
| GET `/playlists/:playlistId/songs?page=1` | read | `playlistId` positive safe integer; page 1–10000 | 200, `{playlist: RemotePlaylist, songs: Song[], page, pageSize: 25}`, ordered by position then id |

Errors: 400 `invalid_request` (malformed ID or query), 401, 403
`permission_denied`, 404 `not_found` with message `Playlist not found.`, 429,
503. `Song` is the shipped library shape. A single song from a playlist is
queued with the shipped `POST /queue`; browsing changes nothing there. Reads
are not audited (as `/library`) and have no limit beyond the authentication
limit.

Security properties (R1, #465):

- Hidden, other-server and missing playlists return the same status, code,
  message, headers and body. A route test compares the three responses byte
  for byte.
- Songs whose `serverConfigId` differs from the binding's are never listed or
  counted, even inside a global playlist.
- Response fields are an allow-list: never `filePath`, `source`, `sourceUrl`,
  `mode`, `youtubePlaylistId`, `musicBotId` or `serverConfigId`.
- An admin's visibility change applies to the next request. The filter is
  applied again at queue and vote time (B3).
- Hiding a playlist does not hide its songs from `GET /library` (owner
  decision); the admin UI says so (A2).

### B3: whole-playlist requests and votes

Settings (B1, per server and virtual server; a missing row means the default):
voting enabled (off), threshold (80%), maximum request size (25 tracks). The
window is 60 seconds. Vote rules are in #442 ("Vote rules") and are not
repeated here except where the API depends on them.

| Method/path | Auth | Request | Success |
| --- | --- | --- | --- |
| POST `/playlist-requests` | playlist | `{playlistId: positive safe integer}` | 200, `RemotePlaylistRequestResult` |
| PUT `/votes/:voteId/ballot` | listener | `{choice: 'yes' \| 'no'}` | 200, `{ok: true, vote: RemoteVote}` |
| DELETE `/votes/:voteId/ballot` | listener | none | 200, `{ok: true, vote: RemoteVote}` |
| DELETE `/votes/:voteId` | listener, and the requester of that vote | none | 200, `{ok: true}` |

`voteId` is an opaque random 128-bit value encoded as 22 base64url characters.

```ts
type RemotePlaylistRequestResult =
  | { ok: true; outcome: 'queued'; trackCount: number }       // voting off, or the requester is the only listener
  | { ok: true; outcome: 'vote'; created: boolean; vote: RemoteVote };
```

**POST `/playlist-requests`**:

1. The playlist must pass the A3 filter, else 404 `not_found` (same body as
   A3). It must be `remoteAccess: 'request'`, else 409
   `playlist_not_requestable` (working decision 1).
2. Eligible tracks are the playlist's songs on the binding's server. None:
   422 `playlist_empty`. More than the maximum request size: 422
   `request_too_large`, message naming the limit. Nothing is queued.
3. Voting off: the whole request is queued at once through F1's
   all-or-nothing add and queue cap; if it does not fit, nothing is queued
   (409 `queue_full`, `The queue is full.`, as shipped since 1.11.2).
   An idle bot starts playing; video is never replaced.
4. Voting on, and the requester is the only human listener: queued at once as
   in step 3, with no window.
5. Voting on, otherwise: if a vote is open on this bot and channel, the same
   requester asking for the same playlist gets the existing vote
   (`created: false`, no new rate-limit hit); anyone else gets 409
   `vote_running`. Otherwise a vote opens (`created: true`) with the requester
   as an automatic yes.
6. The remote has no admin bypass. "Queue playlists without a vote" (B4b)
   applies to chat only.

Ballots: one per identity, keyed by UID and verified against the live client
ID on every ballot. A listener may change or withdraw their ballot while the
vote is open. The requester's `no` cancels the vote, as chat
`!playlistvote no` does; the requester cannot withdraw (400
`invalid_request`). A ballot that reaches the number needed passes the vote
synchronously inside that request, and the returned `vote` shows the result.
A `voteId` that is not the open vote on the caller's bot and channel (unknown,
closed, or another bot's) returns 404 `not_found` with `Vote not found.`.

Cancel: only the requester, even after losing the playlist permission; anyone
else gets 403 `permission_denied`.

`RemoteVote`, as the remote sees it:

```ts
{
  id: string;
  status: 'open' | 'passed' | 'failed' | 'cancelled';
  reason: RemoteVoteEndReason | null;   // null while open
  playlist: { id: number | null; name: string; trackCount: number };  // id null when not visible on the remote
  yes: number;              // includes the requester
  no: number;
  needed: number;           // ceil(threshold × listeners), at least 1, at this moment
  listeners: number;        // human listeners counted at the last check
  thresholdPercent: number;
  deadline: string;         // ISO timestamp
  ownBallot: 'yes' | 'no' | null;
  isRequester: boolean;
}
// RemoteVoteEndReason: 'approved' | 'deadline' | 'requester_cancelled' | 'requester_left'
//   | 'bot_unavailable' | 'revoked' | 'playlist_unavailable' | 'queue_full' | 'listeners_unavailable'
```

**`GET /state` additions** (additive; the shipped client ignores unknown keys):

```ts
{
  …shipped fields,
  permissions: { …shipped, browsePlaylists: boolean; requestPlaylist: boolean; searchMusic: boolean; vote: boolean };
  playlistRequests: { voting: boolean; thresholdPercent: number; windowSeconds: number; maxTracks: number };
  limits: { maxRequestSeconds: number };   // 900
  vote: RemoteVote | null;  // the open vote on this bot and channel, or the last one for 30 s after it closes
}
```

`browsePlaylists` follows read, `requestPlaylist` follows playlist, and
`searchMusic` follows queue. `vote` is true for any current listener. A vote
opened from chat (B4a) appears here too. The remote learns of changes by its
normal five-second poll.

Errors: 400, 401, 403, 404, 409 `playlist_not_requestable` / `vote_running`,
422 `playlist_empty` / `request_too_large`, 429, 503 `unavailable` (also when
the listener list cannot be read: the ballot or open is rejected).

Limits, per identity unless stated:

| What | Limit |
| --- | --- |
| Opening a vote or queueing a whole playlist directly | 3 per 10 minutes |
| Any vote on the bot | 120-second pause after a vote closes (per bot) |
| Requester whose vote failed | 5 minutes before opening another |
| Ballots (cast, change, withdraw) | 10 per minute |

Audit actions (target `music_bot`, listener actor as today):
`listener.remote.playlist_request` (one row per POST, whether it queued or
opened a vote) and `listener.remote.vote_cancel` (also written when the
requester's `no` cancels). Ballots are not audited
(working decision 8). Accepted tracks go to request history with a shared request
reference (B4c).

Security properties (R2, #465):

- The requester's playlist permission is checked at open and again, with
  identity, immediately before queueing at approval.
- Songs are re-read at approval. The size, emptiness and visibility rules are
  applied again, and the request is queued whole or not at all.
- The vote state machine (B2) fires the pass once and queues once. A restart
  drops open votes and queues nothing.
- Listener lookup failure rejects the ballot and fails the vote at its
  deadline.
- Vote responses and `/state` contain counts only: never voter names, UIDs,
  client IDs or database IDs. The channel gets at most two messages per vote
  (open and result).
- A `voteId` is unguessable and is accepted only from listeners of the bot and
  channel that holds the vote.

### C1a: duration rules for `POST /requests`

> **Implemented** on `POST /requests` (paste links only).

Request and success shapes do not change. After resolution and before any
download:

- longer than 900 seconds (15 minutes; 900 exactly is allowed): 422 `too_long`;
- live: 422 `live_not_allowed`;
- duration not reported: 422 `duration_unknown`.

The download is bounded so that a wrong reported duration cannot cause an
unbounded download, and a measured duration over the limit after download
refuses the request without queueing. URL playlists still add only their first
item, and that item follows the same rules. Refusals are recorded under
`listener.remote.request` with outcome `failure` and result code
`validation_failed`. Library songs (`POST /queue`) and playlist tracks are not
subject to these rules (working decision 13). Admin, chat and radio limits do not
change.

### C2: search and queue a result

| Method/path | Auth | Request | Success |
| --- | --- | --- | --- |
| POST `/search` | queue | `{query: string}`, 2–100 characters after trimming, no control characters, not an `http(s)` URL | 200, `{results: RemoteSearchResult[], expiresAt: string}` |
| POST `/search/queue` | queue | `{resultId: string}`, 22 base64url characters | 200, `{ok: true}` |

The query travels in the body so it stays out of URLs and proxy logs.

```ts
RemoteSearchResult = { id: string; title: string; artist: string | null; duration: number };
```

- At most 10 results. Results that are live, of unknown duration or longer
  than 900 seconds are left out, so `duration` is always known.
- No source URLs, provider IDs, thumbnails or other third-party URLs.
- `id` is a random 128-bit value with no relation to the source. It is valid
  only for the identity whose search returned it, until that identity's next
  search replaces the set, for 5 minutes, and for one successful queue.
  Anything else returns 404 `not_found` with `Search result not found.`,
  identically whether unknown, expired, replaced, consumed or another
  listener's.
- `POST /search/queue` resolves through the same pipeline and limits as
  `POST /requests`, including the C1a rules (which can still refuse with 422
  if the provider's answer changed), the one-pending-resolution-per-bot and
  four-per-service limits, and the per-identity URL request budget.
- Search uses no administrator cookies, expands no playlists and writes
  nothing to the library. Resolver errors are never echoed (503
  `unavailable`).
- Results are cached by normalized query, process-locally, for 10 minutes and
  at most 200 queries. The cache holds results, never identities; result IDs
  are issued per identity on every response.

Limits: 5 searches per identity per minute; one search in flight per identity
and two across the service (429 `rate_limited`). Audit:
`listener.remote.search_queue` for each queue attempt. Searches are reads and
are not audited; the query text is never logged or audited.

Errors: 400 `invalid_request`, 401, 403 `permission_denied`, 404 `not_found`,
422 `too_long` / `live_not_allowed` / `duration_unknown` (queue only), 429,
503 `unavailable`.

### Planned error codes

All codes after v1.12.0, shipped and new. The message stays static and
credential-free; clients branch on `code`, never on `error`.

| Code | Status | Meaning | Endpoints |
| --- | --- | --- | --- |
| `invalid_request` | 400 | Malformed body, query or ID; disallowed URL; requester withdrawing their own ballot | all |
| `invalid_access` | 401 | Missing, consumed, expired, revoked or departed access | all |
| `permission_denied` | 403 | Media permission missing; cancel by someone other than the requester | all |
| `not_found` | 404 | Song or bot (shipped); playlist hidden, other-server or missing; vote not open here; search result not valid for this identity | `/queue`, `/playlists…`, `/playlist-requests`, `/votes…`, `/search/queue` |
| `cancelled` | 409 | Shipped. Stopped or cleared while resolving | `/requests` |
| `queue_full` | 409 | Shipped since 1.11.2. The bot's queue has no room; no `Retry-After` | `/queue`, `/requests`, `/playlist-requests`, `/search/queue` |
| `playlist_not_requestable` | 409 | **New.** Visible playlist not set to allow whole-playlist requests | `/playlist-requests` |
| `vote_running` | 409 | **New.** Another playlist vote is open on this bot and channel | `/playlist-requests` |
| `playlist_empty` | 422 | **New.** No eligible tracks | `/playlist-requests` |
| `request_too_large` | 422 | **New.** More tracks than the maximum request size; message names the limit | `/playlist-requests` |
| `too_long` | 422 | **New.** Longer than 15 minutes | `/requests`, `/search/queue` |
| `live_not_allowed` | 422 | **New.** Live stream | `/requests`, `/search/queue` |
| `duration_unknown` | 422 | **New.** Duration could not be verified before playback | `/requests`, `/search/queue` |
| `rate_limited` | 429 | Shipped limits, vote pauses, search and ballot limits (not queue full) | all |
| `unavailable` | 503 | Service unavailable, store full, resolver or listener lookup failure | all |
| `timeout` | 504 | Shipped. A pasted link took longer than two minutes to load | `/requests` |

### Working decisions (owner-accepted K1 defaults)

Build against these unless the owner changes them. Item 11 follows the
shipped 1.11.2 `409 queue_full` behaviour rather than the earlier draft that
kept `429 rate_limited` for a full queue.

1. **Whole-playlist requests with voting on.** Only playlists set to
   `request`; a `browse` playlist cannot be proposed.
2. **Page sizes.** 25 for playlists and for a playlist's songs, matching
   `/library`.
3. **Search result count.** 10.
4. **Search result ID lifetime.** 5 minutes, replaced by the next search,
   consumed by one successful queue.
5. **Search cache.** 10 minutes, at most 200 queries, process-local, shared
   across listeners and servers (provider results only).
6. **Search limits.** 5 per identity per minute; one in flight per identity,
   two across the service; query 2–100 characters.
7. **Over-limit search results.** Left out.
8. **Ballot limit and audit.** 10 ballots per identity per minute; ballots
   are not audited.
9. **Closed vote in `/state`.** Shown for 30 seconds after it closes.
10. **Global playlists with songs from other servers.** Those songs are left
    out of the listing, the counts and the request.
11. **Queue full.** Use shipped `409 queue_full` with `The queue is full.` on
    every endpoint that can fill the queue (supersedes the draft that kept
    `429 rate_limited`).
12. **Search switch.** No separate setting; search follows the queue
    permission.
13. **Duration rule scope.** Only search results and pasted links; library
    songs and playlist tracks stay unlimited.
14. **Whole-playlist budget.** Direct queueing (voting off) and vote opens
    share the 3-per-10-minutes budget per identity.
