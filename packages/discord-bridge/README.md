# Discord voice bridge: Bridge-D1 lab

**Status: draft feasibility lab. Not for merge. Not shipped. Disabled by default (it is not wired into any compose file, image, backend route or release workflow).**

This package is the isolated Node 24 proof of concept for the Discord ↔ TeamSpeak voice bridge defined by the accepted Bridge-K contract ([`docs/internal/discord-voice-bridge.md`](../../docs/internal/discord-voice-bridge.md)). D1 is a feasibility proof of the 5+1 design. It is not a reduced single-bot product.

**D1 result: the live Discord proof has not been run, so the D1 gate is not met.** See [Evidence](#evidence) and [GO/NO-GO](#gono-go).

**Independent review remediation (this branch).** The first independent review of `4548dc0` returned NO-GO. The defects it found are fixed in place and listed in [Review remediation](#review-remediation). Everything verified since is **simulated against the real library classes, native addons, or a real TS6 server with synthetic speakers. None of it is live Discord evidence.** The code is ready for a new independent review. It is not ready for, and has not had, live Discord testing.

**Second independent review (Codex, reviewed HEAD `d890b5d`).** It returned NO-GO for controlled live testing and for D1 acceptance, with twelve findings (F1 to F12). All are addressed on this branch and listed in [Re-review remediation](#re-review-remediation), with the reviewer's own reproduction probes re-run against the old and the new code. The simulated, native and TS6-laboratory evidence is again **not** live Discord evidence, and the D1 gate is still not met.

## What is in the lab

| Path | Purpose |
|---|---|
| `src/core/` | Pure routing logic: TS S2C packet parser, `SlotRouter` (uniqueId → one destination), `ReceiverElection` (`receiveGeneration` fence, DAVE-aware electability), `FrameMixer` (bounded, peak-limited, whole 20 ms frames, admission re-checked at mix time), `opus-packet` (RFC 6716 framing), both pipelines (decoders released on leave, close and idle), nickname rules, DAVE gate, receive supervisor, token redaction |
| `src/bridge/runtime.ts` | `BridgeRuntime`: one shared TeamSpeak client + six Discord identities (5 slots + overflow), idle-overflow rules, teardown-before-election, successor activation ahead of reconnects, `created → running → stopping → stopped` lifecycle |
| `src/adapters/` | `TsSession` (existing TS3 UDP client, channel voice only) and `DiscordBot` (discord.js + `@discordjs/voice`: per-bot connection group, DAVE enforced at every boundary, rebuild-on-failure with one budget, human-only receive filter) |
| `src/testing/` | Test harness that drives the **real** `VoiceConnection`, `AudioPlayer`, `VoiceReceiver`, `SpeakingMap` and `DAVESession`, faking only the native davey session, the gateway adapter and the UDP/WebSocket networking (simulated Discord, never live) |
| `src/lab/` | `smoke-deps` (native Opus/DAVE), `ts-live` (real TS6 server), `churn` (native decoder churn and memory), `live` (real Discord, operator-driven), library repro test |
| `lab/Dockerfile` | Two stages, Node 24 pinned by digest. The build stage installs and runs typecheck, all tests and the native smoke as gates. The runtime stage copies the installed tree read-only, runs as `node`, and runs the preinstalled `tsx` with no network. The base image still ships npm and corepack, but nothing at runtime invokes a package manager (the entrypoint is the local `tsx`) |
| `scripts/run-tests.mjs` | The test runner (`pnpm test`): runs `node --test` without a forced exit, writes a machine-readable report, and **fails** on any failed, skipped, cancelled or timed-out test and unless the files discovered, the files listed in `scripts/expected-tests.json` and the files that reported results are one set, each reporting exactly its listed test names (`--update` after reviewing a deliberate change; it refuses to record a run that does not pass these checks) |
| `scripts/sync-tslib.mjs` | Copies `packages/backend/src/voice/tslib` into git-ignored `.vendor/` (the backend copy stays the source of truth; `--check` detects drift) |
| `scripts/container-runtime-test.sh` | Network-independent runtime check of the lab image: `--network none`, read-only root, `--cap-drop ALL`, unprivileged, vendored code not writable |

Isolation choices:

- The package is **excluded from the pnpm workspace** (`pnpm-workspace.yaml` has `!packages/discord-bridge`) and has its own `pnpm-lock.yaml`. The Node 20 backend/frontend install and `Dockerfile.backend` are unchanged and never build the native addons. D2 decides whether this becomes a workspace package.
- Dependencies are exact pins: `discord.js 14.27.0`, `@discordjs/voice 0.19.2`, `@snazzah/davey 0.1.12`, `@discordjs/opus 0.10.0`, `opusscript 0.1.1`, `libsodium-wrappers-sumo 0.8.4` (same as the backend). `.npmrc` sets `engine-strict`.
- The existing media sidecar is untouched. No TeamSpeak video/WebRTC path is used.
- No audio is written to disk. PCM exists only in worker memory in 20 ms frames, with bounded queues (4 frames per source).

## Reproduce

Host (Node ≥ 22.12, pnpm 9.15.9):

```bash
cd packages/discord-bridge
pnpm install --frozen-lockfile --ignore-workspace
pnpm run typecheck          # syncs .vendor/tslib first
pnpm test                   # 219 tests in 23 files, verified complete (real @discordjs/voice classes, simulated Discord), no network, no credentials
pnpm run smoke:deps         # native Opus + DAVE + opusscript on the running Node
pnpm run churn              # native Opus codecs under 40 000 participants joining and leaving, both directions (needs --expose-gc, set by the script)
```

Node 24 container (the actual target image; build context is the repo root):

```bash
docker build -f packages/discord-bridge/lab/Dockerfile -t ts6-discord-bridge-lab:d1-r3 .
docker run --rm --network none ts6-discord-bridge-lab:d1-r3      # re-runs the native smoke, offline
packages/discord-bridge/scripts/container-runtime-test.sh ts6-discord-bridge-lab:d1-r3
```

The image is never published. The build needs the registry once (`pnpm install --frozen-lockfile`, in the build stage only). The runtime stage never touches a registry or a package manager: on the reviewed baseline the same `docker run --network none` failed because corepack tried to download pnpm at start (`EAI_AGAIN registry.npmjs.org`).

TeamSpeak-side live lab (a real TS6 6.0.0-beta13 server, synthetic speakers, simulated Discord sinks). The server is only on an internal Docker network:

```bash
docker network create --internal d1-lab
docker run -d --name ts6-d1-lab --network d1-lab --memory 512m \
  -e TSSERVER_LICENSE_ACCEPTED=accept teamspeaksystems/teamspeak6-server:6.0.0-beta13
sleep 9
docker run --name d1-ts-live --network d1-lab --cpus 1 --memory 512m -e TS_LAB_HOST=ts6-d1-lab \
  ts6-discord-bridge-lab:d1-r3 src/lab/ts-live.ts
docker cp d1-ts-live:/app/packages/discord-bridge/evidence/. ./evidence/   # raw evidence file(s)
docker rm -f d1-ts-live ts6-d1-lab && docker network rm d1-lab
```

The run takes about 2 minutes because the TS6 server's flood guard bans a source after about 6 joins in 25 s (see findings), so the lab spaces joins 12 s apart (`TS_LAB_CONNECT_GAP_MS`).

Live Discord run (needs authorised resources, see below):

```bash
D1_DISCORD_TOKEN_SLOT_0=… … D1_DISCORD_TOKEN_OVERFLOW=… \
D1_DISCORD_GUILD_ID=… D1_DISCORD_CHANNEL_ID=… D1_TS_HOST=… pnpm run lab:live
```

Without them `lab:live` prints each missing variable as `MISSING`, records nothing, and exits 2. Tokens are registered with the redactor, never printed, and the runner refuses to start unless all six tokens log in, are six distinct applications, and pass the guild/channel permission check (fail closed).

### Operator procedure for the live proof

Prerequisites (all must be authorised for this test): six official Discord applications invited to a test guild (View Channel, Connect, Speak, Use Voice Activity, Change Nickname), one test voice channel, a TeamSpeak 6 server and channel, and at least two humans on TeamSpeak and two on Discord (including one on Discord desktop who joins **before** the bridge and one who joins **after**).

`lab:live` reads commands on stdin: `status`, `kill-receiver`, `mark <check-id> pass|fail <note>`, `quit`. Results the bridge cannot observe itself (what a human heard) are recorded only when the operator attests them with `mark`, and the evidence file labels them `operator-attested`. Check ids: `live-two-speakers`, `live-d2t`, `live-join-order-a`, `live-join-order-b`, `live-dave-transition`, `live-decrypt-recovery`, `live-kill-receiver`, `live-no-feedback`, `live-latency`.

## Evidence

Labels: **LIVE** = real Discord and real TeamSpeak, real participants. **LIVE-TS6+SYNTH** = a real TS6 server with synthetic TeamSpeak clients (same TS3 UDP client), Discord side simulated. **NATIVE** = real native addons in the Node 24 container. **SIMULATED** = in-process fakes. **NOT-RUN** = no result exists.

### Required D1 proof

| Check | Result | Provenance | Notes |
|---|---|---|---|
| TS6 S2C speaker parse | PASS | LIVE-TS6+SYNTH | VId u16 + speaker CId u16 + codec u8 + Opus confirmed against 6.0.0-beta13; clid resolved to uniqueId from enter-view. Codec seen: 5 (Opus Music), because the synthetic speakers use the existing `sendVoice`. Codec 4 from a real TS client is unverified. |
| Two simultaneous TS speakers → two Discord bots, no crosstalk | **PARTIAL** | LIVE-TS6+SYNTH | Routing to two separate bot sinks, each carrying exactly one tone (>100× the other, Goertzel). Discord sinks are recorders. **Two real TeamSpeak users and two real Discord bot connections: NOT-RUN.** |
| Discord → TS via the elected receiver | **PARTIAL** | LIVE-TS6+SYNTH / SIMULATED | A second TS client heard a single mixed stream (500 Hz + 1500 Hz) from the one shared bridge client on a real TS6 server. The Discord input is simulated. **Real Discord receive: NOT-RUN.** |
| Receiver failover during active Discord speech | SIMULATED PASS | SIMULATED | One successor, strictly increasing generation, stale and zombie frames fenced at mix time, TeamSpeak gets one frame per tick. After remediation the successor is elected and activated before any unrelated reconnect, and a hung reconnect no longer holds the sync queue. **Live: NOT-RUN.** |
| No duplicate audio / no feedback | PARTIAL | LIVE-TS6+SYNTH / SIMULATED | Each uniqueId appears under one bot only; bridge-bot Discord ids are never subscribed or forwarded (unit tested). **Live acoustic/loop check: NOT-RUN.** |
| CPU / RSS / one-way speak-to-hear | **PARTIAL** | LIVE-TS6+SYNTH | See below. **Speak-to-hear through Discord: NOT-RUN.** |

### Discord receive cases

| Check | Result | Provenance | Notes |
|---|---|---|---|
| Join order A: receive bot first, human speaks | NOT-RUN | | needs Discord |
| Join order B: human first, then receive bot joins (#11653) | NOT-RUN | | The #11653 mechanism **is reproduced** in the pinned `0.19.2` code (below). Whether Discord actually triggers it is unproven. |
| DAVE transition: welcome, later transition, reconnect | NOT-RUN | | |
| Recovery after a decrypt error | SIMULATED PASS | SIMULATED | Subscriptions are restored deterministically while the human keeps talking. After repeated failures the adapter fences reception and reports the bot unhealthy at once; the runtime, the only automatic reconnector, elects a successor in the same turn and rebuilds a **fresh voice connection and DAVE session** in the background (a `rejoin()` on a Ready connection does not redo the MLS handshake; a destroyed connection is never reused). Every failure-driven rebuild, from any entry point, spends one sliding-window budget, so a bot that keeps failing stays out of service until time frees the budget. **Live: NOT-RUN.** |
| Already-speaking human when a receiver takes over or joins | SIMULATED PASS | SIMULATED | Continuous speech with no new speaking-start event is received, because the supervisor reconciles against the speakers the receiver already knows instead of waiting for an event. **Whether Discord sends SSRC mappings for humans already speaking when the bot joins is unknown. Live: NOT-RUN.** |
| Two bots in one guild: separate connections, players and receivers | SIMULATED PASS | SIMULATED, real library classes | Unique group per bot and bridge session; destroying one bot does not touch the other. **Live: NOT-RUN.** |
| DAVE never falls back to plaintext, including mid-transition | SIMULATED PASS | SIMULATED, real `DAVESession` | Enforced on outbound packets (re-checked at the last Discord dispatch, after the packet was prepared), on inbound decrypt, for queued and playing audio, and again when frames are mixed into TeamSpeak (before the watchdog has noticed); losing DAVE flushes and invalidates reception; a short grace window precedes failing over. **A real DAVE transition: NOT-RUN.** |
| Whisper packets are excluded | SIMULATED PASS | SIMULATED packets through the **real** `Ts3Client` parser | Voice and VoiceWhisper packet types are distinguished and only Voice is forwarded; a missing type fails closed. **Real TS6 server whispering to the bridge client: NOT-RUN.** |
| Only verified humans are forwarded | SIMULATED PASS | SIMULATED, real `VoiceReceiver` | A speaker is subscribed only when Discord says they are not a bot (cache, else a bounded background REST lookup); bridge bots, other bot accounts and unidentified users stay excluded (fail closed). **A real Discord user lookup: NOT-RUN.** |
| Playback latency is bounded | SIMULATED PASS | SIMULATED, real `AudioPlayer` | One budget of 4 frames (about 80 ms) covers the private queue and the stream's own buffer, oldest dropped first; a 100-frame burst sends at most six frames on the wire. |
| Malformed Opus does not stop other speakers | SIMULATED PASS | SIMULATED, native Opus | Contained at the network callback; the packet is dropped, the decoder reset, other speakers continue. |
| Bounded decoder memory under participant churn | PASS | NATIVE | 40 000 distinct participants through the real native decoder (`pnpm run churn`): per-user decoders 0 after close, at most 256 live without close notifications. The TeamSpeak to Discord direction (40 000 overflow guests) ends with 0 decoders, 0 routing entries (peak 1), no live codec after `dispose()` and nothing created or sent afterwards; RSS grew 0.1 MB after warm-up (`churn-native-r2-2026-10-25.json`). A 200 000-participant run held RSS flat on the close path (163.8 to 165.8 MB) and stepped once by about 28 MB on the idle-sweep path before plateauing, so there is no per-participant growth. RSS steps of tens of MB occur at random in steady state, so the pass limit is 64 MB over the post-warm-up window. That is well under a missed release, which costs about 47 KB per participant. |
| Lab image: offline, read-only, unprivileged runtime | PASS | NATIVE, container | `scripts/container-runtime-test.sh`: 9 of 9 checks. The baseline image fails the same run (`EAI_AGAIN registry.npmjs.org`). |
| Mixer fence: stale `receiveGeneration` frames never enter the TS mix | PASS | SIMULATED | Checked on push and again on every mix tick. |
| Node 24 image: native Opus loads | PASS | NATIVE | `@discordjs/opus 0.10.0`, round trip keeps a 1 kHz tone |
| Node 24 image: native DAVE loads | PASS | NATIVE | `@snazzah/davey 0.1.12`, creates an MLS key package |
| `opusscript` fallback smoke | PASS | NATIVE | `opusscript 0.1.1` |

Raw files: `evidence/curated/`.

| File | What it is |
|---|---|
| `ts-live-container-2026-10-24.json`, `smoke-deps-container-2026-10-24.json` | Original run, `ts6-discord-bridge-lab:d1`, Node v24.22.1 (kept as the pre-remediation record) |
| `ts-live-container-r1-2026-10-24.json` | TS6 laboratory rerun after remediation, `ts6-discord-bridge-lab:d1-r1`, 5 of 5 checks PASS, against `teamspeak6-server:6.0.0-beta13` on an internal Docker network |
| `churn-native-2026-10-24.json`, `churn-native-200k-2026-10-24.json` | Native decoder churn and memory (40 000 and 200 000 participants, RSS recorded every 10 % of the run) |
| `image-runtime-d1-r1-2026-10-24.txt`, `image-runtime-baseline-d1-2026-10-24.txt` | `container-runtime-test.sh` output for the new and the baseline image |
| `remediation-red-green-2026-10-24.json` | Per-test red/green results, see [Review remediation](#review-remediation) |
| `remediation3-red-green-2026-10-25.json` | Before and after reproductions of the third review's R1 to R4, see [Third review remediation](#third-review-remediation) |
| `ts-live-container-r3-2026-10-25.json`, `smoke-deps-r3-2026-10-25.json`, `image-runtime-d1-r3-2026-10-25.txt`, `churn-native-r3-2026-10-25.json` | TS6 laboratory (5 of 5 PASS), native smoke, offline image check (9 of 9) and churn (3 of 3 PASS) after the third remediation, image `ts6-discord-bridge-lab:d1-r3` |
| `remediation2-red-green-2026-10-25.json` | The second reviewer's own probes run against `d890b5d` and the fixed code, see [Re-review remediation](#re-review-remediation) |
| `ts-live-container-r2-2026-10-25.json`, `smoke-deps-r2-2026-10-25.json`, `image-runtime-d1-r2-2026-10-25.txt`, `churn-native-r2-2026-10-25.json` | TS6 laboratory (5 of 5 PASS), native smoke, offline image check (9 of 9) and churn (3 of 3 PASS) after the second remediation, image `ts6-discord-bridge-lab:d1-r2` |

### Measurements (TeamSpeak side only)

Container `--cpus 1 --memory 512m`, one process holding the bridge, 10 TS clients and 8 Opus encoders, so this is an upper bound for the bridge alone:

| Metric | Value |
|---|---|
| CPU, process average | 4 % of one core (peak 99.2 % during TS identity generation at connect, not steady state) |
| RSS, process | avg 103.5 MB, max 121.4 MB (rerun after remediation; the first run was avg 100.7 MB, max 111.9 MB) |
| TS speaker send → bridge receive (same host, via TS6) | p50 1.1 ms, p95 2.3 ms, max 6.5 ms, n=152 (first run: p50 1.1, p95 1.9, max 6.1, n=150) |
| Overflow mix tick latency | recorded in the evidence file |

Not measured: Discord send/receive latency, DAVE encrypt/decrypt cost, and true speak-to-hear, which needs real participants. No figure here may be used as a speak-to-hear number.

## Findings

1. **#11653 mechanism confirmed in `@discordjs/voice@0.19.2`.** After an MLS welcome at transition 0, `lastTransitionId` is `0`; on persistent decrypt failure `decrypt()` takes `if (this.lastTransitionId) recover… else throw error` and a falsy `0` throws. The receiver then calls `stream.destroy(error)`. `src/lab/dave-library.test.ts` reproduces both branches against the real library class with a stand-in for the native session. The review found that the lab's earlier answer, a `rejoin()`, does not help: on a Ready connection it only re-sends the voice state and keeps the same DAVE session. Recovery now discards the connection and builds a fresh one, and checks the new session is not the old one. Whether Discord actually produces this state, and whether a fresh session clears it, is **unproven** until the live run.
2. **The library does not enforce DAVE.** At protocol version 0 it passes media through unencrypted in both directions. Its decrypt also passes plaintext through when the session cannot decrypt or when passthrough is on. The lab therefore checks the live session (`protocolVersion ≥ 1` and `session.ready`) before every outbound packet, every inbound decrypt, every decode and every queue push, turns passthrough off, and on loss flushes and invalidates reception (fail closed). A short grace window lets a normal epoch transition finish before the bot is declared unhealthy.
3. **TS6 flood guard.** A single source IP that joins more than about 5 clients within roughly 25 s is banned (`error 3329`, "you are banned"). 12 s spacing works. This is a test-harness constraint; the production bridge uses one TS client. D6 test plans should account for it.
4. **Existing TS3 client limits for D2.** The transport knew the two packet types (Voice and VoiceWhisper) but emitted `voice` with the payload only, so a whisper looked like channel voice. This branch passes the packet type as an additive second argument (`this.emit("voice", data, packetType)`, the **only** change outside `packages/discord-bridge`, in `packages/backend/src/voice/tslib/client.ts`); existing listeners are unaffected, and the lab forwards only type 0 and counts everything else, including a missing type. D2 must review that one-line backend change. `sendVoice` is hard-coded to codec 5 (Opus Music). Identity generation at connect showed a CPU spike (peak 98.7 % of one core in a 0.5 s sample); the worker should persist its identity.
5. **Opus passthrough of mono voice is unverified.** Individual slots forward TeamSpeak Opus untouched to Discord. Whether Discord clients play a codec-4 mono stream correctly is untested.
6. **Peer-dependency warning.** `prism-media@1.3.5` declares `opusscript@^0.0.8`; the lab pins `0.1.1` (same as the backend). `opusscript` is only the fallback. Native Opus is the default.
7. **Native addons need a toolchain.** `@discordjs/opus` compiles in `node:24-bookworm` (full image). The lab's runtime stage is separate from its build stage but is still the full image; a slim runtime stage for D2 must keep the built addon and its glibc.

## Review remediation

The independent review of `4548dc0` returned D1 NO-GO. The brief did not number the findings; they are numbered here in the brief's order so the PR, the commits and the evidence can refer to them.

| # | Finding | Fix | Regression tests |
|---|---|---|---|
| P0-1 | Bots in one guild share `@discordjs/voice`'s default group, so the second bot got the first bot's connection | Group `ts6-bridge:<session>:<bot>` per bot; each bot uses only its own client's adapter; a guard throws if the group is occupied | `discord-bot.isolation.test.ts` (5) |
| P0-2 | DAVE not enforced at every boundary; the library sends and accepts plaintext at protocol 0 or when MLS is not ready | Established DAVE required at outbound prepare and dispatch, inbound decrypt, decode and queue; passthrough off; loss flushes and invalidates reception; grace window; a bot without DAVE is not electable | `discord-bot.dave.test.ts` (11), `runtime.test.ts`, `receive.test.ts` |
| P0-3 | Humans already speaking were missed (no speaking-start), and a decrypt failure left subscriptions dead | Supervisor reconciles against known speakers at start and on a 40 ms sweep; restores subscriptions after a failure; fails closed with bounded recovery | `discord-bot.receive.test.ts` (6) |
| P0-4 | `rejoin()` on a Ready connection is not a fresh MLS/DAVE handshake; stale callbacks after replacement | Recovery discards the connection and builds a new one, verified fresh (new session object), bounded; callbacks from a replaced receiver are rejected | `discord-bot.recovery.test.ts` (8) |
| P0-5 | Receiver failover waited behind unrelated reconnects | Successor elected synchronously on failure and activated outside the sync queue; reconnects are per-bot, in flight once, with bounded backoff; the `receiveGeneration` fence is preserved | `runtime.lifecycle.test.ts`, `runtime.race.test.ts` (12 seeded interleavings, independent oracle) |
| P0-6 | No stopping/stopped lifecycle; intentional destruction triggered fresh joins | `created → running → stopping → stopped`; stop is idempotent, aborts pending joins, removes listeners, cancels queued work, disposes decoders; `leave()` and `destroy()` do not report unhealthy | `runtime.lifecycle.test.ts`, `discord-bot.recovery.test.ts` |
| P0-7 | A malformed Opus packet threw out of the network callback | Contained at the callback boundary (voice, human Opus, 20 ms ticker): the packet is dropped, the decoder reset, the error counted | `audio-robustness.test.ts`, `runtime.lifecycle.test.ts` |
| P0-8 | Whisper vs voice not distinguished | Packet type passed through the TS transport; only channel voice is forwarded; missing type fails closed (see finding 4) | `ts-session.test.ts` (2, through the real `Ts3Client` packet path) |
| P1-1 | Lab image downloaded pnpm at runtime and could not run offline | Two-stage build; runtime runs the preinstalled `tsx`, read-only root, no registry, no package manager | `scripts/container-runtime-test.sh` |
| P1-2 | Longer Opus frames were truncated and short frames silently mishandled | RFC 6716 packet splitter, whole 20 ms PCM frames with per-speaker tails, zero-padded only when the speaker ends; `mixFrames` refuses any other size | `audio-robustness.test.ts` |
| P1-3 | Discord decoders were never released | Released on leave, stream close, receiver teardown and by an idle sweep; Discord→TS path capped at 256 decoders (LRU) | `audio-robustness.test.ts`, `pnpm run churn` |
| P2-1 | Grouped TeamSpeak move: later entries lost the shared destination channel | Entries without a `ctid` inherit the first entry's | `core.test.ts` |

### How the regression evidence was produced, and what it does and does not show

Each reproducer was run in its own process against the reviewed baseline and against the fixed code (`evidence/curated/remediation-red-green-2026-10-24.json`). The whisper (P0-8) and grouped-move (P2-1) tests ran against `4548dc0` itself. The rest ran against `57c1902`, the baseline plus those two fixes plus an injectable voice target and timing seam in `DiscordBot`, because the real-library harness cannot build a bot without it. Three shims were added to that throwaway baseline copy to let tests run at all: a read-only `voiceConnection` accessor, a queue-draining `idle()`, and an identity Opus splitter standing in for the baseline's "forward every packet as one 20 ms frame". None changes behaviour.

Results on the baseline, 122 test results: **52 behavioural reds** (the defect itself: plaintext on the wire, no frames from an already-speaking human, a second bot handed the first bot's connection, 2 001 live decoders after 2 000 users, a hung reconnect blocking the successor, and so on), **19 reds that fail only because the fix introduces the API the test calls** (for example `election.daveLost`; these show the change, not the defect), and **51 tests that already pass on the baseline** and act as guards. The 12 seeded race tests are in the second group on the baseline: their value is that they caught three deliberate mutations of the fixed code (DAVE ignored at admission, generation fence removed, successor never activated); a fourth (teardown not flushing the mixer) was not caught, because the mix-time generation fence already covers it.

On the fixed code: typecheck clean and 128 of 128 tests pass, repeatedly. The fixes are in the PR as separate `chore(discord-bridge)` commits.

## Re-review remediation

The second independent review (of `d890b5d`) numbered its findings F1 to F12. Priority 1 are the lifecycle defects, priority 2 the audio and isolation ones.

| # | Finding | Fix | Regression tests |
|---|---|---|---|
| F1 | A voice connection destroyed by the gateway was reused, so the bot never reconnected | A destroyed or failed connection is discarded and a new one is built with a new DAVE session, in the same per-bot group; `rejoin()` returning false counts as failure | `discord-bot.lifecycle.test.ts` (11) |
| F2 | A join waiting on target resolution survived `stop()` and completed afterwards | An intent epoch bumped only by `leave()` and `destroy()`; checked after every `await` of a join; a cancelled join destroys what it created; the runtime also leaves a late join for ports that cannot be fenced | `discord-bot.lifecycle.test.ts`, `runtime.recovery.test.ts` (seeded interleavings, a stubborn port) |
| F3 | A fresh DAVE recovery held the receiver role while its replacement connection was built | The runtime is the only automatic reconnector. On a poisoned DAVE session the adapter fences reception and reports at once; the successor is elected in the same turn and the rebuild runs in the background; a repaired bot returns as a sender, never as the receiver | `runtime.recovery.test.ts` (asserts the election at the moment of the report) |
| F4 | Recovery bypassed the recovery budget | One sliding-window budget (`maxRecoveries` per `recoveryWindowMs`) for every failure-driven rebuild: receive errors, gateway destruction, DAVE loss, direct joins and runtime retries. An attempt counts whether or not it reaches Ready; success refunds nothing; only time frees it; planned joins and leaves are free. Exhaustion is a typed error (`REBUILD_BUDGET_EXHAUSTED`, `retryInMs`) and the runtime wakes once when it expires | `rebuild-budget.test.ts` (4), `discord-bot.lifecycle.test.ts`, `runtime.recovery.test.ts` |
| F5 | DAVE was not re-checked at the final Discord dispatch or the final TeamSpeak mix | `dispatchAudio` is wrapped and refuses a packet prepared under a different or lost DAVE session; the mixer's admission reads live DAVE at push and at every mix (`daveDropped` counter) | `discord-bot.dave.test.ts`, `runtime.dave.test.ts` (3) |
| F6 | Other bot accounts were subscribed to and forwarded | `HumanFilter`: admit only users known to be human (cache, else bounded background lookup with a retry cooldown); bridge ids and self excluded; unknown stays excluded | `human-filter.test.ts` (6), `discord-bot.receive.test.ts` (4) |
| F7 | Playback retained about 20 frames (400 ms) of stale audio | `FrameFeed` stream buffer is one object and one budget of 4 covers it and the private queue; oldest dropped first | `receive.test.ts` (2), `discord-bot.lifecycle.test.ts` (real `AudioPlayer` on the wire) |
| F8 | A valid 4 x 10 ms Opus packet was dropped | Sub-20 ms constituents that fill 20 ms (2 x 10, 4 x 5, 8 x 2.5) are regrouped byte for byte without re-encoding; what cannot be carried stays unsupported and counted (see limits) | `audio-robustness.test.ts` (5, including a 300-packet seeded property run and native decode) |
| F9 | An excluded MusicBot took slot-0 and pushed a human to overflow | One exclusion predicate (query client or excluded unique id) for initial population and every directory event; `refreshExclusions()` re-applies a changed list | `runtime.exclusion.test.ts` (4) |
| F10 | `dispose()` left queued audio and could recreate codecs | Terminal on both pipelines: mixers flushed, codecs released and nulled, further audio refused (`disposed` drop); a disposed codec throws | `cleanup.test.ts` (4) |
| F11 | Routing telemetry kept an entry per identity that ever spoke (40 000 in the probe) | `forget()` removes the identity; `status().t2d.routedIdentities` and `decoders` make the bound observable | `cleanup.test.ts` (2), `runtime.exclusion.test.ts` (2 000-person churn), `pnpm run churn` |
| F12 | `--test-force-exit` could report a truncated run as success | `scripts/run-tests.mjs`: no forced exit, per-test timeout, a machine-readable report, fails on failed, skipped, cancelled or timed-out tests, files that reported nothing, and count mismatches. The truncation was reproduced with the TAP reporter piped: `core.test.ts` (30 tests) reported 19, 24 or 27 on several of 12 runs, always with exit code 0. The image build gate uses the same runner | `test-verify.test.mjs` (4) and end-to-end negative runs (a corrupted count, a skipped test) |

### Re-review evidence

The reviewer's probes (read first, local only, no network) were run unmodified against `d890b5d` and against the fixed code (`evidence/curated/remediation2-red-green-2026-10-25.json`). On `d890b5d` all twelve reproduce. On the fixed code the symptom is gone for nine of them (same probe, behavioural). Two cannot run as written: F3's probe calls `DiscordBot.recover()`, which no longer exists, so it is covered by the `runtime.recovery.test.ts` test instead (mutation-checked, but not runnable against `d890b5d`); and F4's probe assumes a subscription on the first packet, which F6 deliberately changes, so a shim that keeps the speaker talking until subscribed was used: `d890b5d` built 5 connections with `maxRecoveries=1`, the fixed code builds 2 (the first plus one rebuild) and stays out of service. F12 is not probe based.

Tests were also mutation-checked: each fix was disabled in turn and a test failed (the exceptions are two redundant defences that duplicate another, which a test of the combined removal does catch). Two tests I wrote first were vacuous, and mutation or an added assertion found them: a failover test that passed even if the handler did nothing, and a churn test that never routed a speaker.

On the fixed code: typecheck clean and **187 of 187 tests in 21 files** pass in the verified runner (every discovered file reported, none skipped), the native smoke passes, the churn lab passes 3 of 3, the lab image builds clean (its build gate runs typecheck, the verified suite and the smoke), `container-runtime-test.sh` passes 9 of 9 offline, read-only and unprivileged, and the TS6 beta13 laboratory passes 5 of 5 with synthetic speakers. All of that is simulated, native or TS6-synthetic, **not live Discord**.

## Third review remediation

The third independent review (of `0256a3b`) confirmed F1, F2, F3 and F5 to F11 and found F4 and F12 only partly fixed, plus two new findings. They are numbered R1 to R4 in the reviewer's order.

| # | Finding | Fix | Regression tests |
|---|---|---|---|
| R1 (P1) | A failure-driven rebuild could bypass the recovery budget: a rejoin the gateway refuses (the library emits Disconnected from inside `rejoin()` and then returns false) and a connection destroyed while the join waited for its target both rebuilt without a charge. At `maxRecoveries=1`: six connections, zero tokens charged, bot healthy | The cause was one mutable flag doing two jobs, "a rebuild is owed" and "this attempt already paid". The debt (`rebuildOwed`) is now only set by failures and cleared only by a join that reaches Ready. Each attempt pays at most one token, through a local `charge()` at the first moment it rejoins or builds a connection, after the last await, reading the debt then. A construction failure is a failure: the half-built connection is destroyed and the debt recorded. A failure that arrives while a join waits for Ready or DAVE fails that join. `assertAvailable()` keeps the early refusal before a wasted lookup | `discord-bot.budget.test.ts` (8, real `VoiceConnection` and real `rejoin()`), `runtime.recovery.test.ts` (one wake-up per bot, one attempt when the window slides) |
| R2 (P2) | The test verifier checked counts but not the reported files: an out-of-tree file that registered passing tests was accepted and the runner exited 0 | The files expected, discovered and reported must be one set (`UNEXPECTED FILE`), and the reported test names must be exactly the expected names (`NOT REPORTED`, `UNEXPECTED TEST`), because replacing one test by another leaves the count unchanged. `expected-tests.json` lists names. The reporter gets the package root from the runner instead of looking for a directory name | `test-verify.test.mjs` (8), `run-tests.fixture.test.mjs` (5, the real command in throwaway packages: exit status and messages) |
| R3 (P2) | `HumanFilter` bounded what it remembered but not the lookups it had pending: 100 distinct speakers with a lookup that never settles left 100 pending | At most `maxPending` (8) lookups are unsettled at once; the rest are refused, not queued, and stay excluded. A lookup past its timeout puts the user on a cooldown that doubles per failure up to a cap, but keeps its slot until it really settles. `forget` (a human left our channel) and `reset` (`leave()`) cancel lookups, so a late answer cannot re-admit anyone; `destroy()` disposes. `stats()` and `DiscordBot.identityLookups` expose pending, stalled, refused, timed out and failed counts | `human-filter.test.ts` (16), `discord-bot.receive.test.ts` (+2) |
| R4 (P2) | The ticker exception test threw during input decoding, before the ticker; with the ticker's catch removed it still passed | Three tests inject a one-shot failure into `d2t.tick`, `t2d.tickOverflow` and a TeamSpeak `sendVoice` that throws inside the tick, with valid audio flowing: the callback error counter rises by exactly one, the runtime stays `running`, later audio still reaches TeamSpeak or the overflow bot. The production boundary is unchanged | `runtime.lifecycle.test.ts` (3, replacing one) |
| Sonar | `javascript:S2871` (a bare `.sort()`) on `run-tests.mjs` drove the new-code reliability rating to D | A true positive. Replaced by an explicit UTF-16 code-unit comparator, which orders strings exactly as the default did and does not depend on the locale. The next analysis flagged one new finding in the new filter (`typescript:S4822`, a `try/catch` around a promise); the lookup is now started inside a promise executor, which turns a synchronous throw into a rejection. The gate is then OK (reliability rating A) | `run-tests.fixture.test.mjs`, `human-filter.test.ts` |

### Third review evidence

Reproductions (`evidence/curated/remediation3-red-green-2026-10-25.json`) were run in a clean extract of `0256a3b`, with only the test harness replaced:

| | Before (`0256a3b`) | After |
|---|---|---|
| R1 A, refused rejoin, `maxRecoveries=1` | second failure rebuilt again: 3 connections | second failure refused (`REBUILD_BUDGET_EXHAUSTED`): 2 connections, 1 token |
| R1 B, destroyed during the lookup, 5 rounds | 6 connections, 0 tokens charged, bot healthy | 2 connections, 1 token, 4 refusals |
| R1 C, construction throws, 6 attempts | 6 attempts, 0 tokens | 2 attempts, 1 token, 4 refusals |
| R2, out-of-tree file registers a passing test | `verified: 2 tests in 2 files`, exit 0 | `UNEXPECTED FILE extra/sneaky.mjs`, exit 1 |
| R3, 100 distinct speakers, lookup never settles | 100 started, 100 pending | 8 started, 8 pending, 92 refused, 0 admitted |
| R4, ticker's catch removed | old test passes | 3 new tests fail |

Test identities (R2): in three full runs the 196 existing test titles were identical as sets, none repeated within a file, and the five that contain digit runs are literal text. Titles are therefore a stable identity. A title that embeds a time, an id or a random value must not be written, because it would fail the next run.

Mutation checks: removing the `maxPending` cap fails 3 tests; applying late identity answers regardless of cancellation fails 3; removing the bot's `forget` and `reset` calls fails the bot-level test; removing the ticker's catch fails all 3 R4 tests; disabling the in-join failure check fails its test.

On the fixed code: typecheck clean, **219 of 219 tests in 23 files** in the verified runner on three consecutive runs (node:test also reports 219 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo), native smoke 4 of 4, churn 3 of 3, clean (`--no-cache`) image build whose gate re-ran the verified 219, `container-runtime-test.sh` 9 of 9 offline, read-only and unprivileged, the TS6 beta13 laboratory 5 of 5 with synthetic speakers, and the backend tslib tests 28 of 28 (the one file that needs the workspace package `@ts6/common` was run from a scratch copy with it built). All simulated, native or TS6-synthetic, **not live Discord**.

## Known limitations

- No live Discord run: no bot tokens, test guild or participants were available. No live DAVE, join-order, transition, recovery or failover result exists.
- No real TeamSpeak human speakers. TS-side live evidence uses synthetic speakers on a real TS6 server.
- `DiscordBot` is now exercised against the real `@discordjs/voice` classes with the network edge faked, and `lab:live` is typechecked only. That is simulation. The first live run may still find defects in either.
- **Slot passthrough drops TeamSpeak Opus it cannot carry.** A single 40 ms or 60 ms frame (indivisible), a lone sub-20 ms frame, or a packet whose sub-20 ms frames do not fill whole 20 ms packets (for example three 10 ms frames) cannot be sent on a Discord slot without re-encoding. They are dropped and counted (`unsupportedFrames`), not forwarded as if they were 20 ms and not transcoded. Multi-frame packets that fill 20 ms multiples, including 2 x 10, 4 x 5 and 8 x 2.5 ms constituents, are regrouped without re-encoding. If real TeamSpeak clients send such frames this will show up as a counter, and D2 must decide whether to transcode.
- The overflow path decodes then re-encodes, so it is not affected by the unsupported-frame limit.
- **Fail-closed identity costs the start of a new speaker.** A Discord user the bridge has never seen is excluded until a background user lookup answers, so the first moments of that user's first utterance (about one lookup round trip, or longer if the lookup keeps failing) are not forwarded. Once known they are admitted at once. This is deliberate: the bot-exclusion policy is not relaxed to hide it. The lookups are bounded (at most 8 unsettled REST requests per bot, counted until each request itself settles, and at most one per user); while all 8 are out, a further unknown speaker is not looked up until a slot frees and they are next heard, and a lookup that fails or times out is retried only after a doubling cooldown (5 s up to 60 s). The filter's 6 s timeout only puts the user on that cooldown: it does not free the slot, because the request is still out. **Stalled requests can exhaust the eight slots.** discord.js aborts each attempt after 15 s and retries it up to 3 times, and every user lookup waits in one rate-limit queue whose waits the bridge does not bound, so a request normally settles within minutes, but nothing guarantees it. Until it settles, or the operator restarts the test session, the bot admits no new unknown speakers (fail closed); humans it already knows are still forwarded, and `identityLookups.pending` and `.stalled` show the state. Whether the real lookup behaves as the simulation does is NOT-RUN.
- **SonarQube.** The PR #504 quality gate was ERROR (new-code reliability rating D) because of `javascript:S2871`; after the fixes it is OK with a new-code reliability rating of A (checked against SonarCloud for the head `523cb68`). Fifteen older low and medium severity findings of the style class remain open in code this remediation did not touch (S7503 async functions without `await` in the test fakes and `runtime.sync`, S7773 `parseInt` in `client-directory.ts`, S7758 `charCodeAt` in `nickname.ts`, S7688 `[` against `[[` in `container-runtime-test.sh`). They do not affect the rating and were left alone on purpose.
- **A tick that fails on every 20 ms stops its own direction only.** The ticker has one exception boundary per direction, so a persistent failure in the TeamSpeak to Discord overflow tick no longer stops the Discord to TeamSpeak mix, or the reverse. The failing direction stays broken until whatever throws stops throwing; nothing restarts it. Failures are counted per direction (`status().tickErrors`) and in `callbackErrors`, and logged as name and message only: the first five at each site, then once per power of two (about 22 lines for a million failures).
- **The rebuild budget is a safety stop, not a repair.** A bot that exhausts it stays out of service until the window slides; if all six fail together the bridge is down until then. The limits (`maxRecoveries`, `recoveryWindowMs`) are lab defaults chosen without live data.
- The exclusion list is an option of the runtime; the lab does not read it from configuration, and `refreshExclusions()` is only exercised by tests.
- No consoles (Xbox/PlayStation) tested.
- No lab CI workflow was added; the checks above run locally and inside the lab image build. D2 decides CI.
- Echo for people present in both rooms is out of scope (as in the contract).

## GO/NO-GO

- **D1 gate (contract): NO-GO / not met.** Required live rows are NOT-RUN, so D3/D4 must not start on the strength of this PR.
- **After the third remediation:** the defects the three reviews found are fixed and covered by simulated, native-addon and TS6-laboratory evidence. **Code readiness: GO for a fourth independent review. Not ready for live Discord testing until that review passes.** D2 to D6 have not started. **D1 acceptance: NO-GO** (the live Discord rows are NOT-RUN).
- **Feasibility signals so far: GO to continue.** The pinned stack installs and its native Opus and DAVE addons run on Node 24; TeamSpeak-side parsing, per-speaker routing, overflow mixing and the shared-client send path work against a real TS6 server; the receiver election and generation fence behave as specified in simulation.
- **Next action (owner):** provide the live prerequisites above, or authorise a different test setup, then run `lab:live` and fill the NOT-RUN rows. If join order B shows #11653, stop and decide: wait for upstream, carry a documented patch, or change library.
