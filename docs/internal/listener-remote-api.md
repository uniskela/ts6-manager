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
after slow URL resolution and audit writes. Pasted URLs use the existing SSRF
validator without the admin LAN allowlist, followed by the normal media URL
pipeline. URLs containing userinfo are rejected.

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
(404; song/bot), `rate_limited` (429), `unavailable` (503). The remote surface
never returns resolver, Query, database or credential-bearing exception text.

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

One-minute limits: three issued links per bot/identity, five exchange attempts
per token hash, sixty authentications per session hash (queue mutations check
again at insertion), five URL resolutions per session, 120 requests per IP,
and ten exchanges per IP. Both credential and rate stores are capped at 10,000
entries and fail closed when full. Queue insertion is capped at 500 items.
The app also applies the standard Express IP limiter after the bounded guard,
before JSON parsing and authentication on every public remote endpoint.
URL resolution permits one pending job per bot and four across the remote
service. Provider fetches and yt-dlp processes each have a three-minute timeout;
the normal shared downloader now bounds calls without an explicit signal too.
An expired/revoked request may finish caching its download, but cannot enqueue.
JSON request bodies are limited to 4 KiB. T05 should serialize mutations and
disable the request button while resolution is pending.
