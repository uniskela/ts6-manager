# P1-B cross-tab refresh coordination — limitations

Status: local security gate evidence (not a public release note).

## Product principle

Basic LAN deployment must stay easy: no mandatory HTTPS, reverse proxies, custom domains, VPNs, or external auth gateways for day-to-day use. Security coordination should engage automatically.

The same principle applies to future native TOTP (guided account-security page + QR + recovery codes) and passkeys (offered when the origin is a supported secure context, without blocking password login on LAN HTTP). Advanced reverse-proxy / external MFA setups remain optional documentation, not prerequisites.

## Secure-context / Web Lock matrix (Chromium evidence)

| Origin class | Example | `isSecureContext` | `navigator.locks` | `BroadcastChannel` |
|---|---|---|---|---|
| Loopback HTTP | `http://127.0.0.1`, `http://localhost` | yes | yes | yes |
| HTTPS | reverse-proxy / TLS | yes | yes | yes |
| LAN / private HTTP | `http://192.168.x.x`, `http://lan.ts6.test` | **no** | **no** | yes |

## What works

### Secure context + `navigator.locks`

1. Refresh serializes on `ts6-auth-refresh`.
2. After lock acquire, re-read zustand persist; adopt peer pair when refresh token changed and access still fresh.
3. Server replay detection unchanged.

### No Web Lock + `BroadcastChannel` (`auth-refresh-coord.ts`)

1. Short claim window elects one refresher (lexicographically smallest tab id).
2. Winner announces `leader` **before** the network POST; followers wait for a bounded `result` (or time out and retry once).
3. Logout broadcasts so peer tabs clear credentials without restoring revoked refresh tokens.
4. Tokens travel only on the same-origin BroadcastChannel (not URLs, logs, or cross-origin).

Server-side consumed-token replay / family revoke remains authoritative.

## Measured HTTP LAN evidence (Chromium, `lan.ts6.test` insecure origin)

- Caps: `isSecureContext=false`, no `navigator.locks`, `BroadcastChannel` present.
- 2-tab / 3-tab concurrent refresh: single rotation, no family revoke.
- Close-tab / slow-leader / reload-during-refresh / logout sync covered in Playwright.
- 40-trial concurrent refresh: `revokeHits=0`, `singleWinner=40` (prior no-BC baseline ≈6/8 revokes).
- Genuine consumed-token replay still revokes the family.

## Residual risks

- BroadcastChannel is not a mutex: extreme scheduling can still dual-POST; loser must not wipe peer persist (`runRefresh` 401 path adopts peer tokens with a short persist re-read). Residual dual-POST under pathological miss remains possible but was not observed in 40 LAN trials.
- Successful `result` messages carry access/refresh tokens on the **same-origin** channel so followers beat zustand persist lag. Not URLs, logs, or cross-origin. Equivalent XSS surface to `localStorage` `ts6-auth`.
- Logout (local or peer BC) and `setAuth` session replace (`ts6-auth-session`) clear `lastGoodResult` / leader / waiters (pending waiters get `ok:false`) so a later login cannot adopt a prior account’s cached pair. Same-account refresh via `setTokens` does not clear.
- Access JWTs / established WebSockets are not torn down by refresh revoke (unchanged).
- `__ts6AuthTest` requires `localStorage ts6-e2e-hooks=1` before module load; backend `authTestHooks` are test-injected only. Not enabled for ordinary production users.
- Frontend adopt/401 recovery also requires matching JWT `id` on the persisted access token vs the in-flight tab’s expected access token, so a peer login that rewrites `ts6-auth` without notifying this tab cannot be adopted via epoch-alone checks.

## Server: post-commit R0 vs genuine replay (Kody finding #1)

Under the current opaque-refresh protocol, a second POST that presents already-consumed `R0` after `R0→R1` has committed is **wire-identical** to attacker replay: both see `replacedBy` set and take the pre-transaction family-revoke path. SQLite proof: `post-commit second presenter of R0 gets 401, family-revokes, and R1 is unusable` in `auth.refresh-rotation.sqlite.test.ts`. Pre-commit dual-POST still uses in-transaction CAS (`updateMany` count 0 → 401 **without** family revoke).

**Trade-off (no grace period without explicit review):** prefer false-positive family revoke (benign late dual-POST logs both tabs out) over missing replay detection (stolen `R0` must kill `R1`). Frontend Web Lock + BroadcastChannel is the primary dual-POST mitigator.

**Smallest defensible options (not implemented here):**

1. Keep current revoke-on-`replacedBy` (default; security-biased; document residual).
2. Add `consumedAt` + grace window so “fresh” losers 401 without revoke — weakens replay until grace elapses; needs explicit security review.
3. Protocol change (e.g. sender-bound refresh / DPoP-style) so concurrent losers are distinguishable from theft — larger redesign.

## Safe merge order (two PRs)

1. **PR1 — P1-A** admin password-reset / disable refresh revoke.
2. **PR2 — P1-B + frontend** atomic rotation, family-scoped replay, password concurrency, Web Lock + BroadcastChannel (depends on PR1).

Do **not** land P1-B server alone ahead of the frontend coordination. Merges to `main` run CI/Release Please bookkeeping only; **images publish only when Release Please creates a release** (`release_created`), not on ordinary feature merges.
