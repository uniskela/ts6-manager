# TeamSpeak-side Discord presence

**Date:** 2026-10-29
**Status:** Design approved; implementation not started
**Scope:** Planning only. Presence-1 is a shared TeamSpeak nickname roster of connected Discord humans. Presence-2 (per-user TeamSpeak identities) is a later owner decision. Do not implement on Draft PR #504, the D1 beta, or any live image.

Companion contract: [discord-voice-bridge.md](../../discord-voice-bridge.md). This document does not amend Bridge-K.

## Goal

TeamSpeak users can see who is sitting in the mapped Discord voice channel, including people who are silent. Discord → TeamSpeak audio stays one mix into one shared TeamSpeak client.

## Decisions

### 1. Presence-1 first, Presence-2 later

Ship a shared-nickname roster on the existing TeamSpeak client. Do not add per-user TeamSpeak identities in v1.12.0.

Bridge-K says Discord → TeamSpeak is one mix into that shared client, and treats per-Discord-user TeamSpeak identities as a later owner decision. Presence-1 stays inside that contract. Presence-2 needs an explicit amendment.

### 2. Roster is channel membership, not audio admission

Presence-1 lists **connected Discord human participants**. Silent sitters appear.

Derive the roster from verified Discord voice-channel membership:

- In the mapped guild voice-state cache, `channelId` is the approved Discord voice channel.
- Identity is a verified human (`HumanFilter`: `bot === false`).
- Exclude bridge bot user ids, other bots, and unverified / unknown identities.

Keep display presence independent of:

- DAVE readiness
- active speaking
- `VoiceAdmission` / receive-generation fences

Audio admission still decides who is mixed. A silent verified human is on the nick and not in the mix. An unverified speaker is in neither.

### 3. Stale users must disappear

Rebuild the roster from the live voice-state cache on every relevant event. Do not keep a side list that outlives membership.

Remove a user when they leave or move off the mapped channel, when identity flips to bot or unverified, when the receive session is replaced and they are no longer in the live cache, or when the TeamSpeak client reconnects (rebuild from cache after connect; do not restore the previous nick string blindly if membership changed).

### 4. Release sequencing

1. Complete D1 acceptance.
2. D2 packaging and persist the **one** shared TeamSpeak identity.
3. Presence-1 shared nickname roster.
4. Consider Presence-2 only after an explicit Bridge-K amendment.

Do not land this work on `bridge-d1/discord-voice-lab` / PR #504.

## Current architecture

TeamSpeak speakers already have Discord identities (`[TS] Username` plus optional `[TS] Others`). Discord speakers do not have TeamSpeak identities. D1 uses one `TsSession`; the nick is connect-only (`ts6-bridge-d1` / `ts6-bridge-d1-beta`). Identity is `generateIdentity(8)` in memory and discarded. Nickname updates today go the other way: `BridgeRuntime.applyNickname` sets Discord nicks via `tsNickname` (32 UTF-16, prefix `[TS] `).

```text
TS humans ──uniqueId──▶ 5 Discord slot bots + optional overflow
Discord humans ──one elected receiver──▶ PCM mix ──▶ one TS client
```

## Presence-1 — shared TeamSpeak nick roster

One TeamSpeak client stays. The mix stays. Only the display name changes.

### Nickname format

TeamSpeak nicks are 3–30 characters (error 1541). Discord’s 32-character `[TS] ` helper is the wrong limit.

| Occupancy | Nick |
|---|---|
| 0 verified humans | `Discord` (or the persisted lab/default nick if already 3–30) |
| 1–2 names that fit | `DC • Sam, Jordan` |
| more than fits | `DC • Sam, Jordan +2` |

Rules:

- Stable order: first-seen in this TeamSpeak session while continuously present. A leaver who returns is appended, not restored to the old slot.
- Truncate names so the whole string is ≤30 UTF-16 code units. Never drop the `+N` suffix to fit a longer name. Do not leave a dangling surrogate.
- Display name only (guild nick, else global display name, else username). Unknown verified human → `Unknown`.
- No Discord snowflakes, tokens, or TeamSpeak unique IDs in the nick.

### Source and events

Watch Discord `voiceStateUpdate` for the mapped channel, plus identity-filter answers and member display-name / nick updates.

On each event, recompute the desired set from the live cache. Then format the desired nick. Do not incrementally patch a stored name list without a cache re-read.

Reconnect of the shared TeamSpeak client: after `clientinit`, set the nick from the current cache (coalesced). Do not replay a stale pre-disconnect roster.

