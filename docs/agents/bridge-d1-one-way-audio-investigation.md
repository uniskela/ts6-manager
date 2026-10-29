# Independent D1 one-way audio investigation

Investigation date: 2026-10-29. Reviewed base: `7f4d6c73049a1643f825d15c413eea1491a4e128`.
This report and candidate are separate from draft PRs #504 and #563. No live connections,
deployment access, server changes, publication, merge, or recovery-budget changes were made.

## Decision and evidence limits

**A permanent encrypted TeamSpeak receive failure is reproduced. The private-beta incident's
cause is not established.** The incoming TS transport never advances its encryption generation.
After the server's 16-bit packet ID wraps, real-key encrypted generation-1 packets fail
authentication indefinitely on that connection. This occurs before directory lookup or Discord
playback. The small candidate fixes that specific defect.

The operator's elapsed-time estimate is uncertain: initially 3–8 minutes, subsequently possibly
20 minutes. A single uninterrupted stream at 50 packets/second reaches 65,536 packets after
1,310.72 seconds (21m50.72s). Multiple incoming streams can increase the aggregate rate; that
rate and the actual incoming encryption mode were not observed. Timing alone cannot attribute
the incident. **Unencrypted TS voice is unaffected by this defect.** No pre-failure packet or
counter trace was supplied, and no additional deployment evidence was collected.

The supplied 10:31:43 UTC observation (`protocol=1`, one voice member, one bot, native not ready,
zero failures) is consistent with an intentionally parked bots-only MLS state. It does not
explain an earlier failed transmission while a human remained in Discord. The later Docker
unhealthy state follows the receiver-centric health calculation; it is not a timestamp for
the original audio failure.

## Ranked hypotheses

Rank is investigation priority with current evidence, not a probability estimate.

| Rank | Hypothesis and references | Evidence / limits |
| --- | --- | --- |
| 1 | Encrypted TS receive generation never advances: `packages/backend/src/voice/tslib/client.ts`, `handleIncomingPacket()` and `decryptPacket()`; `crypto.ts`, `deriveKeyNonce()` | Reproduced with authentic AES-EAX packets at the wrap boundary and a complete 65,540-packet stream. Base accepts gen 0 and permanently rejects gen 1. Fits an extended stream and can affect all speakers while reverse-direction audio survives. Conditional on encrypted incoming traffic and accumulated packet count. |
| 2 | A required sender is unhealthy or lacks DAVE while the elected receiver works: `discord-bot.ts`, `sendOpus()`, `updateDaveGrace()`, `markUnhealthy()`; `runtime.ts`, `scheduleRetry()`; `beta-status.ts`, `deriveHealth()` | `sendOpus()` silently returns before offering frames. Ordinary failed joins eventually stop retrying until membership changes. Receiver health does not establish sender health. This is a supported failure path, but no earlier per-sender evidence identifies it in the incident. Do not change the D1 budgets to hide it. |
| 3 | Directory/routing drops after membership churn: `client-directory.ts`, `byClientId()` / `ingest()`; `ts-to-discord.ts`, `onVoice()`; `runtime.ts`, `onDirectory()` | Unknown clid, wrong channel, excluded UID, or absent route all discard voice. Correct enter/leave events and new clids route via stable UIDs. Lost/incorrect events or stale snapshots remain possible; no reconciliation watchdog proves the directory matches the server. Existing membership tests and the new two-speaker lifecycle simulation pass. |
| 4 | Player subscription, resource, or feed becomes detached: `discord-bot.ts`, `buildConnection()`, `discardConnection()`, `sendOpus()`; `frame-feed.ts` | New connections explicitly subscribe the existing player. Pinned voice 0.19.2 preserves subscriptions through `rejoin()`. DAVE loss destroys buffered outbound audio; restored speech makes a new feed. Starvation ends/destroys a resource and subsequent speech recreates it. Accelerated streaming, silence/resume, repeated joins and recreation pass. No natural permanent-detachment trigger was found. |
| 5 | Valid but unsupported Opus frame configuration: `opus-packet.ts`, `splitOpusPacket()`; `ts-voice-packet.ts`, `parseS2CVoice()` | Slot path drops indivisible 40/60 ms frames, incomplete sub-20 ms packets, invalid packets and unsupported codecs. A lasting source/configuration change can keep producing drops. Supported multi-frame packets are split/regrouped into 20 ms packets. No packet metadata from the failure establishes a format change. |

An externally detached player subscription is sufficient to make the acceptance counter rise
without dispatch. An offline experiment explicitly unsubscribed a ready connection, then offered
12 frames over 240 ms: accepted=12, dispatched=0, healthy=true, DAVE-ready=true, player=playing.
This proves a metric blind spot; it does **not** establish that D1 naturally removes a subscription.
No speculative subscription repair was added.

## Exact reproduced mechanism and minimal fix

1. Server-to-client TS packets carry a 16-bit packet ID. Encryption derivation includes an
   additional 32-bit generation (`crypto.ts`, `deriveKeyNonce()`).
2. Outgoing counters already advance generation on wrap (`incPacketCounter()`). At the base,
   `inGenerationCounter` is only created, reset and read. It remains zero.
