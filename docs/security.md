# Security

TS6 Manager includes application and container controls intended to keep administrative TeamSpeak access scoped and auditable.

## Accounts and authorization

- The first administrator is created through setup; there are no default credentials.
- Roles include administrator and viewer.
- Per-server access controls restrict which configured TeamSpeak servers a user may access.
- Flow CRUD, execution history, sensitive settings, and other administrative operations are administrator-only.

## Stored credentials

WebQuery API keys and SSH passwords are encrypted before they are written to SQLite.

Production requires a stable `ENCRYPTION_KEY`. Do not rotate it casually: previously stored secrets cannot be decrypted with a different key.

Secret fields are not populated back into edit forms. Leaving a secret field blank preserves the stored encrypted value.

## Authentication

The backend uses JWT access tokens plus refresh-token rotation with reuse detection. Authentication endpoints are rate-limited and password complexity rules apply.

WebSocket connections require application authentication and are scoped to the servers the user may access.

## Outbound requests

HTTP automation actions and FFmpeg/media URL paths include SSRF protections. Bot flows do not provide an unrestricted WebQuery escape hatch: raw WebQuery actions use an allowlist.

Do not design deployments or automations around bypassing these checks.

## Media sidecar

The sidecar mutating API is authenticated with `SIDECAR_SECRET`.

The standard compose file keeps sidecar port 9800 internal. The all-in-one image keeps it on loopback. Do not expose it publicly.

## Runtime image hardening

Production Node images omit npm, npx, pnpm, Corepack, and esbuild build tooling.

CI rebuilds all release images and scans them with Trivy. The release gate fails when a HIGH or CRITICAL finding has an available fix. Unfixed findings remain visible in the full scan inventory rather than being hidden by ignore rules.

## TeamSpeak Query

TS6 Manager requires authenticated WebQuery and optional authenticated SSH Query. It does not need beta13 guest Query access.

Restrict TeamSpeak Query ports to trusted management networks and see [TeamSpeak compatibility](teamspeak-compatibility.md) for beta13 settings.
