# Proposed Bridge-K D2 subsection (draft, not applied)

**Status:** Planning text only. Do **not** paste into [discord-voice-bridge.md](../discord-voice-bridge.md) until D1 acceptance **and** explicit owner approval.  
**Does not** start D2 or Presence-1 implementation.  
**Does not** change evidence classifications in [2026-10-29-d1-live-evidence.md](2026-10-29-d1-live-evidence.md).  
Draft PR [#563](https://github.com/uniskela/ts6-manager/pull/563) stays Draft until that approval.

Intended insertion point: after `## Bridge-D1 — live bidirectional proof`, before `## Bridge-D3 — identity and slots`.

Companion readiness: [2026-10-29-bridge-d2-readiness.md](2026-10-29-bridge-d2-readiness.md).

## Recorded owner decisions (2026-10-29)

| ID | Decision |
|---|---|
| **D2-I** | Encrypted Prisma, backend-owned. One shared identity per mapping. Music-bot `encrypt()` store. Worker is not a second store. |
| **D2-L** | Level **23**, via existing `generateIdentityAsync(23)` on the **Node 20 backend** Worker, **before** first authorised Start. **180 s** timeout then `Worker.terminate()`. One in-flight generation per mapping. Persist atomically encrypted; never ephemeral level-8. |
| **D2-S** | First successful **atomic Prisma lease claim** wins. Competing Start: HTTP 409. Idempotent retry of the winner may return the existing session. Explicit Restart is Stop → fence → new lease → Start. |
| **D2-C** | Supervised D2: **no** in-process reconnects. Intended production: **3 / 60s with backoff**, only while authorisation and lease remain valid. Requires D1 live failover **and** recovery tests PASS **and** a separate explicit owner approval. D1 single-attempt lab behaviour is unchanged. |
| **D2-D** | Delete order: revoke lease → Stop/fence worker → delete Prisma identity+mapping → stale Start/payloads fail closed. |
| **D2-R** | Compose `restart: "no"`. Later `on-failure:3` needs separate approval. No unlimited Docker restart. No plaintext. |
| **D2-P** | `chore:` preparatory; `feat:` when v1.12.0 is meant to gain Start. Do not retarget early. |

Prisma schema PRs still wait if another `SCHEMA_VERSION` change (#442) is open.

## Proposed contract text

```markdown
## Bridge-D2 — official worker packaging and control plane

Opens only after D1 live acceptance (including two-speaker, failover, and membership rows) and an independent review of that HEAD. D2 does not shrink 5+1, does not add a seventh Discord bot, and does not start D3 slot persistence or D5 UI.

### Image and compose

- Sibling worker image from a pinned `node:24-bookworm` digest (`Dockerfile.discord-bridge`). Backend and frontend stay Node 20.
- Published only with a GitHub Release (same rule as the sidecar). Do not promote `private-beta-*` tags or the reduced-trust preview workflow into official compose.
- Compose profile `discord-bridge`. Default `docker compose up` does not create or start the worker. `DISCORD_BRIDGE_URL` stays unset unless that profile is on.
- No published worker port. Internal Docker network or loopback only.
- Starting limits: 1 CPU / 512 MiB. **One replica.** Do not scale the worker.
- `restart: "no"` for the first controlled D2 rollout. Do not switch to `on-failure:3` (or any backoff restart) until live recovery, fail-closed behaviour, and shutdown handling are accepted **and** the owner approves that change. `always` / `unless-stopped` are forbidden. An unhealthy DAVE session must not restart the container in a loop and must not fall back to plaintext.
- Native Opus and DAVE (`@snazzah/davey`) load in CI. DAVE-native failure is fatal.

### Control plane and secrets

- Admin-only start/stop/config/status. Write-only token fields. GET never returns token plaintext, token ciphertext, TeamSpeak identity material, or session secrets. Empty token field means keep stored value.
- Six official bot tokens per mapped TeamSpeak server, stored `enc:iv:tag:ciphertext` with the existing AES-256-GCM helper (`encrypt()`).
- Worker mutating API requires a bearer secret, same class as `SIDECAR_SECRET`. Production is fatal if `DISCORD_BRIDGE_URL` is set without `DISCORD_BRIDGE_SECRET`.
- Frontend never sees bot tokens, TeamSpeak identity material, or the worker secret.
- Start is refused until mapping is enabled, guild/channel membership checks pass, **and** a level-23 identity is already persisted. A Start that arrives while generation is still running must not connect (no temporary identity). Stop destroys Discord voice connections, drops the in-memory identity, and disconnects the shared TeamSpeak client.

### Shared TeamSpeak identity (backend source of truth)

- Exactly **one** shared TeamSpeak identity per configured bridge mapping (one Prisma row per mapped TeamSpeak server).
- **Generate** with `generateIdentityAsync(23)` in a backend `worker_threads` Worker (`packages/backend/src/voice/tslib/identity-worker.ts`). This already runs on Node 20 for music bots. Do not call synchronous `generateIdentity(23)` on the HTTP thread. Do not generate inside the Node 24 Discord worker. Today’s helper has no timeout; D2-1 wraps it.
- Kick generation off when the mapping is configured (preferred), **before** the mapping’s first authorised Start. Wall time is a CPU-bound `keyOffset` search. Initial timeout is **180 seconds**. On timeout: `Worker.terminate()` (or equivalent safe cancel); ignore a late `message`; do not persist it. Record redacted failure status only.
- **One in-flight generation per mapping.** Concurrent configure/Start must not generate or persist a competing identity. Ignore late results after timeout, deletion, cancellation, or lease invalidation.
- Persist the successful level-23 identity **atomically** and encrypted. Start must not TeamSpeak-connect until ciphertext is stored.
- **Do not** connect on a temporary level-8 identity and replace it later. That music-bot placeholder path is explicitly out of D2. Never fall back to ephemeral level-8 on timeout or failure.
- Subsequent Starts **restore** the persisted identity (`decrypt` + `restoreIdentity`). Same uniqueId across process restarts.
- If generation fails or times out, Start fails closed with a redacted error. No identity material in the error body or logs.
- Changing the 180 s timeout later requires review after measured generation latency.
- The worker receives the identity **only** in an authorised start payload for that mapping’s active session. Memory only. No identity files, env, or worker database.

### Session lease (first-wins)

- **One active lease/session per mapping.** Backend issues a session id and fencing generation on Start.
- The winner is the **first successful atomic Prisma lease claim**. Competing Starts must not preempt that winner. Return **HTTP 409** for a competing Start. No second worker Start payload may connect using an already-claimed identity.
- An identical idempotent retry of the winning Start may return the existing session without creating another lease.
- **Explicit Restart** is separate: Stop → confirm termination or fencing → acquire a new lease → Start. A second Start is not a Restart.
- Delayed requests and stale workers must fail closed if the session id or fencing generation does not match. If lease ownership cannot be confirmed, fail closed (no audio).
- The worker refuses voice connect if the session id does not match the active lease.

### Stop, disable, delete

- **Administrative Stop:** end the session; worker drops memory; ciphertext stays; a later Start is allowed if the mapping is still enabled. Terminal: no automatic reconnection.
- **Disable mapping:** refuse new Starts until re-enabled; Stop the session; ciphertext stays. Terminal: no automatic reconnection.
- **Credential revocation:** terminal. No automatic reconnection.
- **Delete mapping** (this order):
  1. Revoke the mapping’s active lease and refuse new Starts.
  2. Stop the worker session; wait until it is terminated or securely fenced (stale session id).
  3. Delete the encrypted identity and mapping row from Prisma.
  4. Any stale worker or late Start payload for that mapping/session must fail closed and must not recreate the row or reconnect.
- Backups contain ciphertext; treat them as secret. `ENCRYPTION_KEY` rotation follows existing encrypted fields (do not rotate casually; no separate D2 scheme).
- Logs, health, status JSON, and ordinary GET omit keys, seeds, ciphertext, and uniqueId.

### Fail-closed DAVE and reconnect

- Fail-closed DAVE and receive-generation fences stay as D1. Unhealthy DAVE never yields plaintext.
- **Administrative Stop, disable, and credential revocation** are terminal session states. No automatic reconnection.
- **Membership or authorisation failure:** stop and fail closed. Resume only after verification and a **fresh authorised Start**. Do not reconnect when the check later passes.
- **Transient network or DAVE failure:** audio fails closed immediately. Supervised D2 rollout has **zero** automatic in-process recovery (`maxRecoveries=0` on that official image).
- **Compose (D2-R):** `restart: "no"`. Process exit stays down. No automatic Docker restart loop.
- **Future production in-process recovery (D2-C):** bounded **3 attempts per rolling 60 s with backoff**, **only while authorisation and the lease remain valid**. Enabled only after D1 live failover (ACCEPTANCE C) **and** follow-on recovery tests PASS **and** a separate explicit owner approval. Exhaustion remains fail-closed until explicit Restart. A disconnected worker must never resume audio on a stale or revoked lease.
- **D1 lab** `D1_DAVE_SINGLE_ATTEMPT=1` / Draft PR #504 behaviour is **not** modified by D2.

### Out of D2

- D3: persistent `uniqueId → slot` mapping and Discord `[TS] ` nicks.
- D4: overflow mix rules.
- D5: admin page / onboarding wizard.
- Presence-1 shared nickname roster (separate spec; uses this persisted identity).
- Presence-2 per-user TeamSpeak identities (needs a Bridge-K amendment).
```

## Apply-time Bridge-K edits (D2-0; do not apply in this PR)

When the owner later says apply, D2-0 pastes the fenced subsection **and** reconciles these two existing paragraphs. Do not leave the old sentences beside the new ones. Do **not** edit [discord-voice-bridge.md](../discord-voice-bridge.md) in this draft.

### A. Fail closed (membership / reconnect)

Current text (Fail closed):

> A running session that loses membership or authorisation disconnects and does not reconnect until the check passes.

Replace with the D2-C semantics above: Stop / disable / revocation are terminal; membership or authorisation failure stops fail-closed and needs a fresh authorised Start; transient network/DAVE fails closed with zero automatic recovery on supervised D2; future 3/60s is gated; a disconnected worker must not use a stale or revoked lease.

### B. Official deployment (restart / backoff)

Current bullet (Official deployment resource limits):

> no unlimited restart loop on a crash without a backoff

Replace with D2-R: compose `restart: "no"`; `on-failure:3` only after a later owner approval. Do not leave both sentences.

D6 “Worker crash / kill recovery” is not rewritten in this draft. When D2-0 lands, that D6 row means **operator Restart** (Stop → fence → new lease → Start), not an automatic Docker restart.

## What this draft does not do

- Does not edit `docs/internal/discord-voice-bridge.md`.
- Does not authorise implementation, GHCR publish, Portainer, recovery-policy changes, or Draft PR #504 changes.
- Does not close D1 acceptance rows.