3. Real-key encrypted voice at gen 1 fails AES-EAX authentication under gen 0. The existing
   dummy-key compatibility attempt also fails. `handleIncomingPacket()` returns before emitting
   `voice`, so `TsSession`, `ClientDirectory` lookup, `SlotRouter`, `TsToDiscordPipeline`,
   `DiscordBot.sendOpus()`, `FrameFeed`, `AudioPlayer` and Discord receive no further source audio.
4. This is a distinct counter per transport packet type and direction. Voice can fail while
   low-volume control traffic and outgoing TS audio continue. A speaking user's TS leave/rejoin
   does not reset the bridge's transport generation. A Discord reconnect cannot repair it either.

The candidate changes only `decryptPacket()` in the shared backend source of truth (19 added
lines). After current-generation authentication fails, it tries the next generation and, when
available, the previous generation. Only successful next-generation real-key authentication
advances state. Previous-generation success never rolls it back. Guesses are bounded; unauthenticated
packet IDs do not select state. The existing TS compatibility paths are unchanged and do not advance
generation. DAVE encryption gates, bot exclusion, recovery budgets and product contract are unchanged.
The bridge's generated `.vendor/tslib` copy is regenerated, never committed or independently edited.

## Reproduction and verification

Commands run from `packages/discord-bridge`, using Node 24 and the existing pinned dependencies:

```sh
node scripts/sync-tslib.mjs
node --import tsx --test src/adapters/ts-session.rollover.test.ts src/adapters/discord-bot.playback.test.ts
node_modules/.bin/tsc --noEmit
node scripts/run-tests.mjs --update
node scripts/run-tests.mjs
```

Baseline suite: 383 tests in 40 files passed. The first three transport regressions were written
before the fix and failed on base: two valid pre-wrap packets arrived, all new-generation packets
were lost (2 received versus 5 expected). They passed after the candidate. Added coverage:

- 65,540 real encrypted incoming packets, covering a complete generation plus post-wrap traffic.
- Missing exact boundary packets, delayed previous-generation packets and a second rollover.
- Forged packets cannot advance generation; delayed packets cannot roll it back; whisper and
  channel voice have independent counters. Tests distinguish these state errors behaviorally.
- Existing unencrypted, dummy-key and pre-negotiation behavior; 32-bit upper bound and bounded search.
- Encrypted TS packet → real TS parser → directory command → route → passthrough → real player →
  real voice connection → DAVE wrapper → simulated dispatch, on both sides of rollover.
- 10,000 accelerated player ticks followed by silence and a fresh speech turn.
- Repeated leave/join, sender connection destruction/recreation, receiver rejoin with the same
  subscription, and DAVE ready → lost → ready without a reconnect.
- Two TS speakers retain distinct senders; recreating the non-receiver sender does not interrupt
  working Discord → TS audio or move the receiver.

Candidate suite: 394 tests in 42 files. The strict runner verifies file/test completeness and
rejects failed, skipped, cancelled or missing tests; updating its expected manifest was necessary
for the 11 new tests. Typecheck passed. The full encrypted-stream case is CPU intensive and took
about 47–101 seconds depending on concurrent load; it is not a 22-minute wall-clock soak.

The initial new reverse-direction test sent only one UDP packet before asynchronous human
identity admission and timed out. Correcting the fixture to keep talking through admission
made it exercise actual audio delivery; no production receive logic was changed.

These tests use real bridge components, voice-library players/connections and AES-EAX, with a
fake Discord network and fake native DAVE session. They establish local transport behavior and
simulated dispatch, not audible playback, interoperability with a real TS6 server, or native MLS
behavior. An independent reviewer inspected the patch and independently ran all 11 new tests:
no blocking findings after strengthening the generation-invariant tests.

## Counters, health and required diagnostics

The beta `counters.framesSent` is `runtime.d2t.framesSent` (`beta-status.ts`, `buildBetaStatus()`),
incremented after handing audio to TS (`discord-to-ts.ts`, `tick()`). It can increase while all
TS → Discord audio is silent. It is cumulative and does not establish current TS delivery either.

Other similarly named counters do not prove audibility:

- `TsToDiscordPipeline.forwarded` counts calls at the sink boundary, even when `sendOpus()` rejects
  for health/DAVE (and optional sink lookup is absent). It is not an accepted/dispatch counter.
- `DiscordBot.framesSent` counts feed offers before player preparation, encryption and dispatch.
  Queue drops and absent subscriptions can leave it rising with no audible output.
- Existing beta health examines the receiver's DAVE state and aggregate reconnect/decrypt counters.
  It neither verifies every required sender nor distinguishes parked MLS from failed audio.

**New privacy-safe telemetry is needed to identify the incident's failing boundary.** The known
rollover defect itself does not need additional diagnostics to establish its mechanism. Recommended
restricted snapshot fields, without changing public host status:

