# Bridge-D2 implementation readiness

**Date:** 2026-10-29  
**Status:** Research only. Do not implement. Do not amend [discord-voice-bridge.md](../discord-voice-bridge.md) without owner approval.  
**Opens after:** D1 live acceptance (A–D) plus independent review of that HEAD. Current D1: **NO-GO** ([evidence](2026-10-29-d1-live-evidence.md)).

Companion: Bridge-K contract and [2026-10-23 spec](../superpowers/specs/2026-10-23-discord-voice-bridge-design.md). D2 there is: official image/compose, control plane, encrypted tokens.

## What D1 already proved (packaging, not product)

On draft PR #504 the worker is an isolated Node 24 package, excluded from the pnpm workspace, with its own lockfile and lab Dockerfile. DAVE is fail-closed. Six Discord applications, one shared TeamSpeak client, 5+1 routing. Private-beta compose is opt-in, `restart: "no"`, no published ports.

That is **not** D2. Lab start is stdin/`private-beta.ts`, not an HTTP control plane. TeamSpeak identity is `generateIdentity(8)` in memory (`TsSession.connect`) and discarded. Tokens live in a gitignored env file, not Prisma.

## Architecture fit

| Topic | Current | D2 need |
|---|---|---|
| Package | `packages/discord-bridge` excluded (`pnpm-workspace.yaml`) | Keep excluded from the Node 20 workspace. Official `Dockerfile.discord-bridge` sibling image. Do not run `@discordjs/voice@0.19.2` on the backend image (`engines.node >= 22.12.0`). |
| Node | Backend/frontend Node 20 + pnpm 9; worker Node 24 | Unchanged split. All-in-one stays Node 20; worker is a second container. |
| Images | Lab Dockerfile on #504; private GHCR preview is reduced-trust, not a release | Publish worker only with a GitHub Release (same rule as sidecar). No `latest` from this lane. Private-beta workflow stays off Release Please. |
| Config / secrets | Six env tokens; `DISCORD_BRIDGE_SECRET` not in D1 | Prisma mapping per TeamSpeak server; tokens `enc:iv:tag:ciphertext`; GET never returns plaintext or ciphertext; empty field = keep. Worker mutating API bearer, same class as sidecar. Production fatal if URL set without secret. |
| Six bots | Required now | Keep 5+1. No seventh bot. Receiver elected from those six. |
| TeamSpeak identity | Ephemeral level-8 | Persist **one** shared identity (encrypted, music-bot pattern). Frontend never sees keys. Presence-1 needs this; it may ride with D2 but is **not** a silent Bridge-K amendment. |
| TS lifecycle | Lab connect/disconnect | Start only after mapping + membership checks. Stop: drain, destroy bots, disconnect TS, write evidence/health. SIGTERM grace like private-beta 30s. No unbounded restart loop. |
| Health | `host-status.json` / private-beta healthcheck | Loopback/internal HTTP: mapping enabled, one receiver, DAVE ready, no duplicate receivers, redacted counters. 1 CPU / 512 MiB starting limits. |
| DAVE / reconnect | Fail-closed; Phase 1 `maxRecoveries=0` | Product default is bounded reconnect (lab 3/60s), still no plaintext. Owner picks default vs single-attempt diagnostic. Do not weaken fences. |
| API / UI | None | D2: admin start/stop/config/status, write-only tokens. D5 owns the page. |
| 5+1 | Implemented in D1 core | D2 must not shrink to one bot. |
| Rollback | Lab `rollback <sha>` / previous GHCR digest | Pin previous release digest; profile off returns manager to “no Discord”; do not mix lab and release tags. |

## Gaps that block a D2 start

1. **D1 acceptance incomplete.** A, B, C, D live rows still NOT-RUN. Bidirectional audio on `7f4d6c7` unverified.
2. **Bridge-K has no D2 section.** Contract jumps D1 → D3. Spec PR table is the D2 definition. Do not invent extra D2 scope (UI, overflow persistence, Presence-1) without approval.
3. **One Prisma schema PR at a time.** #442 also bumps `SCHEMA_VERSION`. D2 schema rebases behind that.
4. **v1.12.0 `feat:` policy.** A `feat:` on `main` retargets the release. D2 packaging may need `chore:` until the owner wants the SemVer bump.
5. **Private GHCR preview ≠ official image.** Do not promote `private-beta-*` tags into compose.
6. **tslib copy.** D1 vendors `packages/backend/src/voice/tslib`. Shared package only after D1 parse is accepted. D2 still copies or vendors; do not edit `voice-bot.ts` for the worker.
7. **Identity persist vs lab.** Reusing a persisted uniqueId on a server that already saw the ephemeral D1 client is fine; regenerating on every start is what D2 must stop.

## Recommended PR sequence (after D1 GO)

Small, independently reviewable. Each PR tests without live Discord unless noted.

1. **D2-0 docs** — Add a Bridge-K D2 subsection (owner-approved contract text only): image, profile, secret, schema, identity persist yes/no.
2. **D2-1 identity persist (worker-only)** — Restore/store one encrypted TS identity in the worker (file or later Prisma). Tests: round-trip `restoreIdentity`, no key in logs. No compose yet.
3. **D2-2 official Dockerfile + compose profile** — `Dockerfile.discord-bridge` from pinned `node:24-bookworm` digest; profile `discord-bridge`; no published port; 1 CPU / 512 MiB; `restart` with backoff, not `always`. CI native Opus/DAVE smoke. Default `up` does not start it.
4. **D2-3 Prisma mapping + encrypted tokens** — One schema PR. `enabled` default false. Backend decrypts only to push start payload. Route tests with fake worker.
5. **D2-4 worker HTTP control plane** — Start/stop/status on internal network; bearer secret; fail-closed membership checks; health. No frontend.
6. **D2-5 backend wiring** — `DISCORD_BRIDGE_URL` / secret env; fatal if URL without secret; status proxy redacted.

D5 UI waits. D3 slot persistence waits. Presence-1 waits for D2-1 (at minimum) plus D1 GO.

## Tests D2 must add

- Image: native Opus + davey load; DAVE-native fail is fatal.
- Compose: profile off ⇒ no worker; no `0.0.0.0` publish.
- Crypto: token encrypt/decrypt; GET empty; empty patch keeps value.
- Identity: persist + restore same uniqueId; destroy on mapping delete.
- Control: missing secret 401; six tokens required; start refused if membership check fails.
- Shutdown: stop destroys Discord voice + TS client; no reconnect after stop.
- Regression: listener-remote and music-bot tests unchanged.

## Owner decisions (do not guess)

- May D2 start before A–D PASS? **Default NO.**
- Does D2 persist the shared TS identity, or is that a Presence-1-only PR that rides along?
- Worker restart policy in official compose (`no` vs bounded).
- Whether D2 is `chore:` packaging or `feat:` v1.12.0.

Related: [#502](https://github.com/uniskela/ts6-manager/issues/502), spec D2 row, [#556](https://github.com/uniskela/ts6-manager/issues/556) for identity-as-Presence-1-prereq.
