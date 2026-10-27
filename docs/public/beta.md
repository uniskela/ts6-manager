# Beta releases

TS6 Manager publishes **stable** images from Release Please tags such as `v1.11.2`. A separate, maintainer-approved workflow can also publish **prerelease** images such as `v1.12.0-beta.1`. The two channels do not share moving aliases.

This page is for early testers and maintainers. It is not a production install guide. For ordinary deployments use [Installation](installation.md) and pin a stable tag.

TS6 Manager is an opinionated continuation of [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager). Beta images are from this fork only.

## What each channel is

| Channel | Example | Who publishes | Moving aliases |
|---|---|---|---|
| Stable | `v1.11.2` | Release Please after a release PR merges | `latest`, `1.11` |
| Manager prerelease | `v1.12.0-beta.1` | Maintainer dispatch of **Publish prerelease images** | none |
| Commit preview | `sha-abc1234` | Same workflow, SHA only | none |
| Discord bridge lab | local `d1-*` image | Not published | — |

The Discord voice bridge is a laboratory program, not a second product on this channel. See [Discord bridge](discord-bridge.md).

## Image tags

Replace `abc1234` with the short commit and `v1.12.0-beta.1` with the prerelease you were given.

### GitHub Container Registry (default)

| Image | Immutable commit | Prerelease |
|---|---|---|
| Backend | `ghcr.io/uniskela/ts6-manager/backend:sha-abc1234` | `ghcr.io/uniskela/ts6-manager/backend:v1.12.0-beta.1` |
| Frontend | `ghcr.io/uniskela/ts6-manager/frontend:sha-abc1234` | `ghcr.io/uniskela/ts6-manager/frontend:v1.12.0-beta.1` |
| Sidecar | `ghcr.io/uniskela/ts6-manager/sidecar:sha-abc1234` | `ghcr.io/uniskela/ts6-manager/sidecar:v1.12.0-beta.1` |
| All-in-one | `ghcr.io/uniskela/ts6-manager/all-in-one:sha-abc1234` | `ghcr.io/uniskela/ts6-manager/all-in-one:v1.12.0-beta.1` |

The workflow also writes the tag without the `v` prefix (`1.12.0-beta.1`). It does **not** write `latest`, `1.12`, or any other stable alias.

### Docker Hub (optional mirror)

When Hub credentials are configured, the same digests are mirrored. A failed mirror does not undo GHCR.

| Image | Immutable commit | Prerelease |
|---|---|---|
| Backend | `uniskela/ts6-manager:backend-sha-abc1234` | `uniskela/ts6-manager:backend-v1.12.0-beta.1` |
| Frontend | `uniskela/ts6-manager:frontend-sha-abc1234` | `uniskela/ts6-manager:frontend-v1.12.0-beta.1` |
| Sidecar | `uniskela/ts6-manager:sidecar-sha-abc1234` | `uniskela/ts6-manager:sidecar-v1.12.0-beta.1` |
| All-in-one | `uniskela/ts6-manager:all-in-one-sha-abc1234` | `uniskela/ts6-manager:all-in-one-v1.12.0-beta.1` |

Hub's `backend` / `frontend` / `sidecar` / `all-in-one` tags stay on the latest **stable** release.

Each image has `org.opencontainers.image.revision` set to the full commit SHA.

## Tester install

Use `docker-compose.beta.yml` at the repository root (on `main`). The file sets Compose project `ts6-beta` and named volumes `ts6-beta-backend-data` / `ts6-beta-music-data`, so it can sit next to a stable stack in the same directory without sharing data. Do not invent a compose file or rename the laboratory image.

1. Create a `.env.beta` with new secrets. Do not reuse production secrets or the stable stack's `.env`. Keep `.env.beta` private, mode `600`, and Git-ignored (the repository ignores `.env.beta`).

~~~bash
umask 077
echo "TS6_BETA_TAG=v1.12.0-beta.1" >> .env.beta
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env.beta
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env.beta
echo "SIDECAR_SECRET=$(openssl rand -base64 32)" >> .env.beta
chmod 600 .env.beta
~~~

2. Start and stop the stack yourself. Always pass `--env-file .env.beta`. Compose sets `restart: "no"`. The UI is `http://127.0.0.1:13000`. The backend API stays on the Docker network and is not published on the host.

~~~bash
docker compose --env-file .env.beta -f docker-compose.beta.yml up -d
docker compose --env-file .env.beta -f docker-compose.beta.yml ps
# UI is http://127.0.0.1:13000 — loopback only, not port 3000
docker compose --env-file .env.beta -f docker-compose.beta.yml down
~~~

3. Connect only a disposable or dedicated non-production TeamSpeak server.

4. Keep logs on the host. The compose file caps each container at three 10 MiB files. Do not attach raw logs, `.env.beta`, `.env`, or tokens to issues or pull requests.

### All-in-one

The same `TS6_BETA_TAG` works on the all-in-one image if you copy `docker-compose.all-in-one.yml` and replace `:latest` with that tag. Prefer the beta compose file: it binds the UI to loopback and does not restart on its own.

## Staging for multi-day tests

Run beta on a separate host or compose project from production.

- **TeamSpeak:** a throwaway virtual server or a dedicated non-production instance. Do not point beta at the production server.
- **Discord:** if you later test the laboratory bridge, use a private testing guild and the smallest bot permissions the lab README lists. That program is not part of this compose file.
- **Access:** the only published port is the UI on `127.0.0.1:13000`. Reach it over an existing private path if you need another machine. Do not publish the backend.
- **Resources:** the example limits memory and CPU. Raise them only if the host is dedicated to the test.
- **Health:** backend `/api/health` (through the UI origin) and sidecar `/health` on the internal network. Record counters you already have (connections, bot state, diagnostics). Do not export secrets.
- **Control:** start and stop with compose. After a crash, `docker compose --env-file .env.beta -f docker-compose.beta.yml up -d` is a manual recovery, not an invitation to `unless-stopped`.

