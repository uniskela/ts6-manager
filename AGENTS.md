# Agent notes (ts6-manager)

## App version (semver) on change PRs

For every **user-facing or shippable** change PR (features, bug fixes, security hardening, connection/reliability fixes), bump the displayed app version:

1. Increment **patch** (`1.1.x`) for fixes/hardening; **minor** for notable features; **major** only for breaking changes.
2. Keep these in sync on the same commit:
   - `packages/frontend/package.json` → `"version"`
   - `packages/backend/package.json` → `"version"`
   - `packages/common/package.json` → `"version"`
   - `packages/frontend/src/lib/app-version.ts` → fallback string next to `__APP_VERSION__`
3. The UI label (`TS6 WEBUI v…`) is built from `packages/frontend/package.json` via Vite (`__APP_VERSION__`) plus optional git sha (`__GIT_SHA__`). Bumping package.json is what updates the login/sidebar version after rebuild.
4. If multiple open PRs each bump versions, use **distinct** versions (e.g. `1.1.3` then `1.1.4`) so merges do not collide; rebase the later PR after the earlier one merges if needed.
5. Skip version bumps for docs-only, CI-only, or pure dependency noise unless the PR is intentionally a release.

Mention the new version in the PR title or body (e.g. `bump v1.1.3`).
