# Bridge-D1 DAVE lifecycle: independent diagnosis for Cursor

Reviewed repository: `uniskela/ts6-manager`, draft PR #504, exact base
`197cb0f69c4cde9022ecb800e9477e28aa758d69`.

This diagnosis was completed without consulting or coordinating conclusions with Claude.
The candidate is an **uncommitted local source patch**, with regression tests. No live
deployment, credentials, containers, images, release, PR state or merge was changed.
Pre-existing edits to `lab/PRIVATE-BETA.md` and `lab/PRIVATE-PILOT.md` were preserved.

## Finding: the bridge turns an idle MLS wait into a terminal failure

Voice Ready establishes the voice transport, not an MLS group. In the pinned
`@discordjs/voice@0.19.2`, `Networking.onWsPacket(SessionDescription)` sets Networking
Ready with a newly initialized `DAVESession`. Initialization emits the key package;
it does not require a successful welcome/commit before VoiceConnection Ready.
The existing native-davey test in `src/core/dave-observe.test.ts` independently confirms
that davey 0.1.12 remains `ready=false`, status INACTIVE, after construction/reinit.

`readDaveInfo()` and `daveEnforced()` correctly distinguish these states. The bug is
the lifecycle policy around them:

- `DiscordBot.joinNow()` waits for Voice Ready and then calls `requireDave()`.
- At the reviewed HEAD, `requireDave()` starts a fixed 10-second deadline regardless
  of membership. No welcome means `noteFailure()`, connection destruction and rejection.
- Health and the watchdog are installed only after that wait succeeds. Initial idle
  waiting therefore cannot recover through the already-joined watchdog path.
- `BridgeRuntime.desiredMembers()` always wants slot 0 when TeamSpeak has no occupants.
  It does not require a Discord human before starting the idle bot.
- `D1_DAVE_SINGLE_ATTEMPT=1` maps to adapter `maxRecoveries=0` and runtime
  `maxAttempts=1`. Once that idle wait is classified as failure, the next rebuild is
  permanently refused. A later Discord human does not itself run runtime membership
  sync; the current Discord listener only revokes departed voice admissions.

This explains the observed Ready → protocol 1/unready → 10-second teardown →
fail-closed progression. The earlier successful human-present negotiation is consistent
with it. **It does not prove why Discord withheld the welcome/commit** or that every
bots-only channel behaves this way. The simulation supplies MLS events explicitly;
it does not simulate Discord's server-side MLS membership policy. An external sender
event alone supplies no proof of group readiness.

Initial slot 0 joins self-deafened because no receiver has yet been elected. After DAVE
establishment the runtime elects it and rejoins to undeafen. The human-first control
passes through this same sequence. There is no demonstrated need to force speaking,
toggle self-deafness repeatedly, reset MLS, or bypass the encryption gate to bootstrap.

## Other confirmed lifecycle defects

| Defect at reviewed HEAD | Consequence | Candidate correction |
| --- | --- | --- |
| The five-second loss grace runs even after the last human leaves | An idle protocol-1/unready session is destroyed and can exhaust the zero-recovery policy | Park the known bots-only transport with audio closed; start a fresh grace when a possible human is present |
| Grace expiry tests cached `daveOk` rather than live readiness | A welcome just before expiry can be followed by destruction if the watchdog has not observed it | Recheck the live connection, readiness and occupancy at expiry |
| `requireDave()` exits its loop after the final sleep without another cancellation checkpoint | `leave()` during that sleep becomes timeout/failure debt; even a later intentional join can be refused at max=0 | Check cancellation before evaluating timeout/failure |
| Runtime departures consider only `inChannel`, which is filled after join success | A pending join remains alive after its TeamSpeak slot is no longer desired; indefinite parking would magnify this bug | Include pending joins and retry timers in departure reconciliation |
| Join completion only checks runtime shutdown, not current desired membership | A late or uncancellable port can publish unwanted membership/health | Recheck desired membership before accepting completion |
| `e.max === 0` returns only from the current refusal handler | Later syncs call `join()` again and repeat warnings | Latch permanent refusal per bot for this runtime; clear any stale retry timer |

