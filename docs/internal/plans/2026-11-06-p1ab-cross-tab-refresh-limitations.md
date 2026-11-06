# P1-B cross-tab refresh coordination — limitations

Status: local security gate evidence (not a public release note).

## What works (Chromium + `navigator.locks`)

Across two same-origin pages sharing one browser storage partition:

1. Refresh is serialized on the `ts6-auth-refresh` Web Lock.
2. After the lock is acquired, the client re-reads zustand persist (`ts6-auth`) so a peer tab’s rotation is visible before the network call.
3. If persist already holds a newer refresh token **and** a still-valid access token, the waiting tab adopts that pair and does **not** perform another rotation.
4. Consumed-token replay still revokes the refresh family on the server; the frontend does not weaken that check.

## No-Web-Lock fallback

When `navigator.locks` is missing, the client still prefers the persisted refresh token over in-memory state. That re-read is **not** atomic coordination:

- Two tabs can both observe the same live refresh token and both POST `/api/auth/refresh`.
- The server correctly treats the second presentation as reuse and revokes the family.
- Result: a legitimate multi-tab session can be logged out on browsers without Web Locks.

Do **not** soften server-side replay detection to paper over this race.

### Smallest viable correction (proposed, not implemented here)

1. Prefer requiring Web Locks for multi-tab sessions (supported in current Chromium/Firefox/Safari desktop targets for this app), and
2. Add a same-origin `BroadcastChannel('ts6-auth-refresh')` leader election that publishes the winning token pair so followers adopt without a second POST when locks are unavailable.

Either change is frontend-only; keep consumed-row retention and family revoke server semantics unchanged.

## Remaining JWT / WebSocket limits (unchanged by P1-A/B)

- Access JWTs remain bearer tokens until expiry; WebSocket auth is not re-checked on every refresh rotation mid-connection.
- Logout / password change / admin disable revoke refresh rows; an already-accepted WebSocket may continue until disconnect or access JWT expiry depending on existing gateway checks.
- `authTestHooks` exist only on `app.locals` for deterministic tests and are never bound to request body, query, or env toggles from untrusted input.
