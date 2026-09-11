# Agent notes (ts6-manager)

## Releases (Release Please)

This repo uses [Release Please](https://github.com/googleapis/release-please) on pushes to `main`.

| File | Role |
|------|------|
| `.github/workflows/release-please.yml` | Runs Release Please on `main`; publishes GHCR images when a release is created |
| `release-please-config.json` | Release type + files to bump |
| `.release-please-manifest.json` | Last released version |
| `version.txt` | Simple releaser version source |
| `packages/*/package.json` | App package versions (`$.version`, via `extra-files`) |
| `packages/frontend/src/lib/app-version.ts` | UI fallback version (`// x-release-please-version`) |
| `CHANGELOG.md` | Generated / updated by Release Please |
| `.github/workflows/publish-images.yml` | GHCR publish on `main` / `v*` tags / Release Please `workflow_call` |

### Normal flow (agents + humans)

1. Open a **feature PR** into `main` with [Conventional Commits](https://www.conventionalcommits.org/) in the **merge commit or squashed commit message** (GitHub squash uses the PR title by default — set it carefully).
2. Merge the feature PR.
3. Release Please opens a **release PR** that bumps versions + `CHANGELOG.md`.
4. Merge the release PR → GitHub creates tag `vX.Y.Z` and the GitHub Release; the Release Please workflow then publishes matching GHCR images.

Commit prefixes that matter:

| Prefix | SemVer effect |
|--------|----------------|
| `fix:` | patch (`1.4.0` → `1.4.1`) |
| `feat:` | minor (`1.4.0` → `1.5.0`) |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` | major (`1.4.0` → `2.0.0`) |
| `chore:`, `docs:`, `ci:`, `test:` | no release by themselves |

Do **not** hand-edit package versions, `version.txt`, or `app-version.ts` on feature PRs unless bootstrapping Release Please. Let the release PR own bumps.

The UI label (`TS6 WEBUI v…`) still comes from `packages/frontend/package.json` via Vite (`__APP_VERSION__`) plus optional git sha (`__GIT_SHA__`). Release Please keeps that package version in sync with `app-version.ts`.

### Target a specific version (`Release-As`)

To force the **next** release to a chosen SemVer, put this in the **commit body** that lands on `main` (squash commit message or a follow-up commit):

```text
feat: short summary of the change

Optional longer description.

Release-As: 1.4.1
```

Rules for agents:

- Put `Release-As: X.Y.Z` in the **body**, not only the subject line.
- Use it when the user asks to release as a specific version, or when conventional commits would bump the wrong SemVer level.
- After that commit is on `main`, Release Please opens (or updates) a release PR **for exactly that version**.
- Do **not** leave a permanent `"release-as": "..."` in `release-please-config.json` — it would keep re-targeting that version. Prefer the commit footer.
- Empty commit on `main` (maintainers only) also works:

```bash
git commit --allow-empty -m "chore: release 1.4.1" -m "Release-As: 1.4.1"
git push
```

### PR title / squash message checklist

When opening or merging a PR that should release:

1. Confirm desired SemVer with the user if unclear (`patch` vs `minor` vs exact `Release-As`).
2. Set squash title to a conventional commit (`feat: …` / `fix: …`).
3. If targeting an exact version, include `Release-As: X.Y.Z` in the squash commit body.
4. Do not create GitHub releases/tags manually unless the user asks or Release Please cannot run — Release Please does that when the **release PR** merges.
5. If a release PR did not appear after merge: re-run the **Release Please** workflow on `main`, or ask a maintainer to retry the failed run.

### CHANGELOG notes

Release Please owns versioned sections in [`CHANGELOG.md`](CHANGELOG.md). Prefer conventional-commit subjects that read well in the generated notes. For intentional end-user behavior changes that are not a major bump, call that out in the PR description so reviewers can adjust the release PR notes if needed.

### Checklist (agents / maintainers)

- [ ] Feature PR uses a conventional commit title (and `Release-As` in the body when forcing a version)
- [ ] Do **not** hand-bump versions on the feature PR
- [ ] After merge: wait for / merge the Release Please release PR
- [ ] Confirm tag `vX.Y.Z`, GitHub Release, and GHCR image publish from the Release Please workflow
