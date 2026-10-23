# Discord voice bridge

**Date:** 2026-10-23
**Status:** Proposed. Draft PR for owner review, not accepted. Do not merge, publish, or start Bridge-D1 until the owner explicitly accepts the contract.
**Scope:** First-party optional Discord ↔ TeamSpeak voice bridge for v1.12.0 (Bridge-K…D6). Listener remote (#442) is unchanged. v1.11.2 (#460) is unchanged. No change to the native media sidecar, music bots, or listener-remote authentication.

## Goal

Let Discord users, including Xbox and PlayStation users, talk with people in an administrator-approved TeamSpeak channel without installing TeamSpeak. v1.12.0 ships the complete 5+1 model, a native admin UI, and an isolated Node 24 worker in the official deployment, disabled by default.

Do not downgrade to a single-bot or mixed-only product. If a gate fails, stop and ask the owner.

## Decisions

### 1. Isolated Node 24 worker, not the sidecar and not the backend process

Candidate stack: `discord.js@14.27.0`, `@discordjs/voice@0.19.2` (`engines.node >= 22.12.0`, DAVE via `@snazzah/davey@0.1.12`), `@discordjs/opus@0.10.0`, worker image **Node 24**. 0.19.2 has the receive-path padding fix; [discordjs/discord.js#11653](https://github.com/discordjs/discord.js/issues/11653) is still open on 0.19.2 (welcome at transition 0). The manager stays on Node 20 / pnpm 9. Untested DAVE receive is not proven. The Go sidecar is send-only WebRTC for music and video; TeamSpeak 6.0.0-beta5 rejects `sendrecv`.

Why not in-process: Node 20 cannot run that DAVE stack, and a crash would take music with it.
Why not Go: would rewrite the proven TS3 UDP client and DAVE.
Why not the sidecar: different transport, different crash domain, and a known TS6 offer incompatibility.

### 2. First-party bridge, not upstream PR #76

This is a new optional service. Do not import clusterzx/ts6-manager#76 Discord/SSO/i18n code. SSO and full i18n stay out of scope.

### 3. 5+1 Discord identities, one shared TeamSpeak client

TeamSpeak → Discord: five official bots named `[TS] Username`, plus `[TS] Others` for everyone else.
Discord → TeamSpeak: exactly one of those six bots is the **active receiver** and forwards human Discord audio to one shared TeamSpeak client.

Why not a TeamSpeak identity per Discord user in 1.12.0: six Discord applications is already the operator cost of 5+1; a matching TS pool is a later owner decision, not a silent extra.

Why not a seventh receive-only bot: the operator cost stays six. Receiver death therefore requires failover. Preferred election: overflow, then slot 0…4. A `receiveGeneration` allows only one bot to hold human subscriptions. Failure tears those subscriptions down before the successor subscribes. No healthy bot → Discord → TeamSpeak fails closed.

### 4. Map TeamSpeak people by uniqueId

Slots are keyed by the TeamSpeak unique identity, not the display name. A rename keeps the slot. A reconnect within the hold window keeps the slot. Display names only affect the Discord nickname.

### 5. D1 must prove both directions before D3/D4

D1 is not a mixed-only lab. It must show **two TeamSpeak users speaking at the same time** independently routed to two official Discord bots with no crosstalk, and Discord → TeamSpeak through the elected receiver. It must also run both join orders, DAVE transitions, decrypt recovery, receiver failover, and the Node 24 native-addon smoke. D3 and D4 do not open until that evidence is written into the contract. Untested reception is not proven.

### 6. Off by default, fail closed

Default compose does not start the worker (profile `discord-bridge`). `DISCORD_BRIDGE_URL` stays unset. No mapping, missing token, or unverifiable channel membership means the worker does not join either platform. Compose starting limits: 1 CPU / 512 MiB. The Dockerfile is a pinned Node 24 digest; CI must load native Opus and DAVE, and must test `opusscript` if native Opus fails. DAVE has no fallback.

## Approach

Backend (Node 20) stores encrypted tokens and mappings, enforces admin/per-server access, and talks to the worker over an internal URL plus bearer secret (`DISCORD_BRIDGE_URL`, `DISCORD_BRIDGE_SECRET`). The worker joins Discord (DAVE) and TeamSpeak (copied tslib TS3 UDP). PCM exists only in the worker process. The worker does not read bot tokens from compose environment in production.

```text
Discord humans ──DAVE──▶ elected receiver ──PCM──▶ shared TS client ──▶ TeamSpeak channel
TeamSpeak users ──TS3──▶ worker slots ──DAVE──▶ five [TS] Username bots
                         worker overflow ──DAVE──▶ [TS] Others
```

Copy the needed `packages/backend/src/voice/tslib` files into `packages/discord-bridge` for D1. Extract a shared package only after the live S2C parse is proven. Do not edit `voice-bot.ts` or `packages/sidecar`.

Incoming TeamSpeak S2C voice is documented as `VId u16 + speaker CId u16 + codec u8 + Opus`. Live TeamSpeak 6 has not been captured yet. That parse is the D1 kill switch.

## Components

| Unit | Role |
|---|---|
| `packages/discord-bridge` | Node 24 worker. DAVE send/receive, tslib, slot table, overflow mix, health, reconnect |
| Backend `discord-bridge` routes | Admin-only start/stop/config/status. Write-only token fields |
| Prisma `DiscordBridge` / `DiscordBridgeBot` | Per TeamSpeak server mapping; `enabled` default false; tokens AES-256-GCM |
| Admin page `/discord-bridge` | Mapping, pool, overflow, participants, gain, mute, start/stop, redacted logs |
| Official compose service | Profile `discord-bridge`; sibling container; 1 CPU / 512 MiB limits; no published worker port |

## PRs

| ID | Title | Opens after |
|---|---|---|
| Bridge-K | This spec, the contract, and the scope reversal | Owner review of these docs |
| Bridge-D1 | Isolated worker + live bidirectional proof | Bridge-K accepted. `feat:` waits for #460 |
| Bridge-D2 | Official image/compose, control plane, encrypted tokens | D1 proof recorded |
| Bridge-D3 | Five slots, persistent mapping, rename, rate limits, reconnect, reassignment | D1 proof + D2 |
| Bridge-D4 | Overflow mix and individual ↔ overflow transitions | D3 |
| Bridge-D5 | Native admin UI | D2 API; merge after D4 |
| Bridge-D6 | TS6 + Discord desktop + each claimed console (untested = unverified); reconnect, isolation, latency, security, #442 regression | D4 + D5 |

Do not merge or publish any of these without explicit owner approval.

## UI

Administrator-only page. Viewers cannot change settings. Per-server access applies. In-page notice that audio crosses Discord and TeamSpeak. Token inputs are write-only and blank on read. No secrets in browser responses.

Onboarding is six official bots → invite/permissions → channel authorisation → compose profile + secret → token validation without joining voice → disclosure → Start. D6 records which consoles were actually tested; any claimed console not in the run is unverified.

## Out of scope

- Per-Discord-user TeamSpeak identities
- Absorbing upstream PR #76, SAML SSO, or full i18n
- Self-bots
- Audio recording or retained audio
- Identity linking for people who sit in both rooms
- Changing #442, #460, versions, or `CHANGELOG.md`
- Publishing `docs/internal/` via `docs/manifest.json` (public guide is after D6)

## Tests

Recorded in [discord-voice-bridge.md](../../discord-voice-bridge.md). D1 is a live two-direction proof. D3 and D4 have the identity and overflow cases below. D6 is the release matrix.

## Blockers

A technical blocker is an owner decision. Agents must not move incomplete work into another release or ship a single-bot stand-in as v1.12.0.
