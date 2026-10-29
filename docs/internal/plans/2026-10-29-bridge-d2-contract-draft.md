# Proposed Bridge-K D2 subsection (draft, not applied)

**Status:** Planning text only. Do **not** paste into [discord-voice-bridge.md](../discord-voice-bridge.md) until D1 acceptance **and** explicit owner approval.  
**Does not** start D2 or Presence-1 implementation.  
**Does not** change evidence classifications in [2026-10-29-d1-live-evidence.md](2026-10-29-d1-live-evidence.md).

Intended insertion point: after `## Bridge-D1 — live bidirectional proof`, before `## Bridge-D3 — identity and slots`.

Companion readiness: [2026-10-29-bridge-d2-readiness.md](2026-10-29-bridge-d2-readiness.md). Spec D2 row: official image/compose, control plane, encrypted tokens.

## Owner decisions still required

Do not guess these in a later Bridge-K edit.

| ID | Decision | Options | Default if unset |
|---|---|---|---|
| D2-I | Shared TeamSpeak identity storage | (a) Prisma ciphertext with the mapping row (music-bot `encrypt()` pattern); (b) worker-local encrypted file; (c) omit from D2, persist only with Presence-1 | **Unset.** Presence-1 wants persist; Bridge-K D2 today does not name it |
| D2-R | Official worker `restart` | (a) `"no"` like private-beta; (b) bounded backoff (`on-failure` + cap); (c) compose `always` | **Not (c).** Unbounded restart is already forbidden. (a) vs (b) needs a call |
| D2-P | First D2 merge commit class | (a) `chore:` packaging, no SemVer bump; (b) `feat:` that opens/retargets v1.12.0 | **Unset.** A `feat:` on `main` retargets the release PR |

Also: D2 schema PR must wait if another Prisma `SCHEMA_VERSION` PR (#442) is open.

## Proposed contract text

```markdown
## Bridge-D2 — official worker packaging and control plane

Opens only after D1 live acceptance (including two-speaker, failover, and membership rows) and an independent review of that HEAD. D2 does not shrink 5+1, does not add a seventh Discord bot, and does not start D3 slot persistence or D5 UI.

### Image and compose

- Sibling worker image from a pinned `node:24-bookworm` digest (`Dockerfile.discord-bridge`). Backend and frontend stay Node 20.
- Published only with a GitHub Release (same rule as the sidecar). Do not promote `private-beta-*` tags or the reduced-trust preview workflow into official compose.
- Compose profile `discord-bridge`. Default `docker compose up` does not create or start the worker. `DISCORD_BRIDGE_URL` stays unset unless that profile is on.
- No published worker port. Internal Docker network or loopback only.
- Starting limits: 1 CPU / 512 MiB. No unlimited restart loop. **Restart policy is owner decision D2-R.**
- Native Opus and DAVE (`@snazzah/davey`) load in CI. DAVE-native failure is fatal. No plaintext voice path.

### Control plane and secrets

- Admin-only start/stop/config/status. Write-only token fields. GET never returns token plaintext or ciphertext. Empty token field means keep stored value.
- Six official bot tokens per mapped TeamSpeak server, stored `enc:iv:tag:ciphertext` with the existing AES-256-GCM helper.
- Worker mutating API requires a bearer secret, same class as `SIDECAR_SECRET`. Production is fatal if `DISCORD_BRIDGE_URL` is set without `DISCORD_BRIDGE_SECRET`.
- Frontend never sees bot tokens, TeamSpeak identity material, or the worker secret.
- Start is refused until mapping is enabled and guild/channel membership checks pass. Stop destroys Discord voice connections and disconnects the shared TeamSpeak client.

### Shared TeamSpeak client

- Still exactly one TeamSpeak UDP client and one Discord→TeamSpeak mix.
- Identity persist (**D2-I**) is not implied by this subsection until the owner picks (a), (b), or (c).
- Fail-closed DAVE and receive-generation fences stay as D1. Product reconnect budget is bounded; it is not `maxRecoveries=0` unless the operator sets that diagnostic.

### Out of D2

- D3: persistent `uniqueId → slot` mapping and Discord `[TS] ` nicks.
- D4: overflow mix rules.
- D5: admin page / onboarding wizard.
- Presence-1 shared nickname roster (separate spec; needs identity persist).
- Presence-2 per-user TeamSpeak identities (needs a Bridge-K amendment).
```

## What this draft does not do

- Does not edit `docs/internal/discord-voice-bridge.md`.
- Does not resolve D2-I / D2-R / D2-P.
- Does not authorise implementation, GHCR publish, Portainer, or Draft PR #504 changes.