The budget itself already prevents actual extra rebuilds. In the deterministic baseline
reproducer, four TeamSpeak enter/leave pairs generate **eight slot-0 refusal warnings**
and zero additional slot-0 connections. The candidate emits one refusal. Planned joins
and intentional cancellations remain free; failure debt still survives intentional leave.
This mode means zero failure-driven rebuilds, not a ban on all subsequent planned joins.

Discord human departures and TeamSpeak slot departures are separate inputs. The former
revoke voice admissions; the latter change desired bridge-bot membership. The candidate
does not use Discord human presence to assign TeamSpeak slots or confer election eligibility.

## Session identity and receiver election

The existing fencing design is appropriate and stays intact:

- A receiver binds its generation and admissions to the identified DAVE session epoch.
- Identity includes Networking, wrapper, native session and in-place `reinit()` count.
  Reinitialization is counted before the original call. A ready→ready MLS reset cannot
  reuse the old admission merely because readiness polling missed a gap.
- A normal membership welcome/commit does not itself create a new session epoch.
  A real reset that goes through `reinit()` does. Rebuilding forgets the old identity
  while epoch numbering remains monotonic.
- DAVE loss tears reception down, flushes queued frames and invalidates the generation.
  The holder may be retained during grace/parking, but cannot admit a subscription/frame
  while its DAVE flag is false. Restoration uses a fresh generation and admissions.
- An initial parked join remains unresolved and unhealthy, so it is not elected. An
  already-established bot that loses DAVE can retain the fenced holder. The candidate
  does not mark a parked, unready initial join healthy or invoke `daveRestored()` early.

New deterministic tests cover both ordinary membership welcomes preserving identity and
an in-place ready→ready reset advancing identity/generation. They also verify cancellation
of an unwanted pending slot, its later legitimate rejoin with a new epoch, and election
of the bot whose DAVE is actually established.

## Smallest candidate patch

Production edits are limited to `src/adapters/discord-bot.ts` and `src/bridge/runtime.ts`
under `packages/discord-bridge/`. The gate, session identity, election and audio pipelines
are unchanged. The supporting edits add two initial-state/logging options to the existing
test harness and register the new file in the checked test manifest.

The adapter's `knownBotsOnly()` controls deadlines only. Parking requires:

1. A Ready connection with protocol >=1 and an identifiable native session.
2. Our own cached voice state in the configured channel.
3. Every other cached peer being an excluded bridge identity or a known bot.

A missing self voice state, unknown peer, absent session or protocol 0 retains bounded
failure behavior. While initially parked, `requireDave()` continues cancellable polling.
When a possible human appears, a new 10-second establishment deadline begins at the next
poll. During a previously established session's loss, voice events and the watchdog
cancel the five-second grace while parked and arm it when a possible human is present.
The grace callback checks live readiness before recording failure.

Ten seconds and five seconds are reasonable provisional bounds for an active negotiation
and transient loss, respectively; the evidence here does not validate their adequacy for
Discord latency. **Neither is a meaningful deadline for an indefinite idle MLS wait.**
Increasing both constants would merely postpone this reproducer. The candidate retains
their values and changes which state consumes them. Polling adds up to approximately
200 ms to initial membership observation; a timer never opens an audio gate.

## Proof of closed audio boundaries

The proof is scoped to this pinned library, these guarded bridge paths and the simulation;
it is not a live interoperability or cryptographic certification.

**TeamSpeak → Discord.** `sendOpus()` refuses unavailable DAVE. The connection wrappers
also guard `prepareAudioPacket()`, `playOpusPacket()` and `dispatchAudio()` with the live
`enforced()` predicate, independently of the watchdog. Dispatch additionally checks the
wrapper used at preparation. Existing tests cover loss between preparation and dispatch.
No idle-membership predicate appears in these permission checks.

**Discord → TeamSpeak.** The real receiver's `parsePacket()` wrapper returns null before
the library can pass plaintext through when DAVE is unavailable, or when the receive
session identity differs. When established, `refusePlaintext()` disables native passthrough.
The pipeline checks election generation, human admission/session identity and live DAVE
at enqueue and mix time. Departure/loss closes admissions and flushes buffered media.

