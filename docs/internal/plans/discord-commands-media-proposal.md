# Discord commands — Phase 1 adapter (local)

Research landed earlier; this branch implements **Phase 1 only**. No deploy, push, or Discord registration.

## Decisions

- Default later: one Uniskela command app (`applications.commands`, no bot user).
- No seventh customer Discord app for normal users.
- Six voice bots / DAVE stay separate and untouched.
- Adapter is transport-independent: same `handle(intent)` for self-hosted Ed25519 interactions and hosted outbound sessions.
- **Hosted path is outbound-only.** The customer instance does not expose an invoke HTTP API. The hub pushes signed intents on a customer-initiated session (`createOutboundCommandSession`).
- Advanced: `handleSignedInteraction` for a customer Interactions URL.
- Music stays TeamSpeak-primary; Phase 2 names are reserved and rejected.

## Phase 1 code

`packages/backend/src/discord-command/`

| Module | Role |
|---|---|
| `adapter.ts` | `/ts help|status|online|channels|bridge`, pairing, TS6 role map, audit |
| `security.ts` | Discord Ed25519 fixtures, HMAC, timestamp/nonce replay |
| `outbound.ts` | Hosted session + revoke |
| `interaction.ts` | Signed Discord POST + PING + ack plan |
| `presence.ts` | Widget-style `clientlist` / `channellist` mapping |
| `music.ts` | Phase 2 command list; no playback |
| `rate-limit.ts` | Per guild+user |

Not wired into Express. No new public port.

## Phase 1 limitations

- Discord roles map to TS6 `viewer`/`admin` via configured role IDs or `userRoles`. **Manage Guild is not a TS6 admin grant** (pair/unpair later).
- No persisted Discord↔TS6 user table; no ConnectionPool or live bridge-health wiring.
- Rate limit is opt-in (`MemoryCommandRateLimit`). Replay store is in-process.
- Hosted outbound session is in-memory; no Uniskela hub process.
- `/ts online` is nicknames only and ephemeral; audit logs Discord user/guild ids, not TeamSpeak UIDs.

## Phase 2A (this branch) — local library only

`/play`, `/queue`, `/nowplaying` call `applyMediaUrlToBot`, which is also what TeamSpeak `enqueueMediaUrl` (`!play`) uses. One `PlayQueue`. Bot ID comes from `GuildBinding.botId` only. `authorizeMediaCommand` is the media gate.

**Not done (do not treat as shipped):**

| Gap | Status |
|---|---|
| `/play` search / library names | Phase 2B-3: non-URL queries call `findSongForQuery` (YouTube Music, then YouTube). First playable result only. Resolved URL still goes through `validateUrl` + `applyMediaUrlToBot`. 12s search timeout. `/stop` aborts via `beginChatMediaRequest`. |
| Live `VoiceBotManager` / Express / Discord command registration | Not wired. Tests use fakes. |
| Guild→bot binding persistence | In-memory `GuildBinding` only. |
| Music request history | Discord `saveMusicRequest` is a no-op on purpose. Existing history rows do not store a TeamSpeak clid; wire the real saver when the live bot is connected (Phase 2B). Optional requester label (Discord user vs TS uid) is a later milestone. |
| Server-group DJ policy | Needs a **linked** TS uid + server groups via `identityForUser`. Empty identity fails closed. We do not invent a clid. |
| Idempotency | In-process `MemoryReplayGuard` (60s). Lost on restart; a retried interaction id can play again after expiry. |
| `/pause` `/resume` `/skip` `/stop` `/volume` | Phase 2B-1 library only. Same VoiceBot as TeamSpeak. Chat `!pause` remains a toggle. |
| `/playlist` `/radio` | Phase 2B-2 library only. List/play reuse Prisma rows. Create/add/remove are TS6 admin and server-owned playlists only. Discord `add` stores the URL as a temporary song title; later enrich title/duration/artwork via the existing media pipeline — do not add a second extractor. |
| Hosted Uniskela hub | Not started. |

Idempotency is still in-process `MemoryReplayGuard` (60s). Lost on restart; a retried interaction id can mutate again after expiry.

## Later

Phase 2B-3: `/play` search via `findSongForQuery`. Same providers as TeamSpeak `!play` (YouTube Music → YouTube). No extra extractors. Public-release licensing stays the existing yt-dlp / YouTube Music terms already used for TeamSpeak search — Discord does not add Spotify/Apple/other name search. URL `/play` still uses the existing media pipeline (YouTube / Spotify / Apple Music links when already supported). Search cancellation reuses `beginChatMediaRequest` (bot-id keyed AbortController + generation; not TeamSpeak-specific).  

## Phase 2C (not started)

Live wiring only. Do not implement until approved.

1. Bind `createMusicCommandService` to the running `VoiceBotManager` / Prisma (no second queue).
2. Persist `GuildBinding` (guild → instance, bot, revoked) instead of the in-memory map.
3. Register Discord slash commands on the Uniskela command app (`applications.commands`). No seventh customer bot, no DAVE/voice-slot change.
4. Replace in-process `MemoryReplayGuard` with durable interaction-id idempotency (survives restart).
5. Wire `saveMusicRequest` to existing music history once the live bot is connected. Optional Discord-user vs TS-uid requester label later.
6. Optional `identityForUser` (Discord ↔ TS uid) so `server_groups` DJ policy can pass. Empty identity stays fail-closed.

Phase 3: Uniskela hub + Connect Discord UI.