### Recovery to verify before unattended operation

Do not leave a beta stack running unattended until you have watched all of these on the staging host:

1. Backend restart with the same `ENCRYPTION_KEY` still decrypts stored TeamSpeak credentials.
2. Sidecar restart reconnects media without publishing port 9800.
3. TeamSpeak Query drop and return (WebQuery, and SSH Query if you use it) recovers without a second database.
4. Host reboot: with `restart: "no"` the stack stays down until you start it. That is intentional.
5. Disk-full and log rotation: the 10 MiB cap must not fill the volume; if it does, the process must fail closed rather than write secrets elsewhere.
6. Image roll-forward and rollback (below) on a copy of the staging database.

Until those are recorded, treat multi-day runs as operator-attended.

## Rollback

Beta schemas may not load in an older image. Back up the SQLite volume before every tag change.

~~~bash
docker compose --env-file .env.beta -f docker-compose.beta.yml down
# copy the ts6-beta-backend-data volume, then edit TS6_BETA_TAG in .env.beta:
#   TS6_BETA_TAG=v1.11.2   # last known stable, or
#   TS6_BETA_TAG=sha-oldid # previous prerelease commit
docker compose --env-file .env.beta -f docker-compose.beta.yml up -d
~~~

If the newer image applied a schema the older image refuses, restore the volume backup taken on the older tag. Do not point a stable production compose file at a beta volume.

Stable production stays on `docker-compose.yml` and `v1.11.2` / `latest`. Changing those files is not a rollback of beta.

## Maintainer publish path

The **Publish prerelease images** workflow is `workflow_dispatch` only. It does not run on pull requests.

1. Open **Actions → Publish prerelease images**.
2. Set `ref` to a 40-character commit SHA, or to an existing `vX.Y.Z-(alpha|beta|rc).N` tag. The commit must be reachable from `main` (or from an explicitly named, protected `release/*` branch via `source_branch`). Unreviewed pull-request commits are rejected.
3. Optionally set `prerelease_tag` (`v1.12.0-beta.1`) when `ref` is a SHA. If that git tag or GHCR version already exists for a **different** commit, the workflow fails. Republishing the same commit is allowed.
4. Leave `create_github_prerelease` off unless you intend a public GitHub prerelease. If you turn it on, the notes mark the release as prerelease and list unsupported features. An existing tag that points at another commit is refused, not reused.
5. Approve the `prerelease` environment (required reviewers). Untrusted pull request code never sees package-publish credentials.

The workflow then runs the full PR validation suite (typecheck, tests, native sidecar smoke), the container security / Trivy gate, builds on the requested SHA, pushes GHCR, and optionally mirrors to Docker Hub.

It refuses stable `vX.Y.Z` tags. Those stay on [publish-images.yml](https://github.com/uniskela/ts6-manager/blob/main/.github/workflows/publish-images.yml).

## Documentation versions

After this page merges to `main`, [uniskela/com](https://github.com/uniskela/com) can import it on **Next** (`/docs/ts6-manager/next/beta/`). The stable 1.11 site (`/docs/ts6-manager/1.11/` and `/docs/ts6-manager/latest/`) stays on the last 1.11 release snapshot. Do not run a 1.11 docs correction to add this page.

Until then, read the file in the pull request on GitHub.

## GO / NO-GO for a public beta

Publish a **public** GitHub prerelease and tester announcement only when every line is GO. This checklist is not a substitute for a later approval.

| Item | GO | Current |
|---|---|---|
| Prerelease workflow merged and environment reviewers set | Workflow exists on `main`; `prerelease` requires a maintainer | Draft PR only |
| Requested SHA is in this repo and green on the workflow gates | Typecheck, complete tests, sidecar smoke, Trivy | Not run for a public tag |
| Images exist on GHCR with `sha-*` and the prerelease tag; OCI revision matches the SHA | `docker buildx imagetools inspect` | Not published |
| Stable `latest` / `1.11` / Hub unsuffixed tags unchanged | Inspect those tags before and after | Not published |
| Tester compose uses project `ts6-beta`, isolated volumes, UI on `127.0.0.1:13000`, no auto-restart, secrets from `.env.beta` | `docker-compose.beta.yml` on `main` | Merged |
| Staging TeamSpeak is non-production; no production host is used | Operator confirms | Not started |
| Recovery list above recorded | Six checks written down | Not started |
| GitHub release marked prerelease; unsupported features listed | Workflow notes | Off by default |
| Discord bridge is **not** advertised as a published image | [Discord bridge](discord-bridge.md) | NO-GO for a registry preview |
| No tokens, guild ids, private TeamSpeak addresses, or raw logs in the release | Review notes and artifacts | — |

**Public beta is NO-GO.** Tester compose is on `main`. The publishing workflow is still a draft PR. No prerelease images have been published, no dispatch is authorized here, and a public tester announcement is not approved.

## Security verification (workflow)

The publishing path reuses:

- [PR validation](https://github.com/uniskela/ts6-manager/blob/main/.github/workflows/pr-validation.yml) — hygiene, typecheck, frontend/backend tests, media-cache on Windows/macOS, Go sidecar race tests and native cross-compile
- [Container security](https://github.com/uniskela/ts6-manager/blob/main/.github/workflows/container-security.yml) — rebuild all four images, runtime smoke, Trivy HIGH/CRITICAL gate

Those jobs check out the requested SHA. Pull request branches cannot supply the Dockerfile that gets published. Results live in the Actions run; do not attach Trivy JSON or container logs to a public issue.