The empty-start test demonstrates the library's real wrapper would return the supplied
Opus bytes unchanged with MLS unready. It then calls all three outbound connection
methods directly and injects a transport-encrypted RTP packet carrying plaintext media
into a manually opened real receiver subscription. No outbound wire packet, subscriber
payload, or TeamSpeak frame is emitted. The departure test queues an admitted frame
before loss/departure and confirms it is dropped at the final TeamSpeak boundary;
fresh encrypted media resumes only after restoration under a new admission.

The existing suite additionally covers protocol-0 fallback, native passthrough windows,
queued send loss, session replacement and immediate live checks before watchdog observation.
Silence-frame exceptions in the upstream library do not grant a path around these bridge
checks while unavailable.

## Startup and configuration

No startup/token race demonstrably explains this incident in the reviewed code.
`loadLabConfig()` validates required variables and repeated token strings. Private-beta
connects TeamSpeak, constructs bots, then sequentially awaits every bot's `login()` and
`verify()`. `login()` waits for client readiness and sets `userId`; duplicate resolved bot
identities are rejected. Runtime construction/start follows these checks. Voice joins
are deferred until `BridgeRuntime.start()`.

Thus the runtime has the bot identities before it starts voice. A Ready connection with
protocol 1 and an observed external sender is also inconsistent with a simple failure to
log in. Wrong credentials, target configuration or delayed gateway cache hydration are
not ruled out by an offline review, but no specific race linking them to the missing
welcome was found. No live environment file or token was read.

Private-beta `runtime.start()` schedules joins without awaiting DAVE, so its `running`
message reports the process/runtime lifecycle. `deriveHealth()` and the healthcheck still
require a receiver with DAVE ready. A parked session continues to report fail-closed.
Compose has `restart: "no"` and no published ports. These settings were left intact.
Startup signal handlers are installed late, after login/start/status setup; that is a
separate shutdown-hardening concern, with no demonstrated connection to this MLS stall.

## Observability findings, outside the minimal lifecycle patch

`dave-observe.ts` is diagnostic only; enforcement reads live session state. Two small
probes reproduced inaccuracies that should not be mistaken for protocol evidence:

```text
executeTransition(7) with no prepared transition: applied=false, traceLastOk=true
native readiness lost without a wrapped event: liveReady=false, traceReady=true
```

`observeDave()` treats only an object with `success:false` as failure; a boolean false
result is marked ok. Some methods use false for a no-op or "do not send ready", so prefer
recording the returned outcome separately rather than labeling every false an MLS error.
Trace metadata refreshes on wrapped methods/events or another `observeDave()` call;
the joined watchdog reads `enforced()` without refreshing the snapshot. Refresh metadata
before exposing/logging it, and attach to replacement wrappers, in a separate tested change.

The initial native `reinit()`/`keyPackage` event occurs inside the library's
`createDaveSession()` before that wrapper is published in Networking state. The observer
can miss these initial method/event counts. WebSocket opcode 26 may be captured earlier
because the WebSocket is already observed; these are distinct evidence sources. Opcode
31 is emitted through `sendPacket()` in the pinned library, while `observeDaveWs()` wraps
only `sendBinaryMessage()`, so the advertised `wsOut[31]` is not comprehensive.

An observed external sender with no later welcome/commit category supports "none observed
after attachment". It does not establish server intent, cryptographic validity, or absence
of all earlier traffic. Avoid logging payloads, credentials, MLS key material or privacy codes.

## Deterministic reproducer results

New file: `packages/discord-bridge/src/bridge/runtime.dave-idle.test.ts`.
It uses real bridge/runtime/library classes from the existing harness, fake networking
and native MLS readiness, and Node virtual Date/timeouts/intervals. The normal 10 s / 5 s
values are used; no Discord login, Docker, network service or live deployment is needed.

The identical final test file and harness were run against the exact original adapter
and runtime in a temporary isolated source snapshot: **15 tests, 6 pass, 9 fail**.
The same tests with the local candidate: **15 pass, 0 fail**.

