# Bridge-D2 implementation readiness

**Date:** 2026-10-29  
**Status:** Research only. Do not implement. Do not amend [discord-voice-bridge.md](../discord-voice-bridge.md) without owner approval.  
**Opens after:** D1 live acceptance (A–D) plus independent review of that HEAD. Current D1: **NO-GO** ([evidence](2026-10-29-d1-live-evidence.md)).

Owner decisions (2026-10-29) are recorded in [2026-10-29-bridge-d2-contract-draft.md](2026-10-29-bridge-d2-contract-draft.md): Prisma identity (D2-I), `restart: "no"` (D2-R), `chore:` vs `feat:` (D2-P).

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
| TeamSpeak identity | Ephemeral level-8 | **D2-I:** one encrypted identity per mapping in Prisma (music-bot `encrypt()` / `restoreIdentity`). Worker gets it only on authorised Start; memory only; no second store. |
| TS lifecycle | Lab connect/disconnect | Start only after mapping + membership checks. Stop: drain, destroy bots, drop in-memory identity, disconnect TS. SIGTERM grace like private-beta 30s. Compose **`restart: "no"`** (D2-R). |
| Health | `host-status.json` / private-beta healthcheck | Loopback/internal HTTP: mapping enabled, one receiver, DAVE ready, no duplicate receivers, redacted counters. 1 CPU / 512 MiB starting limits. |
| DAVE / reconnect | Fail-closed; Phase 1 `maxRecoveries=0` | Product default is bounded reconnect (lab 3/60s), still no plaintext. Owner picks default vs single-attempt diagnostic. Do not weaken fences. |
| API / UI | None | D2: admin start/stop/config/status, write-only tokens. D5 owns the page. |
| 5+1 | Implemented in D1 core | D2 must not shrink to one bot. |
| Rollback | Lab `rollback <sha>` / previous GHCR digest | Pin previous release digest; profile off returns manager to “no Discord”; do not mix lab and release tags. |

## Gaps that block a D2 start

1. **D1 acceptance incomplete.** A, B, C, D live rows still NOT-RUN. Bidirectional audio on `7f4d6c7` unverified.
2. **Bridge-K has no D2 section until this draft is applied.** Do not paste it before D1 GO + owner approval. Draft: [2026-10-29-bridge-d2-contract-draft.md](2026-10-29-bridge-d2-contract-draft.md).
3. **One Prisma schema PR at a time.** #442 also bumps schema. D2-1 rebases behind that.
4. **Release class (D2-P).** `chore:` while the feature stays disabled/unshipped; `feat:` only when v1.12.0 is meant to gain the working control plane. Do not open that `feat:` early.
5. **Private GHCR preview ≠ official image.** Do not promote `private-beta-*` tags into compose.
6. **tslib copy.** D1 vendors `packages/backend/src/voice/tslib`. Shared package only after D1 parse is accepted. D2 still copies or vendors; do not edit `voice-bot.ts` for the worker.
7. **Identity persist vs lab.** Reusing a persisted uniqueId on a server that already saw the ephemeral D1 client is fine; regenerating on every start is what D2 must stop.

## Recommended PR sequence (after D1 GO)

Small, independently reviewable. No live Discord unless noted. Prefixes follow **D2-P**.

1. **D2-0** `docs:` — Apply the approved D2 subsection to Bridge-K (this draft’s fenced text, after owner says apply).
2. **D2-1** `chore:` — Prisma mapping row: six encrypted tokens, one encrypted TS identity, `enabled` default false, session/lease id. Coordinate with #442. Tests: encrypt/restore round-trip; GET omits identity; delete wipes ciphertext. No worker start yet.
3. **D2-2** `chore:` — `Dockerfile.discord-bridge` + compose profile; `restart: "no"`; one replica; no published port; 1 CPU / 512 MiB; native Opus/DAVE CI smoke. Default `up` does not start it.
4. **D2-3** `chore:` — Worker HTTP start/stop/status; bearer secret; identity **memory only** for the session id in the payload; refuse mismatch; Stop drops identity. Fake backend tests.
5. **D2-4** `feat:` — Backend Start pushes identity + session over the internal URL; singleton lease (second Start fences the first); fatal if URL without secret; redacted status. This is the first user-facing enablement; do not land it until v1.12.0 is the intended target.

Later, **separate approval:** compose `on-failure:3` only after recovery/fail-closed/shutdown are accepted live.

D5 UI waits. D3 slot persistence waits. Presence-1 waits for D2-1 (store) and D2-4 (identity actually flows) plus D1 GO.

## Tests D2 must add

- Image: native Opus + davey load; DAVE-native fail is fatal.
- Compose: profile off ⇒ no worker; no `0.0.0.0` publish; `restart: "no"`; one replica.
- Crypto: token encrypt/decrypt; GET empty; empty patch keeps value.
- Identity: persist + restore same uniqueId; destroy on mapping delete; second Start fences the first session; worker has no identity file.
- Control: missing secret 401; six tokens required; start refused if membership check fails.
- Shutdown: stop destroys Discord voice + TS client; no reconnect after stop.
- Regression: listener-remote and music-bot tests unchanged.

## Remaining gaps (not re-opened owner options)

- May D2 code start before A–D PASS? **Still NO.**
- No `ENCRYPTION_KEY` re-encrypt job exists today; identity follows the same “do not rotate casually” rule as music bots.
- In-process DAVE reconnect budget vs compose `restart: "no"` are different layers; do not conflate them with `D1_DAVE_SINGLE_ATTEMPT`.
- First official connect with a new persisted uniqueId looks like a new TeamSpeak client (D1 lab used ephemeral keys).

Related: [#502](https://github.com/uniskela/ts6-manager/issues/502), [#442](https://github.com/uniskela/ts6-manager/issues/442), [#556](https://github.com/uniskela/ts6-manager/issues/556).
