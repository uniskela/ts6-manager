# Discord voice bridge — compatibility and trust contract

Target: **v1.12.0**. Default: **disabled**. Status: **proposed; draft PR for owner review, not accepted**.

This is the Bridge-K contract. The draft PR is for review, not approval. Do not start Bridge-D1, merge, or publish until the owner explicitly accepts it. Do not shrink 5+1 to a single-bot product. Do not move incomplete work into another release. Escalate blockers.

Listener remote ([#442](https://github.com/uniskela/ts6-manager/issues/442)) stays in v1.12.0. v1.11.2 ([#460](https://github.com/uniskela/ts6-manager/pull/460)) stays on its current process.

Companion spec: [superpowers/specs/2026-10-23-discord-voice-bridge-design.md](superpowers/specs/2026-10-23-discord-voice-bridge-design.md).

## Product

- Two-way audio between one administrator-approved Discord voice channel and one administrator-approved TeamSpeak channel.
- TeamSpeak → Discord: up to five official bots named `[TS] Username`, plus one `[TS] Others` overflow bot.
- Discord → TeamSpeak: one designated official Discord receive bot forwards human Discord audio to one shared TeamSpeak client.
- Native TS6 Manager admin page for enablement, mapping, pool size (default five), overflow, status, participants, gain, mute, start/stop/restart, and redacted diagnostics.
- Isolated worker image (Node 24) in official compose behind profile `discord-bridge`. Default `docker compose up` does not start it. `DISCORD_BRIDGE_URL` is unset unless that profile is on.
- Official Discord applications only. Six bot tokens per mapped session. One of those six is the designated receive bot. No self-bots.
- No microphone recording and no retained audio by default.
- Participants must be told that audio crosses Discord and TeamSpeak (admin UI notice; operators should also say so in the mapped channels).

## Compatibility

| Side | Contract |
|---|---|
| TeamSpeak server | Baseline **6.0.0-beta13** (`teamspeaksystems/teamspeak6-server:6.0.0-beta13`). TS3 servers are in-scope for the same TS3 UDP client if one is available during D1. |
| TeamSpeak voice | Existing TS3 UDP client (EAX). Incoming S2C voice is `VId u16 + speaker CId u16 + codec u8 + Opus` per ReSpeak `ts3protocol`. Live TS6 layout is **unverified** until D1. |
| TeamSpeak video/WebRTC | Out of path. Do not use the media sidecar. |
| Discord | Official bot API. Voice is pinned below. Discord required DAVE for voice from 1 March 2026. |
| Discord receive | Receive is not documented by Discord. The pins implement DAVE decrypt in `@discordjs/voice` `VoiceReceiver`. **This repo has not yet verified live reception.** That is a D1 gate. If receive fails under DAVE, stop and ask the owner. |
| Node | Worker image is **Node 24**. Pinned `@discordjs/voice@0.19.0` documents `engines.node >= 22.12.0`. Do not run the worker on the Node 20 backend image. Backend and frontend stay on Node 20 / pnpm 9. |
| Consoles | Xbox and PlayStation Discord clients are in the D6 matrix. D1 may use desktop if a console is not available; D6 cannot skip the console. |

Compatibility CI today does not certify voice playback. D1 and D6 are real-server proofs, not a substitute for that workflow.

## Audio routing

1. Parse each TeamSpeak voice packet to a speaker `CId`, then to `uniqueId`. Do not key slots on display name.
2. Simultaneous TeamSpeak speakers are decoded and routed independently. A uniqueId on an individual slot is sent only to that slot’s Discord bot.
3. UniqueIds over the pool limit are mixed only onto `[TS] Others`.
4. A uniqueId is never audible on both a slot bot and overflow at the same time.
5. Music bots and system clients are excluded by default (`client_type`, known `MusicBot` uniqueIds).
6. Whisper and talk-power: only channel voice the shared TeamSpeak client is allowed to hear.
7. The designated receive bot subscribes only to human Discord users. It never subscribes to slot bots, overflow, or itself.
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
- fewer than six bot tokens when the default 5+1 pool is enabled (receive is one of those six)
- Discord guild, voice channel, or bot membership cannot be verified
- TeamSpeak server or channel cannot be verified
- worker secret missing or wrong

A running session that loses membership or authorisation disconnects and does not reconnect until the check passes.

## Echo and feedback

- Never subscribe to any bridge bot SSRC.
- Never send the Discord→TeamSpeak mix back into Discord.
- Never send a TeamSpeak uniqueId to more than one Discord destination.
- Dual-homed acoustic echo is out of scope.

## Pinned Discord voice dependencies

These are the D1/D2 pins. Live DAVE **reception** is not claimed until the D1 evidence table is filled.

| Package | Pin | Licence | Documented Node | DAVE |
|---|---|---|---|---|
| `discord.js` | **14.27.0** | Apache-2.0 | `>=18` | Gateway only |
| `@discordjs/voice` | **0.19.0** | Apache-2.0 | **`>=22.12.0`** (package `engines`) | `daveEncryption` defaults true; `VoiceReceiver` decrypts DAVE frames via `@snazzah/davey` |
| `@snazzah/davey` | **0.1.12** (voice 0.19.0 depends on `^0.1.6`) | MIT | ships as a N-API addon; run on the worker’s Node 24 image | MLS / media encrypt-decrypt |
| `@discordjs/opus` | **0.9.0** (`@discordjs/voice@0.19.0` lists `^0.9.0`) | MIT | worker Node 24 | Opus |
| `opusscript` | already in the backend; worker fallback only | MIT | worker Node 24 | Opus fallback |

Unreleased `@discordjs/voice` `main` docs have said Node 24.17+. That is **not** the pin. The pin is published **0.19.0** (`>=22.12.0`). The worker image is still Node 24 so it stays off the Node 20 monorepo and above the pin’s floor.

A licence that is not Apache-2.0, MIT, or BSD-family, or a pin change, stops D2 for an owner decision. Do not add GPL voice stacks. Do not float unpinned `latest`.

## Bridge-D1 — live bidirectional proof

D3 and D4 do not start until all of the following are recorded here as evidence (pass/fail, date, clients used):

1. Live TeamSpeak 6 S2C packets parse to speaker `CId` and `uniqueId`.
2. **Two TeamSpeak users speaking at the same time** are routed to two official Discord bot identities, independently, with **no crosstalk**.
3. Discord → TeamSpeak works through a **designated receiving bot** into the shared TeamSpeak client (not a second copy of the TeamSpeak→Discord path).
4. No bridge-induced duplicate audio and no feedback in either direction.
5. Token-redacted logs, loopback health, and a CPU / RSS / speak-to-hear measurement.

D1 lab compose, if any, binds to `127.0.0.1` only and is not part of default `up`.

**Evidence (empty until D1 runs):**

| Check | Result | Notes |
|---|---|---|
| TS6 S2C speaker parse | | |
| Two simultaneous TS speakers → two Discord bots, independently, no crosstalk | | |
| Discord → TS via designated receive bot | | |
| No duplicate audio / no feedback | | |
| CPU / RSS / one-way speak-to-hear | | |

If any row fails, stop. Owner decides. Do not open D3/D4. Do not ship mixed-only as v1.12.0.

## Bridge-D3 — identity and slots

- Persistent `uniqueId → slot` mapping. Rename, disconnect, and reconnect do not allocate a new slot while the mapping is held.
- Discord nick is `[TS] ` plus the current TeamSpeak display name, truncated to Discord’s limit.
- Duplicate TeamSpeak names are allowed; uniqueId still decides the slot.
- Nickname updates honour Discord rate limits: wait `Retry-After`, drop intermediate names, never busy-loop.
- One slot bot’s connection failure does not tear down the other slots, overflow, the receive bot, or the shared TeamSpeak client. That slot reconnects; audio for its uniqueId is held or moved only by the reassignment rules, never duplicated.
- Slot reassignment is explicit: a uniqueId is removed from the old destination on a 20 ms frame boundary before it is added to the new one.
- Discord-side mute and speaking indicators are per slot.

## Bridge-D4 — overflow

- Eight TeamSpeak users produce five slot bots and one overflow bot carrying the other three.
- Simultaneous overflow speakers are mixed. Peak-limit or attenuate; do not clip from a naive sum.
- Individual ↔ overflow transitions occur at a 20 ms frame boundary: remove the uniqueId from the old destination, then add it to the new one. The bridge must not play that uniqueId on both destinations and must not insert a silence gap of its own between those two frames.
- This does **not** promise zero packet loss. Packets already dropped by Discord, TeamSpeak, or the network stay dropped. The duty is no **bridge-induced** duplication or gap.
- Empty slots are released, then the next waiting uniqueId is promoted.
- Music bots stay excluded.

## Bridge-D5 — administration

Administrator-only. Viewer cannot change settings. Per-server access applies. Secrets never in GET bodies. In-page notice that audio crosses platforms.

## Bridge-D6 — release matrix

Required before the curated v1.12.0 release PR:

- Real **TeamSpeak 6** server (beta13 baseline)
- **Discord desktop**
- At least one supported **console Discord** client (Xbox or PlayStation)
- DAVE connect and reconnect
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
