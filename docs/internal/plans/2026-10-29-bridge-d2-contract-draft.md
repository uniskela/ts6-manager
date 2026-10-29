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
| **D2-I** | Encrypted Prisma, owned by the TS6 Manager backend. One shared TeamSpeak identity per configured bridge mapping. Music-bot `encrypt()` / `identityData` pattern. Worker is not a second store. |
| **D2-R** | Initial official compose: `restart: "no"`. Later bounded `on-failure:3` needs a separate approval and test. No unlimited restart loop. No plaintext DAVE fallback. |
| **D2-P** | `chore:` for preparatory packaging/infra that does not enable a user-facing feature. `feat:` when completed functionality is intentionally introduced into v1.12.0. Do not retarget the release early. |

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
- Start is refused until mapping is enabled and guild/channel membership checks pass. Stop destroys Discord voice connections, drops the in-memory identity, and disconnects the shared TeamSpeak client.

### Shared TeamSpeak identity (backend source of truth)

- Exactly **one** shared TeamSpeak identity per configured bridge mapping (one Prisma row per mapped TeamSpeak server).
- Backend generates or restores via the same helpers as music bots (`generateIdentity` / `restoreIdentity`, same serialize path as `MusicBot.identityData`). Persist ciphertext only (`encrypt()`). Security level is **not** decided here (music bots later raise toward 23; D1 lab used 8).
- The worker receives the identity **only** in an authorised start payload for that mapping’s active session. It holds it in memory for that session. It must not write identity files, env, or a local database.
- **One active worker session per mapping.** Backend issues a session/lease id on Start. A second Start for the same mapping stops and fences the previous session before a new payload is sent. The worker refuses voice connect if the session id does not match. Two replicas must not both hold the identity.
- **Stop / disable:** worker drops the in-memory identity and disconnects. Prisma ciphertext stays so the next authorised Start restores the same uniqueId.
- **Delete mapping:** destroy the ciphertext in Prisma, then Stop so memory is empty. Backups of the database contain ciphertext; treat them as secret, same as other `encrypt()` fields.
- `ENCRYPTION_KEY` rotation is the existing product rule: do not rotate casually; a new key cannot decrypt old rows (music bots, API keys, and this identity alike). D2 must not invent a separate rotation scheme. A future shared re-encrypt job, if built, covers this field with the others.
- Logs, health, status JSON, and ordinary GET omit identity private keys, seed, ciphertext, and uniqueId. Same omission as music-bot GET (`identityData` never returned).

### Fail-closed DAVE

- Fail-closed DAVE and receive-generation fences stay as D1. Unhealthy DAVE never yields plaintext and never restarts the container.
- **Compose restart (D2-R)** is `"no"`. A process exit stays down until an operator starts it.
- **In-process reconnect budget** is a separate layer from D2-R. This draft does not change D1’s fail-closed fences. Official default for in-process recoveries (none vs bounded 3/60s vs lab `D1_DAVE_SINGLE_ATTEMPT`) is **not chosen here**.

### Out of D2

- D3: persistent `uniqueId → slot` mapping and Discord `[TS] ` nicks.
- D4: overflow mix rules.
- D5: admin page / onboarding wizard.
- Presence-1 shared nickname roster (separate spec; uses this persisted identity).
- Presence-2 per-user TeamSpeak identities (needs a Bridge-K amendment).
```

When this text is later applied to Bridge-K, also replace the Official deployment line “no unlimited restart loop on a crash without a backoff” with D2-R (`restart: "no"`; `on-failure:3` only after a later approval). Do not leave both sentences in the contract.

## What this draft does not do

- Does not edit `docs/internal/discord-voice-bridge.md`.
- Does not authorise implementation, GHCR publish, Portainer, recovery-policy changes, or Draft PR #504 changes.
- Does not close D1 acceptance rows.
