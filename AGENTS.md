# Agent notes (ts6-manager)

## Releases (Release Please)

This repo uses [Release Please](https://github.com/googleapis/release-please) on pushes to `main`.

| File | Role |
|------|------|
| `.github/workflows/release-please.yml` | Runs Release Please on `main`; publishes GHCR images only after Release Please creates a release |
| `release-please-config.json` | Release type + files to bump |
| `.release-please-manifest.json` | Last released version |
| `version.txt` | Simple releaser version source |
| `packages/*/package.json` | App package versions (`$.version`, via `extra-files`) |
| `packages/frontend/src/lib/app-version.ts` | UI fallback version (`// x-release-please-version`) |
| `CHANGELOG.md` | Generated / updated by Release Please, with final human curation before merge when needed |
| `.github/workflows/publish-images.yml` | Reusable GHCR workflow invoked only for an immutable `vX.Y.Z` release; also supports manual recovery for an existing release tag |

Ordinary pushes and PR merges to `main` must **not** publish container images. Image publication is tied to a created GitHub Release so `latest`, semver tags, and SHA tags all point at a deliberate release.

### Normal flow (agents + humans)

1. Open a **feature PR** into `main` with [Conventional Commits](https://www.conventionalcommits.org/) in the **merge commit or squashed commit message** (GitHub squash uses the PR title by default — set it carefully).
2. Merge the feature PR.
3. Release Please opens or updates a **release PR** that bumps versions + `CHANGELOG.md`.
4. Finish all intended pre-release feature/docs PRs before doing final release-note curation; another push to `main` may refresh the release PR.
5. Review the release PR against the **net state of current `main`**:
   - remove entries for work that was merged and later reverted;
   - collapse duplicate bullets that describe the same user-facing change;
   - keep notes focused on shipped behavior, not every intermediate implementation commit.
6. Merge the release PR → GitHub creates tag `vX.Y.Z` and the GitHub Release; the Release Please workflow then invokes `publish-images.yml` for that exact tag.
7. Confirm the tag, GitHub Release, and all expected GHCR tags were published from the release commit.

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

Release Please owns versioned sections in [`CHANGELOG.md`](CHANGELOG.md). Prefer conventional-commit subjects that read well in the generated notes.

Before merging a release PR, treat its generated changelog as a draft rather than unquestionable truth. Merge-heavy history can surface both an implementation commit and a later merge commit as separate bullets, and a merged-then-reverted change can still appear in generated notes. Compare the release section with current `main`, then curate the release branch so the final `CHANGELOG.md` and PR body describe only what the tag will actually ship.

Do this **after** the last intended pre-release PR has landed, because a subsequent Release Please refresh may overwrite manual release-branch edits.

### Local JavaScript toolchain

CI uses Node.js 20 and pnpm 9. Local verification should stay on pnpm 9 until the workspace is deliberately migrated to a newer pnpm major.

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm db:generate
```

Newer pnpm majors change dependency build-script approval and `pnpm.overrides` handling; do not treat a failure caused only by running an unsupported pnpm major as an application regression.

### Dependabot npm group PRs

If CI fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, close the PR without merge. Dependabot’s regenerated lockfile often drops `pnpm.overrides` while `package.json` still has them (same class as #89/#95/#103). Do **not** relax `pnpm install --frozen-lockfile`. Recreate wanted bumps on a human branch with `pnpm install` (pnpm 9) so overrides remain in the lockfile. Major-ignore / minor-patch grouping (`dependabot.yml`) does not fix overrides stripping.

### Checklist (agents / maintainers)

- [ ] Feature PR uses a conventional commit title (and `Release-As` in the body when forcing a version)
- [ ] Do **not** hand-bump versions on the feature PR
- [ ] After merge: wait for / review the Release Please release PR
- [ ] Compare generated notes with current `main`; remove reverted entries and duplicate descriptions
- [ ] Merge the release PR only after its changelog matches shipped behavior
- [ ] Confirm tag `vX.Y.Z`, GitHub Release, and GHCR image publish from the Release Please workflow

<!-- adhd-hub:project-agent:start -->
<!-- adhd-hub:guidance-version:5 -->
## ADHD Hub continuity

For substantial work in this project:

- If ADHD Hub MCP tools are missing, errored, unauthorized, or otherwise
  unavailable: on the first substantial Hub-worthy turn after detecting the
  outage, the **first line** MUST state that Hub MCP is not available, plus a
  short fix hint (MCP URL → this Hub's `/mcp`, `ADHD_HUB_AUTH_TOKEN`, restart
  the agent; skip/cancel Auth if it hangs until Hub OAuth is enabled). Repeat
  only if Hub status changes, a persistence attempt fails again, or the reply
  could otherwise imply continuity was saved. Then continue the authorized
  work. Never invent Hub state or claim a Hub write succeeded.
- **MCP unavailable** is the Hub continuity trigger (not runtime alone). Use
  the `env-check` skill / `skills/env-check/scripts/check_runtime.sh` for
  CLOUD_AGENT vs LOCAL_WORKSPACE as supporting context (`CURSOR_AGENT`,
  container cues — never `$USER=root` alone). When Hub MCP is unreachable,
  use the forge issue mailbox only when issue-write access is available and
  the authenticated identity is accepted by Hub Inbox authors. Open/update a
  GitHub/Gitea issue titled `[ADHD] …` with a short Goal/Focus/Next/Resume
  cue. Optional labels: `adhd-hub`, `project:<slug>`, `source:cursor`; skip
  labels if the token cannot set them. Recommended: append
  `Made with [ADHD Progress Hub](https://github.com/uniskela/adhd-hub)` under
  a non-imported heading (e.g. `## Attribution`) so it does not land in Resume.
  Prefer short repository-relative summaries; never invent Hub continuity,
  progress, or thread state after a forge-only write.
- CLOUD_AGENT: do not assume machine-installed local skill CLIs (e.g.
  `graphify`) exist. If missing: one-line notice, continue via repo tools /
  committed `graphify-out/` when present; never fabricate graph or Hub state.
  Prefer headless tests and injected env/OIDC over `.env.local`; no native
  browser/macOS-Windows binaries. Hub MCP down still uses the `[ADHD]` forge
  mailbox when allowed. LOCAL_WORKSPACE: those local CLIs may be available;
  local docker / localhost OK; prefer Hub MCP when up.
- Skip Hub for trivial/read-only/tiny work.
- Once per meaningful session: `resolve_project`, then `session_digest` with
  the task query. Reuse resolved context where possible.
- **One thread = one independently finishable outcome** (not the whole repo).
  Before updating a thread, compare new work to that thread's Goal; if it does
  not advance the same outcome, use another thread or create one.
- Known thread → `upsert_progress(thread_id=...)` with compact structured state
  (goal / focus / ≤3 next / blocked if any / resume); omit ritual `content`.
  Do not silently attach to an unrelated open thread.
- `check_overlap` only before potentially new work; reuse only when the Goal
  matches. Different goal → separate thread (`force_new_thread` if needed).
- When leaving mid-task, checkpoint then `pause_thread(thread_id, next_step=...)`
  with one concrete resume action. `mark_done` only the known completed thread
  — never close unrelated overlap results.
- If Hub guidance looks stale (session_digest guidance status, or doctor),
  mention it once, keep using the current MCP contract, and recommend
  `adhd-hub setup . --refresh` — do not nag repeatedly or hand-edit AGENTS.md.
- Summaries only; never secrets, credentials, env files, transcripts, private
  Hub URLs, internal hosts/IPs, or absolute machine paths in public artifacts.
<!-- adhd-hub:project-agent:end -->
