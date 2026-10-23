# Discord voice bridge — compatibility and trust contract

Target: **v1.12.0**. Default: **disabled**. Status: **proposed; draft PR for owner review, not accepted**.

This is the Bridge-K contract. The draft PR is for review, not approval. Do not start Bridge-D1, merge, or publish until the owner explicitly accepts it. Do not shrink 5+1 to a single-bot product. Do not move incomplete work into another release. Escalate blockers.

Listener remote ([#442](https://github.com/uniskela/ts6-manager/issues/442)) stays in v1.12.0. v1.11.2 ([#460](https://github.com/uniskela/ts6-manager/pull/460)) stays on its current process.

Companion spec: [superpowers/specs/2026-10-23-discord-voice-bridge-design.md](superpowers/specs/2026-10-23-discord-voice-bridge-design.md).

## Product

- Two-way audio between one administrator-approved Discord voice channel and one administrator-approved TeamSpeak channel.
- TeamSpeak → Discord: up to five official bots named `[TS] Username`, plus one `[TS] Others` overflow bot.
- Discord → TeamSpeak: exactly one of the six bots is the active receiver and forwards human Discord audio to one shared TeamSpeak client. Overflow is preferred; failover elects another of the six.
- Native TS6 Manager admin page for enablement, mapping, pool size (default five), overflow, status, participants, gain, mute, start/stop/restart, and redacted diagnostics.
- Isolated worker image (Node 24) in official compose behind profile `discord-bridge`. Default `docker compose up` does not start it. `DISCORD_BRIDGE_URL` is unset unless that profile is on.
- Official Discord applications only. Six bot tokens per mapped session. The receiver is elected from those six. No self-bots.
- No microphone recording and no retained audio by default.
- Participants must be told that audio crosses Discord and TeamSpeak (admin UI notice; operators should also say so in the mapped channels).

## Compatibility

| Side | Contract |
|---|---|
| TeamSpeak server | Baseline **6.0.0-beta13** (`teamspeaksystems/teamspeak6-server:6.0.0-beta13`). TS3 servers are in-scope for the same TS3 UDP client if one is available during D1. |
| TeamSpeak voice | Existing TS3 UDP client (EAX). Incoming S2C voice is `VId u16 + speaker CId u16 + codec u8 + Opus` per ReSpeak `ts3protocol`. Live TS6 layout is **unverified** until D1. |
| TeamSpeak video/WebRTC | Out of path. Do not use the media sidecar. |
| Discord | Official bot API. Voice is pinned below. Discord required DAVE for voice from 1 March 2026. |
| Discord receive | Receive is not documented by Discord. The candidate pin implements DAVE decrypt. **Untested reception is not proven.** D1 must run the join-order, transition, and recovery cases below. |
| Node | Worker image is **Node 24**. Candidate `@discordjs/voice@0.19.2` documents `engines.node >= 22.12.0`. Do not run the worker on the Node 20 backend image. Backend and frontend stay on Node 20 / pnpm 9. |
| Consoles | Xbox and PlayStation are the claimed console targets. D6 must name which were actually tested. Any claimed console that was not tested is **unverified**. |

Compatibility CI today does not certify voice playback. D1 and D6 are real-server proofs, not a substitute for that workflow.

## Audio routing

1. Parse each TeamSpeak voice packet to a speaker `CId`, then to `uniqueId`. Do not key slots on display name.
2. Simultaneous TeamSpeak speakers are decoded and routed independently. A uniqueId on an individual slot is sent only to that slot’s Discord bot.
3. UniqueIds over the pool limit are mixed only onto `[TS] Others`.
4. A uniqueId is never audible on both a slot bot and overflow at the same time.
5. Music bots and system clients are excluded by default (`client_type`, known `MusicBot` uniqueIds).
6. Whisper and talk-power: only channel voice the shared TeamSpeak client is allowed to hear.
7. Exactly one of the six bots is the **active receiver**. It subscribes only to human Discord users. It never subscribes to slot bots, overflow, or itself. See [Receiver election](#receiver-election).
8. The shared TeamSpeak client does not receive its own voice.
9. Discord → TeamSpeak is one mix into that shared client. It must not appear again on any Discord slot or overflow bot.

People who sit in both rooms will hear themselves. That is documented, not linked, in v1.12.0.

## Trust boundary

- Discord DAVE and TeamSpeak EAX terminate in the worker.
- PCM exists only in worker memory. No audio files, no capture API, no retention.
- Frontend never sees bot tokens, TeamSpeak identity material, or `DISCORD_BRIDGE_SECRET`.
- Backend decrypts stored tokens only to push a start payload to the worker.
- Worker mutating API requires a bearer secret, same class as `SIDECAR_SECRET`.
- Production is fatal if `DISCORD_BRIDGE_URL` is set without `DISCORD_BRIDGE_SECRET`.
- Worker control stays on the internal Docker network or loopback. Do not publish the worker port.
- Two TeamSpeak server mappings never share tokens, PCM, Opus decoders, Discord voice connections, or slot tables. A packet or start payload without a session id is dropped.
- PCM is not written to disk, not sent to the browser, and not kept after the speaker’s stream ends (end-of-voice or leave). No capture API.

## Credentials

- Tokens are stored `enc:iv:tag:ciphertext` with the existing AES-256-GCM helper.
- GET responses never include token plaintext or ciphertext.
- Empty token fields on update mean “keep stored value”.
- Logs redact tokens, secrets, and identity private keys. A log line that cannot be redacted is not logged.
- Revocation and rotation are D6 cases: old token stops working; new token is accepted; logs still redacted.

## Fail closed

Do not join Discord or TeamSpeak when any of these are true:

- integration disabled or mapping missing
- fewer than six bot tokens when the default 5+1 pool is enabled (the receiver is elected from those six)
- Discord guild, voice channel, or bot membership cannot be verified
- TeamSpeak server or channel cannot be verified
- worker secret missing or wrong

A running session that loses membership or authorisation disconnects and does not reconnect until the check passes.

## Receiver election

The receiver is one of the six bots. If that bot’s Discord connection dies, Discord → TeamSpeak stops unless another healthy bot takes over. Slot send can continue on the bots that are still up.

Keep six applications. Do not add a seventh.

**Preferred order** (first healthy wins): overflow (`[TS] Others`), then slot 0 … slot 4. An admin may pin a preferred bot; failover still walks this list and skips the dead one.

**Exactly one active receiver**

- A monotonic `receiveGeneration` is held by one bot id.
- Only that generation may subscribe to human Discord users.
- Every other bot is send-only: no human subscriptions, `selfDeaf` allowed.

**On receiver failure**

1. Increment `receiveGeneration`. The old bot must drop every human subscription immediately (teardown before election).
2. Elect the next healthy bot in the preferred order.
3. The new receiver connects (or reuses its existing voice connection), stays undeafened for receive, and subscribes to humans only.
4. The old bot, if it returns, is send-only until it wins a later election. It must not resubscribe.
5. If no bot is healthy, Discord → TeamSpeak fails closed. TeamSpeak → Discord continues on whatever slot/overflow connections remain.

**Duplicate-receiver prevention**

- Two bots must never both have human subscriptions.
- A subscribe attempt from a bot whose generation is stale is rejected and torn down.
- Health/status shows `receiver: <bot slot>` and the generation. D1 and D6 must catch two receivers.

A non-receiver slot failure does not move receive. A receiver failure always elects; it is not “the receive bot stayed up”.

## Echo and feedback

- Never subscribe to any bridge bot SSRC.
- Never send the Discord→TeamSpeak mix back into Discord.
- Never send a TeamSpeak uniqueId to more than one Discord destination.
- Dual-homed acoustic echo is out of scope.

## Candidate Discord voice dependencies

**Candidate pin: `@discordjs/voice@0.19.2`.** Reception is **not proven** in this repo until D1 fills the evidence table.

| Package | Candidate | Licence | Documented Node | Why this version |
|---|---|---|---|---|
| `discord.js` | **14.27.0** | Apache-2.0 | `>=18` | Current 14.x gateway client |
| `@discordjs/voice` | **0.19.2** | Apache-2.0 | **`>=22.12.0`** | See justification below |
| `@snazzah/davey` | **0.1.12** (0.19.2 depends on `^0.1.9`) | MIT | N-API addon on the Node 24 image | DAVE MLS / media crypto |
| `@discordjs/opus` | **0.10.0** (0.19.2 lists `^0.10.0`) | MIT | Node 24 native | Preferred Opus |
| `opusscript` | already in the backend | MIT | JS fallback | Used only if native Opus fails the image smoke |

### Why 0.19.2, not 0.19.0

- **0.19.0** (2025-08-17) added DAVE send/receive. It does not include later receive-path fixes.
- **0.19.1** always installs `@snazzah/davey` and handles multiple DAVE transitions at once.
- **0.19.2** (2026-03-13) strips RFC3550 RTP padding and rejects non-voice / non-RTP-v2 packets ([#11449](https://github.com/discordjs/discord.js/pull/11449)). That fixed 0.19.x reconnect loops and failed capture ([#11419](https://github.com/discordjs/discord.js/issues/11419)).
- **Open risk:** [discordjs/discord.js#11653](https://github.com/discordjs/discord.js/issues/11653) (2026-10-08, still open against **0.19.2**). After an MLS **welcome at transition 0**, decrypt can fail (`UnencryptedWhenPassthroughDisabled`) and never recover, because `lastTransitionId === 0` is falsy. Seen when a user is already in the channel and the bot joins. Not every join.

D1 must reproduce both join orders and the recovery path. If #11653 appears, stop and ask the owner (wait for upstream, carry a documented patch, or change library). Do not ship “receive works” on the strength of the pin.

Unreleased `main` docs have said Node 24.17+. That is not the pin. The worker image is still Node 24 so it stays off the Node 20 monorepo and above `>=22.12.0`.

A licence that is not Apache-2.0, MIT, or BSD-family, or a pin change, stops D2 for an owner decision. Do not add GPL voice stacks. Do not float unpinned `latest`.

## Bridge-D1 — live bidirectional proof

D3 and D4 do not start until all of the following are recorded here as evidence (pass/fail, date, clients used):

1. Live TeamSpeak 6 S2C packets parse to speaker `CId` and `uniqueId`.
2. **Two TeamSpeak users speaking at the same time** are routed to two official Discord bot identities, independently, with **no crosstalk**.
3. Discord → TeamSpeak works through the **active receiver** (elected from the six) into the shared TeamSpeak client (not a second copy of the TeamSpeak→Discord path).
4. No bridge-induced duplicate audio and no feedback in either direction.
5. Token-redacted logs, loopback health, and a CPU / RSS / speak-to-hear measurement.
6. Connection order, DAVE transitions, and decrypt recovery as in the receive table below.
7. Killing the active receiver elects exactly one successor; the old bot’s human subscriptions are gone before the new ones start.

D1 lab compose, if any, binds to `127.0.0.1` only and is not part of default `up`.

**Evidence (empty until D1 runs):**

| Check | Result | Notes |
|---|---|---|
| TS6 S2C speaker parse | | |
| Two simultaneous TS speakers → two Discord bots, independently, no crosstalk | | |
| Discord → TS via the elected receiver | | |
| Receiver failover: one successor, no overlapping subscriptions | | |
| No duplicate audio / no feedback | | |
| CPU / RSS / one-way speak-to-hear | | |

D1 must also record these Discord receive cases (still unproven until filled):

| Check | Result | Notes |
|---|---|---|
| Join order A: receive bot in channel first, then a human speaks | | |
| Join order B: human already in channel, then receive bot joins (#11653 welcome at transition 0) | | |
| DAVE transition: welcome, later transition, reconnect | | |
| Recovery after a decrypt error (session recovers, or fail closed and escalate) | | |
| Node 24 image: native Opus loads | | |
| Node 24 image: native DAVE (`@snazzah/davey`) loads | | |
| `opusscript` fallback smoke if native Opus fails | | |

If any row fails, stop. Owner decides. Do not open D3/D4. Do not ship mixed-only as v1.12.0. Do not describe untested reception as proven.

## Bridge-D3 — identity and slots

- Persistent `uniqueId → slot` mapping. Rename, disconnect, and reconnect do not allocate a new slot while the mapping is held.
- Discord nick is `[TS] ` plus the current TeamSpeak display name, truncated to Discord’s limit.
- Duplicate TeamSpeak names are allowed; uniqueId still decides the slot.
- Nickname updates honour Discord rate limits: wait `Retry-After`, drop intermediate names, never busy-loop.
- A **non-receiver** slot failure does not tear down the other slots, overflow, the active receiver, or the shared TeamSpeak client. That slot reconnects; its uniqueId is held or moved only by the reassignment rules, never duplicated.
- A **receiver** failure follows [Receiver election](#receiver-election). Discord → TeamSpeak moves to the next healthy bot after subscription teardown. The failed bot’s TeamSpeak slot send, if it had one, follows the same hold/reassign rules as any other slot.
- Slot reassignment is explicit: a uniqueId is removed from the old destination on a 20 ms frame boundary before it is added to the new one.
- Discord-side mute and speaking indicators are per slot.

## Bridge-D4 — overflow

- Eight TeamSpeak users produce five slot bots and one overflow bot carrying the other three.
- Simultaneous overflow speakers are mixed. Peak-limit or attenuate; do not clip from a naive sum.
- Individual ↔ overflow transitions occur at a 20 ms frame boundary: remove the uniqueId from the old destination, then add it to the new one. The bridge must not play that uniqueId on both destinations and must not insert a silence gap of its own between those two frames.
- This does **not** promise zero packet loss. Packets already dropped by Discord, TeamSpeak, or the network stay dropped. The duty is no **bridge-induced** duplication or gap.
- Empty slots are released, then the next waiting uniqueId is promoted.
- Music bots stay excluded.

## Bridge-D5 — administration and onboarding

Administrator-only. Viewer cannot change settings. Per-server access applies. Secrets never in GET bodies. In-page notice that audio crosses platforms.

Onboarding, in this order (the page and public docs must match):

1. **Six official Discord applications.** Create six bots. Intents: Guilds, Guild Voice States. Privileged message-content is not required.
2. **Invite and permissions.** Invite all six to the guild. Each needs View Channel, Connect, Speak, and Use Voice Activity on the approved voice channel. No administrator permission.
3. **Channel authorisation.** Admin selects one Discord guild + voice channel and one TeamSpeak server + channel. The worker verifies membership and those permissions before Start. Fail closed if any bot cannot see or join the channel.
4. **Docker profile.** Operator enables compose profile `discord-bridge`, sets `DISCORD_BRIDGE_URL` and `DISCORD_BRIDGE_SECRET`, and starts the worker. Default `up` does not do this. The UI must say so when the worker is unreachable.
5. **Credential validation.** Admin pastes six tokens (write-only). The worker logs in each bot, checks guild membership and channel permission, and reports pass/fail per slot **without** joining voice until Start. A failed token blocks enable.
6. **Disclosure.** The page states that audio crosses Discord and TeamSpeak. Operators should repeat that in the mapped channels.
7. **Start.** Enable the mapping, then Start. The worker elects a receiver and joins both platforms.

## Worker image and native addons

D1/D2 must ship a **reproducible** `Dockerfile.discord-bridge` from a pinned `node:24-bookworm` (or newer Node 24 patch) digest, not `latest`.

CI builds that image and runs a smoke in it:

- `@discordjs/opus` native addon loads
- `@snazzah/davey` native addon loads
- `@discordjs/voice` `generateDependencyReport()` shows DAVE + Opus
- If native Opus fails, run the same smoke on `opusscript` and record pass/fail. Native Opus remains preferred.
- If DAVE native fails, **fail closed**. There is no DAVE-less fallback.

The smoke is a build gate, not a live receive proof.

## Bridge-D6 — release matrix

Required before the curated v1.12.0 release PR:

- Real **TeamSpeak 6** server (beta13 baseline)
- **Discord desktop**
- Console Discord: test **Xbox** and **PlayStation** if both are claimed. Fill the table. A claimed console that was not in the run is **unverified** and must not be advertised as tested.
- DAVE connect, transition, reconnect, and the #11653 join-order case
- Receiver failover (kill the active receiver; one successor; no duplicate receiver)
- Both audio directions
- Five slots plus overflow
- Audio isolation (no crosstalk, no duplicate, no feedback)
- Measured latency (speak-to-hear) on that matrix
- Join/leave, mute, deafen, channel switch
- Channel permission and bot-account restrictions
- Worker crash / kill recovery
- Token redaction, revocation, rotation
- Two TeamSpeak servers do not share audio or tokens
- Music, video, and listener-remote (#442) CI / Playwright and a real-server smoke of already-merged remote behaviour

**D6 client evidence (empty until run):**

| Client | Result | Notes |
|---|---|---|
| TeamSpeak 6 (beta13) | | |
| Discord desktop | | |
| Discord Xbox | | unverified until tested |
| Discord PlayStation | | unverified until tested |

Release gates: security review, dependency/licence review, performance numbers on 5+1, **explicit owner approval**.

## Official deployment

- New worker image, published only with the v1.12.0 GitHub Release (same rule as the sidecar). Not from this feature branch.
- Compose service uses profile **`discord-bridge`**. Default `docker compose up` does not create or start it. All-in-one is the same: a sibling container, not Node 24 stuffed into the Node 20 image.
- Backend `DISCORD_BRIDGE_URL` stays unset in the default compose file. Setting it without `DISCORD_BRIDGE_SECRET` is fatal in production.
- When the profile is on, the worker still does not join Discord or TeamSpeak until an admin enables a mapping and membership checks pass.
- Do not publish the worker port. Bind any lab port to `127.0.0.1`.
- Compose **resource limits** (starting values; D1/D6 measurements may raise them with evidence, not hunches):
  - `cpus: 1.0`, `memory: 512M`
  - reservation `cpus: 0.25`, `memory: 128M`
  - no unlimited restart loop on a crash without a backoff
- Per-session PCM is bounded to 20 ms frames. Overflow mix is the current overflow uniqueIds only. No unbounded jitter buffers.

## Multi-server isolation

- One Prisma row (and worker session) per mapped TeamSpeak server.
- Sessions do not share tokens, PCM rings, Opus state, Discord clients, or logs that name the other server’s channel ids.
- Admin APIs are scoped by the caller’s per-server access, same as other admin routes.
- A start/stop for server A must not change server B.

## Parallel work

- Do not edit listener-remote, `PlayQueue`, `/remote`, or the #442 contract (`docs/internal/listener-remote-api.md`).
- #442 A1 and B4c bump `SCHEMA_VERSION`. **One Prisma schema PR open at a time.** Bridge-D2 is the only schema PR in this lane and rebases behind those if they land first.
- Bridge-K is documentation only: no schema, no compose service yet, no `feat:` commit.
- No `feat:` merge from this lane until the owner decides v1.11.2 ([#460](https://github.com/uniskela/ts6-manager/pull/460)). A `feat:` on `main` would retarget that release PR to v1.12.0.
- Do not edit `#460`, `version.txt`, package versions, `app-version.ts`, or `CHANGELOG.md`.
- Roadmap / upgrading 1.12.0: this lane owns only the Discord sentences. #442 docs own the remote notes. The last 1.12.0 docs PR must mention both.

## Blockers

Report a failed D1 parse, failed DAVE receive, licence problem, or any other gate miss to the owner. Do not automatically reduce v1.12.0 to single-bot or slip D2–D6.
