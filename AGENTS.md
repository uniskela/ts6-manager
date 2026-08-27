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

## Releases & tags

Every merged version-bump PR that ships user-facing work should be cut as a **semver release** (not only large milestones). Package versions, CHANGELOG, git tag, and GitHub Release must agree.

### CHANGELOG (same PR as the version bump)

1. Move this release’s items out of `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md) into:

   `## [X.Y.Z] - YYYY-MM-DD`

2. Use Keep a Changelog–style sections **in this order when present**:
   - **Breaking Changes** — required for any major bump; describe behavior users must adapt to
   - **Added**
   - **Changed**
   - **Fixed**
   - **Security**
   - **Removed**

3. Prefer **major** for incompatible API, schema, or operator-facing breaks. If a **minor** intentionally changes end-user behavior (for example chat reply destination), still list it under **Breaking Changes** and call it out in the PR — do not bury it under Changed only.

4. The CHANGELOG heading version (`X.Y.Z`) must match the three `package.json` versions and `app-version.ts` (no leading `v` in the heading).

### Tag & GitHub Release (after merge to `main`)

1. Tag format: annotated git tag **`vX.Y.Z`** (leading `v`) on the merge commit on `main`, matching package versions (`v1.3.0` ↔ `1.3.0`).
2. Create a **GitHub Release** for that tag:
   - Title: `vX.Y.Z`
   - Body: the CHANGELOG section for `X.Y.Z` (Breaking / Added / Changed / …)
3. Prefer tagging **after** the version-bump PR merges so the release SHA is what ships.
4. Pushing a `v*` tag triggers [`.github/workflows/publish-images.yml`](.github/workflows/publish-images.yml), which publishes GHCR images with semver tags (`{{version}}`, `{{major}}.{{minor}}`).

### Checklist (agents / maintainers)

- [ ] Version bumped in frontend / backend / common `package.json` + `app-version.ts`
- [ ] `CHANGELOG.md` has `## [X.Y.Z] - date` with the right sections (including **Breaking Changes** when applicable)
- [ ] PR title/body mentions `bump vX.Y.Z`
- [ ] After merge: annotated tag `vX.Y.Z` on `main` + GitHub Release notes from CHANGELOG