| Boundary | Evidence to retain |
| --- | --- |
| TS UDP before decrypt | Counts per packet type, encrypted versus unencrypted counts, auth successes/failures, current authenticated receive generation, rollover successes, monotonic time since last valid channel voice. Never key material or raw packets. |
| Directory/router | Counts for unknown client, wrong channel, own voice, excluded identity, missing route; valid in-channel source count and successful frame routing. No UIDs, clids, names or addresses. |
| Each required slot | Required/in-channel/healthy, connection status, DAVE protocol/ready, known human/bot/unknown member counts, parked-bots-only flag, resource/player status, current subscription presence and identity match to its player. |
| Sender/feed | Offered, health-rejected, DAVE-rejected, accepted, queued, queue-dropped, starved, resource creations/ends/errors; prepare/dispatch attempts/successes/failures and last-success age. A dispatch success still does not prove the listener heard it. |
| Lifecycle | Fixed reason categories for planned join/leave, receiver undeafen rejoin, transport destruction/disconnect, DAVE grace expiry, recovery and retry exhaustion. No arbitrary error strings in the restricted schema. |

`private-beta.ts` already obtains runtime routing counters, but `buildBetaStatus()` projects them
away. It omits per-slot players, subscriptions and source transport counters. `live.ts` has some
playback drop/starvation diagnostics that private beta does not publish. Detailed additions should
use explicit field allowlists in the existing 0600 `private-beta-status.json`. `hostStatusView()`
must continue its small allowlist in the separate 0644 host file; no detailed diagnostics there.
Avoid blanket TS debug logging: existing transport debug can include crypto material and command
contents. This candidate deliberately leaves diagnostics schema and health semantics unchanged.

## Independent nickname defect

The TS command stream reaches `TsSession` and `ClientDirectory`. At `client-directory.ts:76`,
`notifyclientupdated` mutates the nickname but returns no directory event. `TsSession` emits only
events returned by `ingest()`, so `BridgeRuntime.onDirectory()` / `sync()` / `applyNickname()` never
run solely for that rename. A direct offline reproduction returned
`{directoryChanged:true, emittedEvents:0}`. A later unrelated membership event can make the rename
appear, explaining intermittent synchronisation. The update case also handles only `params`,
unlike the grouped membership cases.

Two further source-supported defects are independent of missing events: `applyNickname()` stores
`appliedNick` before the REST operation succeeds, and `DiscordBot.setNickname()` catches failures
and resolves. An absent `guild.members.me` silently does nothing through optional chaining. Failed
updates are therefore remembered as applied, suppressing an ordinary same-name retry. Runtime
tracking does not serialize nickname operations; asynchronous guild fetches / leave resets / later
renames can submit obsolete requests after newer intent. Discord's REST rate-limit queue does not
supply bridge-level success tracking, coalescing or latest-intent guarantees.

Proposed separate fix: emit explicit update events, use a per-bot latest-desired-name worker, obtain
the current guild member reliably, return/propagate REST failure, commit applied state only after
success, and retry with bounded backoff while coalescing obsolete intent. Test rename-only events,
failed requests, rate-limited retries and reverse completion order. **No nickname changes are bundled
with the transport candidate.** Nickname updates do not drive the audio feed; this issue does not
establish a cause of permanent one-way silence.

## Music-bot discrepancy

The beta entrypoint creates `BridgeRuntime` without `excludedUniqueIds`, while the core exclusion
contract supports configured TS music-bot UIDs and query-client exclusion (`runtime.ts`, `isExcluded()`;
`runtime.exclusion.test.ts`). Thus beta can assign and forward a TS music bot as an ordinary source.
That differs from Bridge-K's configured-music-bot exclusion default. TS clients do not universally
advertise a reliable music-bot type. This report records the discrepancy; it changes no policy,
defaults, configuration or contract. Discord-side non-human exclusion remains a separate mechanism.

## Remaining risks and GO / NO-GO

- The incident still lacks encryption mode, transport packet counts, sender/subscription state
  and synchronized source-versus-dispatch counters at onset. The parked DAVE observation is later.
- Native DAVE/Discord transport and actual audible playback have not been validated here.
- The shared backend transport changes too; test coverage exercises its generated bridge copy,
  not a complete backend integration suite. No standalone backend dependency installation was present.
- Bounded adjacent-generation search cannot recover after missing an entire generation. It adds
  up to two authentication attempts on invalid encrypted traffic. Existing replay behavior and
  dummy-key compatibility remain; this is not a replay-window or crypto-hardening redesign.
- Sender retry exhaustion, unsupported formats, membership inconsistencies, external mute/permission
  state and transport/server issues remain possible independent causes.

**GO:** retain the independently reviewed fix in a separate draft; review and prepare an instrumented,
operator-supervised test. **NO-GO:** merge/integrate it into #504, declare the incident fixed, deploy,
or treat it as D1/D2 acceptance. Before a fix-specific live trial, establish encryption mode and
packet-rate/generation evidence, add the restricted diagnostics above, and approve the test plan.

A later authorised trial should run past at least two receive-generation boundaries with continuous
source traffic, listener confirmation and fresh boundary counters; exercise two speakers, independent
sender/receiver churn, source leave/rejoin, silence/resume and DAVE loss/restoration; verify both audio
directions throughout. Stop and capture the restricted boundary state on the first silence. A
supervised live validation remains required even when all local tests pass.
