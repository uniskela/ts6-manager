# Presence-1 Implementation Plan

> **For agentic workers:** Do not implement until D1 acceptance and the shared TeamSpeak identity persist (D2-1 or equivalent) are done. Then use superpowers:subagent-driven-development or executing-plans task-by-task.

**Goal:** Shared TeamSpeak nickname roster of verified Discord humans in the mapped voice channel, including silent sitters.

**Architecture:** One existing TS client. One mix. Display only. Probe `HumanFilter` for every mapped-channel voice-state member. Format ≤30 UTF-16 with stable first-seen order and `+N`. Coalesce `clientupdate`.

**Tech Stack:** D1 worker (`packages/discord-bridge`), existing `HumanFilter`, `buildCommand('clientupdate')`, discord.js voice-state cache.

**Spec:** [2026-10-29-teamspeak-discord-presence-design.md](../specs/2026-10-29-teamspeak-discord-presence-design.md)

## Global Constraints

- Display presence is independent of DAVE, speaking, and `VoiceAdmission`.
- No extra Discord or TeamSpeak clients.
- Presence-2 is not approved. Needs a Bridge-K amendment first.
- Do not land on PR #504 / D1 beta / live image.
- TeamSpeak nicks 3–30 characters (error 1541). Discord’s 32-character `[TS] ` helper is the wrong limit.
- Example format: `DC • Sam, Jordan +2` (generic names only).
- Flood 524/3329: hold ~30s, keep previous nick, do not stop audio.
- Unknown identities stay off the nick until `HumanFilter.isHuman(id)` returns true.

---

## Files (when implementation is authorised)

| File | Change |
|---|---|
| `packages/discord-bridge/src/core/discord-presence-nick.ts` | **New.** Pure formatter: names → ≤30 string, first-seen order, `+N`, surrogate-safe. |
| `packages/discord-bridge/src/core/discord-presence-nick.test.ts` | **New.** Deterministic format tests. |
| `packages/discord-bridge/src/adapters/ts-session.ts` | `setNickname` via `buildCommand('clientupdate', { client_nickname })`. Connect still uses `clientinit`. |
| `packages/backend/src/voice/tslib/commands.ts` | No new command helper unless `buildCommand` already suffices (it does). |
| `packages/discord-bridge/src/bridge/runtime.ts` | Roster from live voice-state + HumanFilter answers; ~2s coalesce; reconnect rebuild. |
| `packages/discord-bridge/src/adapters/discord-bot.ts` | Membership events already flow; ensure sitters trigger filter probes (not speak-only). |
| `packages/discord-bridge/src/core/human-filter.ts` | Reuse `isHuman`; Presence-1 must **call** it for every mapped-channel member. |
| `packages/discord-bridge/scripts/expected-tests.json` | Register new test files. |

Do not touch receiver election, DAVE guards, `VoiceAdmission`, or slot routing in these PRs.

## Dependency on D2 identity persist

Without a persisted TS identity, a reconnect is a new uniqueId and the nick is connect-only. Presence-1 still **works** on an ephemeral client if `setNickname` exists, but the approved sequence is: D1 GO → persist the one identity → Presence-1. Do not ship Presence-1 on the disposable D1 nick `ts6-bridge-d1` as a product.

## Milestones

### M0 — Gate (no code)

D1 A–D PASS + review. Identity persist merged or explicitly waived by owner.

### M1 — Pure nick formatter

Tests first:

- empty → `Discord` (or persisted 3–30 default)
- one / two names that fit
- `+N` never dropped; 30 UTF-16; no dangling surrogate
- first-seen order; returning leaver appends
- bots/unverified never in the input set (formatter assumes already filtered)

### M2 — `TsSession.setNickname`

- Sends `clientupdate client_nickname=`
- Unit: command string escaped; 1541/524/3329 mapped to typed errors
- Does not disconnect on failure

### M3 — Roster source

- Input: guild voice-state cache, mapped `channelId`, `HumanFilter` per member
- Silent / never-spoken human appears after identity answer
- Leave/move/unverified → gone on next recompute
- Receive-generation bump does not change membership
- Tests with fake voice-state + filter (no live Discord)

### M4 — Coalesce + flood

- ≥ ~2s between sends; latest desired nick wins
- 524/3329: hold, previous nick kept, audio continues
- Five membership events in 200 ms → one `clientupdate`
- TS reconnect: after `clientinit`, set nick from **current** cache

### M5 — Wire into runtime (still lab-safe)

- Call M3/M4 from `voiceStateUpdate` and filter settlement
- No change to mix, election, DAVE
- Simulated runtime test: sitter listed; unverified speaker not listed and not mixed

### M6 — Acceptance (live, later)

Operator hear/see only: nick shows silent sitter; leave removes them; DAVE down does not empty the nick; 30-char; no audio stop on 524.

## Release placement

Not v1.11.x. Not D1. After D2 persist-identity, as a `feat:` in the v1.12.0 Discord lane (or a follow-up if D2 was `chore:` packaging). Keep out of `docs/manifest.json` until product docs exist.

## Presence-2

Deferred. Individual TS identities amend Bridge-K. Do not schedule from this plan.

## Tracking

[#556](https://github.com/uniskela/ts6-manager/issues/556) stays open until Presence-1 is implemented. Do not close it from docs PRs.