### TeamSpeak API

Live changes use `clientupdate client_nickname=` through `buildCommand` in `packages/backend/src/voice/tslib/commands.ts`. `clientedit` is not in this client.

Add `TsSession.setNickname` that sends that command. Connect still sends `clientinit client_nickname=`.

### Flood and failure

tslib has no nickname rate limit. Music-bot `VoiceBot` only holds **chat** for 30s on error 524.

Presence-1 must:

- Coalesce updates: minimum ~2s between sends; keep the latest desired nick; drop intermediate strings.
- On 524 or 3329: hold (same order as 30s), keep the previous nick, do not stop audio or disconnect.
- Never busy-loop.
- On any other `clientupdate` failure: warn, keep the previous nick, continue. Same policy as Bridge-K D3 Discord nicks.

### Isolation

Unchanged: TeamSpeak still hears one talking client. Presence-1 does not grant audio, election, or DAVE. Dual-homed echo stays documented, not cancelled.

## Presence-2 — individual TeamSpeak identities (not scheduled)

One `Ts3Client` cannot impersonate multiple client ids. Each assigned Discord human needs a full UDP session (identity, handshake, EAX, `sendVoice`).

That amends Bridge-K: assigned humans send on their own client; overflow remains one mix.

Constraints already measured in this repo:

- Persist ECDSA P-256 like music bots (`encrypt()` + Prisma). Do not regenerate level-8 keys on every connect.
- Lab: ~6 joins in ~25s from one IP → 3329 ban. Space joins (~12s).
- `DiscordToTsPipeline` is one mixer → one `TsVoiceOut`. Presence-2 needs per-user encode + send; mix only overflow.
- Still exactly one Discord receiver. No seventh Discord bot.
- N UDP sockets, N EAX sessions, N Opus encoders. Recheck the 512MB / 1 CPU compose limits.
- Server 1027 (max clients) fail-closes that identity only.
- Query-only clients cannot carry audio.

Configurable cap (default 5) plus one overflow identity while overflow is non-empty. Sticky `discordUserId → identity`. Empty identities leave after send has moved off them.

## Out of scope

- Seventh Discord bot, self-bots, Query-as-voice, `clientedit` of real users
- Identity linking for people in both rooms
- Avatars, server groups, or channel descriptions in Presence-1
- D1 / PR #504 / GHCR / Portainer / TeamSpeak-stack changes
- Publishing this file (keep it out of `docs/manifest.json`)

## Acceptance criteria

### Presence-1 (implement only after D1 acceptance and D2 persist-identity)

- TeamSpeak still has exactly one bridge client.
- Discord → TeamSpeak audio is still one mix. DAVE, election, and admission fences are unchanged.
- Roster is verified humans in the mapped Discord voice channel, including silent sitters.
- Bridge bots, other bots, and unverified identities never appear.
- DAVE down, not speaking, or not admitted does not remove a verified sitter.
- Join, leave, move, and display-name change update the nick within the coalesce window.
- After departure or TeamSpeak reconnect, a user who is not in the live cache is gone.
- Nick is always 3–30 characters, stable first-seen order, `+N` overflow kept.
- `clientupdate` failure or flood: previous nick kept, warning only, audio continues.
- No new Discord applications. No change to 5+1 TeamSpeak → Discord slots.
- No secrets, snowflakes, or identity material in nicks or logs.

### Presence-2 (not scheduled)

- Bridge-K amended first.
- Configurable cap; overflow identity only while overflow is non-empty.
- Sticky mapping; 20 ms remove-then-add; never audible on two TeamSpeak clients.
- Joins spaced to avoid 3329; 1027 fail-closed per identity.
- Identities persisted and encrypted; frontend never sees keys.
- Still exactly one Discord receiver.
- Resource limits re-measured. Previous single-client image remains the rollback pin.

## Tests for Presence-1 (when implemented)

Deterministic. No live Discord.

- empty / one / two / `+N` formatting at 30 characters
- surrogate-safe truncation; `+N` never dropped
- silent verified human appears; unverified and bots do not
- DAVE lost / no admission does not drop a sitter
- five joins in 200 ms → one `clientupdate`
- leave or channel move removes the name after the next send
- TeamSpeak reconnect rebuilds from the current cache
- display-name change updates the roster
- 524 hold; audio still flows; desired nick after the hold is current
- failure never disconnects TeamSpeak or Discord

## Recommendation

Ship Presence-1 after D1 and D2. Treat Presence-2 as a later product, not a v1.12.0 silent extra.
