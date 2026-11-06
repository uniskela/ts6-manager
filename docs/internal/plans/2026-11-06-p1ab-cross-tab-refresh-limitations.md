# P1-B cross-tab refresh coordination — limitations

Status: local security gate evidence (not a public release note).

## Secure-context / Web Lock matrix (Chromium evidence)

| Origin class | Example | `isSecureContext` | `navigator.locks` | `BroadcastChannel` |
|---|---|---|---|---|
| Loopback HTTP | `http://127.0.0.1`, `http://localhost` | yes | yes | yes |
| HTTPS | reverse-proxy / TLS | yes | yes | yes |
| LAN / private HTTP | `http://192.168.x.x`, `http://lan.ts6.test` | **no** | **no** | yes |

Measured with Chromium via Playwright host-resolver mapping (non-localhost HTTP hostname → 127.0.0.1). Web Locks require a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts); loopback is treated as trustworthy, ordinary LAN HTTP is not.

## What works (secure context + `navigator.locks`)

Across two same-origin pages sharing one browser storage partition:

1. Refresh is serialized on the `ts6-auth-refresh` Web Lock.
2. After the lock is acquired, the client re-reads zustand persist (`ts6-auth`) so a peer tab’s rotation is visible before the network call.
3. If persist already holds a newer refresh token **and** a still-valid access token, the waiting tab adopts that pair and does **not** perform another rotation.
4. Consumed-token replay still revokes the refresh family on the server; the frontend does not weaken that check.

## No-Web-Lock path (LAN HTTP) — measured hazard

When `navigator.locks` is missing, the client still prefers the persisted refresh token over in-memory state. That re-read is **not** atomic coordination:

- Two tabs can both observe the same live refresh token and both POST `/api/auth/refresh`.
- The server correctly treats the second presentation as reuse and revokes the family.
- **Playwright on `http://lan.ts6.test` (insecure): 6 of 8 concurrent two-tab refresh trials revoked the family** (`revokeHits=6`, `singleWinner=2`). See `tests/auth-refresh-http-lan-nolock.spec.ts`.

Do **not** soften server-side replay detection to paper over this race. Do **not** treat silent multi-tab logout on LAN HTTP as normal product behaviour.

### Compatibility policy (proposed for owner acceptance)

| Deployment | Multi-tab refresh | Disposition |
|---|---|---|
| HTTPS reverse-proxy | Supported (Web Locks) | GO |
| `localhost` / `127.0.0.1` HTTP | Supported (secure-context exception) | GO |
| Plain HTTP on LAN / private IP | **Unsupported** for concurrent multi-tab refresh until BroadcastChannel coordination ships | CONDITIONAL — document + warn |
| Older browsers without Web Locks even on HTTPS | Rare; same as no-lock path | CONDITIONAL |

**Safe user-facing behaviour until a coordination fallback lands:**

1. Release / ops note: prefer HTTPS (or localhost) for multi-tab use.
2. Optional UI: when `!window.isSecureContext`, show a durable settings/login hint that multiple tabs may end the session if they refresh together.
3. Do not claim “seamless multi-tab” on plain HTTP LAN in docs.

### Smallest viable correction (recommended follow-up, not on tip unless owner asks)

Same-origin `BroadcastChannel('ts6-auth-refresh')` to publish the winning access/refresh pair so followers adopt without a second POST when locks are unavailable. BroadcastChannel is available in insecure contexts (proven above). Keep consumed-row retention and family revoke server semantics unchanged. Avoid localStorage spinlocks.

## Remaining JWT / WebSocket limits (unchanged by P1-A/B)

- Access JWTs remain bearer tokens until expiry; WebSocket auth is not re-checked on every refresh rotation mid-connection.
- Logout / password change / admin disable revoke refresh rows; an already-accepted WebSocket may continue until disconnect or access JWT expiry depending on existing gateway checks.
- `authTestHooks` exist only on `app.locals` for deterministic tests and are never bound to request body, query, or env toggles from untrusted input.
- Frontend `__ts6AuthTest` requires `localStorage ts6-e2e-hooks=1` before module load (Playwright only).