| Scenario | Original HEAD | Candidate |
| --- | --- | --- |
| Empty startup; external sender, no welcome; 30 s virtual wait; closed boundaries | Fails: connection destroyed at 10 s | Pass: parked, no audio |
| Human-first startup; welcome at 9 s | Pass | Pass |
| Human joins after 30 s idle, then welcome within 9 s | Fails: original connection already gone | Pass: same connection, no recovery spent |
| Human present without welcome; four TS enter/leave pairs after timeout | Fails: eight permanent-refusal warnings | Pass: one refusal, no new slot-0 connection |
| Last human leaves; DAVE lost; 15 s idle; return and restoration | Fails: connection destroyed after loss grace | Pass: old audio/admissions fenced, new media resumes |
| Last human leaves during initial wait, later returns | Fails: idle wait is charged as failure | Pass: fresh bounded wait, no recovery spent |
| Membership welcome versus in-place ready→ready reinit | Pass | Pass |
| Native ready restored before grace expiry, watchdog still stale | Fails: destroys restored connection | Pass: reads live state |
| Returning human without restoration | Fails: connection was already destroyed during idle | Pass: destruction after resumed grace |
| Leave during final initial-DAVE poll | Fails: timeout/failure instead of cancellation | Pass: later planned join succeeds at max=0 |
| TS member leaves during pending join, later re-enters | Fails: unwanted connection survives | Pass: cancel, new epoch, legitimate free join |
| Shutdown during empty initial DAVE wait | Pass | Pass |
| Missing self cache / unknown peer / protocol 0 (three cases) | Pass: bounded failure | Pass: bounded failure |

Run from `packages/discord-bridge` using the package's existing Node 24 dependencies:

```bash
node --import tsx --test src/bridge/runtime.dave-idle.test.ts
node scripts/run-tests.mjs
./node_modules/.bin/tsc --noEmit
git diff --check
```

Final verification: the ordinary `node scripts/run-tests.mjs` run accepted **382 tests
in 40 files**, complete, with none failed, skipped, todo or cancelled. TypeScript checking
and `git diff --check` both exited 0. The earlier manifest-update run also passed all 382.
This isolated lab is outside the root pnpm workspace; no workspace toolchain migration
or dependency bump was made.

## Residual risks and follow-up for Cursor

1. Discord's real MLS policy remains unproven. Human-first success followed by loss does
   not establish the exact server transition after departure. If it becomes protocol 0,
   loses the native session or disconnects transport, this deliberately conservative
   candidate retains bounded teardown. It only parks identifiable protocol >=1 sessions.
2. Occupancy is a gateway-cache view. Own presence and unknown-peer checks improve the
   evidence but cannot prove cache completeness. A stale cache can extend an idle wait;
   it cannot satisfy the separate live DAVE gate. No REST polling or privileged member
   intent was added. Unrelated nonhuman bots do not guarantee MLS can establish either.
3. A parked initial `join()` stays pending, so `runtime.idle()` also waits. Private-beta
   does not call it in its startup path. `stop()` cancels the wait, which is checked on
   the next 200 ms poll; existing bounded shutdown still applies. The new pending-join
   cancellation fix must accompany parking.
4. A previously established parked holder remains fenced rather than failing over just
   for being empty. A human returning to a stuck group receives the existing five-second
   grace; whether this needs ten seconds or a distinct policy needs controlled live timing
   evidence. Keep audio closed throughout any longer wait.
5. Finite recovery budgets still allow sync-triggered refusal attempts while a wake timer
   exists; the budget caps actual rebuilds. This patch specifically latches max=0. Changing
   finite-budget retry/backoff arbitration would be separate work.
6. The hooks rely on pinned library internals (`parsePacket`, Networking state and native
   readiness). Re-run boundary/session tests when upgrading either voice or davey. Fake
   native MLS does not validate the server handshake or native cryptography.
7. The status currently labels a parked session fail-closed, with no explicit idle/waiting
   substate. A future diagnostic field could distinguish that state without claiming
   successful encryption or making the healthcheck pass prematurely.

Review the two source edits and the 15 cases before considering a separately authorized,
disposable live test: empty wait → late human → welcome → departure → loss → return.
Record only lifecycle categories, occupancy counts and timing. This handoff authorizes
no change to the protected deployment, publication, merge of #504, or relaxation of DAVE.
