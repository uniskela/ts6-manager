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
| `/play` search / library names | URL-only. Non-HTTP(S) queries are rejected. |
| Live `VoiceBotManager` / Express / Discord command registration | Not wired. Tests use fakes. |
| Guild→bot binding persistence | In-memory `GuildBinding` only. |
| Music request history | Discord `saveMusicRequest` is a no-op on purpose. Existing history rows do not store a TeamSpeak clid; wire the real saver when the live bot is connected (Phase 2B). Optional requester label (Discord user vs TS uid) is a later milestone. |
| Server-group DJ policy | Needs a **linked** TS uid + server groups via `identityForUser`. Empty identity fails closed. We do not invent a clid. |
| Idempotency | In-process `MemoryReplayGuard` (60s). Lost on restart; a retried interaction id can play again after expiry. |
| `/pause` `/resume` `/skip` `/stop` `/playlist` `/radio` `/volume` | `not_implemented` (Phase 2B). |
| Hosted Uniskela hub | Not started. |

## Later

Phase 2B: idempotent pause/resume (not the chat toggle), skip/stop, playlist, radio, volume, URL+search `/play`.  
Phase 3: real outbound connection to Uniskela + Connect Discord UI.
