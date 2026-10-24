# Discord voice bridge: Bridge-D1 lab

**Status: draft feasibility lab. Not for merge. Not shipped. Disabled by default (it is not wired into any compose file, image, backend route or release workflow).**

This package is the isolated Node 24 proof of concept for the Discord ↔ TeamSpeak voice bridge defined by the accepted Bridge-K contract ([`docs/internal/discord-voice-bridge.md`](../../docs/internal/discord-voice-bridge.md)). D1 is a feasibility proof of the 5+1 design. It is not a reduced single-bot product.

**D1 result: the live Discord proof has not been run, so the D1 gate is not met.** See [Evidence](#evidence) and [GO/NO-GO](#gono-go).

## What is in the lab

| Path | Purpose |
|---|---|
| `src/core/` | Pure routing logic: TS S2C packet parser, `SlotRouter` (uniqueId → one destination), `ReceiverElection` (`receiveGeneration` fence), `FrameMixer` (bounded, peak-limited, admission re-checked at mix time), both pipelines, nickname rules, DAVE gate, receive supervisor, token redaction |
| `src/bridge/runtime.ts` | `BridgeRuntime`: one shared TeamSpeak client + six Discord identities (5 slots + overflow), idle-overflow rules, teardown-before-election |
| `src/adapters/` | `TsSession` (existing TS3 UDP client) and `DiscordBot` (discord.js + `@discordjs/voice`, DAVE enforced) |
| `src/lab/` | `smoke-deps` (native Opus/DAVE), `ts-live` (real TS6 server), `live` (real Discord, operator-driven), library repro test |
| `lab/Dockerfile` | Node 24 image pinned by digest; typecheck + tests + native smoke are build gates |
| `scripts/sync-tslib.mjs` | Copies `packages/backend/src/voice/tslib` into git-ignored `.vendor/` (the backend copy stays the source of truth; `--check` detects drift) |

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
pnpm test                   # 50 unit tests, no network, no credentials
pnpm run smoke:deps         # native Opus + DAVE + opusscript on the running Node
```

Node 24 container (the actual target image; build context is the repo root):

```bash
docker build -f packages/discord-bridge/lab/Dockerfile -t ts6-discord-bridge-lab:d1 .
docker run --rm ts6-discord-bridge-lab:d1          # re-runs the native smoke
```

TeamSpeak-side live lab (a real TS6 6.0.0-beta13 server, synthetic speakers, simulated Discord sinks). The server is only on an internal Docker network:

```bash
docker network create --internal d1-lab
docker run -d --name ts6-d1-lab --network d1-lab --memory 512m \
  -e TSSERVER_LICENSE_ACCEPTED=accept teamspeaksystems/teamspeak6-server:6.0.0-beta13
sleep 9
docker run --rm --network d1-lab --cpus 1 --memory 512m -e TS_LAB_HOST=ts6-d1-lab \
  ts6-discord-bridge-lab:d1 sh -c './node_modules/.bin/tsx src/lab/ts-live.ts'
docker rm -f ts6-d1-lab && docker network rm d1-lab
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
| Receiver failover during active Discord speech | SIMULATED PASS | SIMULATED | One successor, strictly increasing generation, stale and zombie frames fenced at mix time, TeamSpeak gets one frame per tick. **Live: NOT-RUN.** |
| No duplicate audio / no feedback | PARTIAL | LIVE-TS6+SYNTH / SIMULATED | Each uniqueId appears under one bot only; bridge-bot Discord ids are never subscribed or forwarded (unit tested). **Live acoustic/loop check: NOT-RUN.** |
| CPU / RSS / one-way speak-to-hear | **PARTIAL** | LIVE-TS6+SYNTH | See below. **Speak-to-hear through Discord: NOT-RUN.** |

### Discord receive cases

| Check | Result | Provenance | Notes |
|---|---|---|---|
| Join order A: receive bot first, human speaks | NOT-RUN | | needs Discord |
| Join order B: human first, then receive bot joins (#11653) | NOT-RUN | | The #11653 mechanism **is reproduced** in the pinned `0.19.2` code (below). Whether Discord actually triggers it is unproven. |
| DAVE transition: welcome, later transition, reconnect | NOT-RUN | | |
| Recovery after a decrypt error | SIMULATED PASS | SIMULATED | `ReceiveSupervisor` counts stream errors and requests a voice rejoin after 3 in 10 s; the library failure mode is reproduced. **Live: NOT-RUN.** |
| Mixer fence: stale `receiveGeneration` frames never enter the TS mix | PASS | SIMULATED | Checked on push and again on every mix tick. |
| Node 24 image: native Opus loads | PASS | NATIVE | `@discordjs/opus 0.10.0`, round trip keeps a 1 kHz tone |
| Node 24 image: native DAVE loads | PASS | NATIVE | `@snazzah/davey 0.1.12`, creates an MLS key package |
| `opusscript` fallback smoke | PASS | NATIVE | `opusscript 0.1.1` |

Raw files: `evidence/curated/` (`ts-live-container-2026-10-24.json`, `smoke-deps-container-2026-10-24.json`). Both ran in `ts6-discord-bridge-lab:d1` on Node v24.22.1.

### Measurements (TeamSpeak side only)

Container `--cpus 1 --memory 512m`, one process holding the bridge, 10 TS clients and 8 Opus encoders, so this is an upper bound for the bridge alone:

| Metric | Value |
|---|---|
| CPU, process average | 4.2 % of one core (peak 98.7 % during TS identity generation at connect, not steady state) |
| RSS, process | avg 100.7 MB, max 111.9 MB (container peak sampled by `docker stats`: 86.7 MiB) |
| TS speaker send → bridge receive (same host, via TS6) | p50 1.1 ms, p95 1.9 ms, max 6.1 ms, n=150 |
| Overflow mix tick latency | recorded in the evidence file |

Not measured: Discord send/receive latency, DAVE encrypt/decrypt cost, and true speak-to-hear, which needs real participants. No figure here may be used as a speak-to-hear number.

## Findings

1. **#11653 mechanism confirmed in `@discordjs/voice@0.19.2`.** After an MLS welcome at transition 0, `lastTransitionId` is `0`; on persistent decrypt failure `decrypt()` takes `if (this.lastTransitionId) recover… else throw error` and a falsy `0` throws. The receiver then calls `stream.destroy(error)`. `src/lab/dave-library.test.ts` reproduces both branches against the real library class with a stand-in for the native session. The lab's `ReceiveSupervisor` re-opens on the next speaking event and requests a voice rejoin (fresh DAVE handshake) after repeated errors. Whether Discord actually produces this state, and whether a rejoin clears it, is **unproven** until the live run.
2. **The library does not enforce DAVE.** At protocol version 0 it passes media through unencrypted in both directions. The lab therefore checks the live session (`protocolVersion ≥ 1` and `session.ready`) before sending any frame and before the bot counts as healthy, and leaves the channel otherwise (fail closed).
3. **TS6 flood guard.** A single source IP that joins more than about 5 clients within roughly 25 s is banned (`error 3329`, "you are banned"). 12 s spacing works. This is a test-harness constraint; the production bridge uses one TS client. D6 test plans should account for it.
4. **Existing TS3 client limits for D2.** The `voice` event delivers Voice and VoiceWhisper alike, so the contract's "channel voice only" whisper rule cannot be enforced without a small change to `packages/backend/src/voice/tslib`. `sendVoice` is hard-coded to codec 5 (Opus Music). Identity generation at connect showed a CPU spike (peak 98.7 % of one core in a 0.5 s sample); the worker should persist its identity.
5. **Opus passthrough of mono voice is unverified.** Individual slots forward TeamSpeak Opus untouched to Discord. Whether Discord clients play a codec-4 mono stream correctly is untested.
6. **Peer-dependency warning.** `prism-media@1.3.5` declares `opusscript@^0.0.8`; the lab pins `0.1.1` (same as the backend). `opusscript` is only the fallback. Native Opus is the default.
7. **Native addons need a toolchain.** `@discordjs/opus` compiles in `node:24-bookworm` (full image). A slim runtime stage for D2 must keep the built addon and its glibc.

## Known limitations

- No live Discord run: no bot tokens, test guild or participants were available. No live DAVE, join-order, transition, recovery or failover result exists.
- No real TeamSpeak human speakers. TS-side live evidence uses synthetic speakers on a real TS6 server.
- `DiscordBot` and `lab:live` are typechecked and exercised only through their pure parts and fakes. The first live run may find defects in them.
- No consoles (Xbox/PlayStation) tested.
- No lab CI workflow was added; the checks above run locally and inside the lab image build. D2 decides CI.
- Echo for people present in both rooms is out of scope (as in the contract).

## GO/NO-GO

- **D1 gate (contract): NO-GO / not met.** Required live rows are NOT-RUN, so D3/D4 must not start on the strength of this PR.
- **Feasibility signals so far: GO to continue.** The pinned stack installs and its native Opus and DAVE addons run on Node 24; TeamSpeak-side parsing, per-speaker routing, overflow mixing and the shared-client send path work against a real TS6 server; the receiver election and generation fence behave as specified in simulation.
- **Next action (owner):** provide the live prerequisites above, or authorise a different test setup, then run `lab:live` and fill the NOT-RUN rows. If join order B shows #11653, stop and decide: wait for upstream, carry a documented patch, or change library.
