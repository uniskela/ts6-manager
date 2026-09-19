# Opinionated TS6 Manager Fork Roadmap

Continuation of `clusterzx/ts6-manager` as `uniskela/ts6-manager` — **core-focused** (no Discord/SSO/full i18n absorption).

Community bug reports and PRs that informed this work are listed in [CREDITS.md](../../CREDITS.md).

## Implemented phases

1. **Security baseline** — `expr-eval-fork`, dependency bumps, sidecar `SIDECAR_SECRET` auth, internal-only `:9800`, SSRF DNS fail-closed, required `ENCRYPTION_KEY` in production, LICENSE/SECURITY, fork rebrand, password UI alignment.
2. **Reliability** — BBCode URL strip, unknown escape tolerance, WebQuery test errors, auto-rank persistence, SSH reconnect on edit, music bot delete/clear-queue fixes, connection pool tear-down on refresh.
3. **Core QoL** — library filesystem scan, bot ID badges, server group membership UI, Spotify→YouTube resolve, AFK exempt channels, offline client permissions + modified-only filter, metadata encoding helpers, radio ID compact, `command_args_list`, safer temp-channel template, yt-dlp freshness via image rebuilds (no runtime self-update).
4. **Video / restart reliability (v1.4.0)** — shared music volume for sidecar, non-looping on-demand clips + auto-stop, A/V sync clamp, multi-thread VP8 encode tuning, awaited SSH teardown, ServerQuery visibility in Channels, stream API timeouts (from [DomeNinchen/ts6forkmanager](https://github.com/DomeNinchen/ts6forkmanager)).
5. **Music-bot transport / memory reliability (v1.5.0)** — resolve the TeamSpeak UDP target once per connection, stream local/downloaded PCM incrementally with bounded memory and FFmpeg real-time pacing, and prevent overlapping reconnect attempts (adapted from [bro-network/ts6-manager](https://github.com/bro-network/ts6-manager)).
6. **TeamSpeak beta13 / safer operations (v1.6.0)** — authenticated beta13 compatibility smoke testing, explicit guest-Query guidance, persistent per-flow temporary-channel ownership, playlist/repeat/seek/remove chat controls, bounded yt-dlp download progress, queue/shuffle correctness, production-runtime pruning, and a four-image Trivy release gate that blocks fixable HIGH/CRITICAL findings.

The yt-dlp HTTP-header transport subset evaluated in fork PR #45 was **reverted before the v1.5.0 release** and is not part of the current release-candidate scope. Revisit it only as a fresh, current-main change if runtime evidence still shows temporary YouTube media URLs failing because FFmpeg lacks yt-dlp-selected headers.

## Backlog after v1.6.0

Do **not** fold these into opportunistic drive-by PRs; schedule them as dedicated follow-ups.

### Framework modernization (separate epic)

- React 19, Vite 8, Tailwind 4, React Router 8, TypeScript 7, Express 5, Prisma 7, Node 24, `@tanstack/react-table` v9
- One major bump series at a time with container verification per bump
- Move the workspace to a newer pnpm major only as an explicit migration, including override/build-script policy updates; CI currently targets pnpm 9

### CI / deps hygiene

- Keep the container-security release gate current as base images and Trivy evolve
- Dependabot enablement beyond what’s already open
- Frontend dead-dep cleanup (`zod` / `react-hook-form` if still unused)
- Keep release publishing release-only: ordinary `main` pushes must not publish GHCR images

### Music / voice follow-ups

- Runtime smoke-test hostname-backed music-bot connections over several minutes after voice transport changes
- Exercise long-track RSS, pause/resume, seek, repeat, queue-next, skip, stop, and downloaded-track playback under the bounded-memory path
- Re-evaluate the reverted yt-dlp → FFmpeg header-preservation change only against current `main`, with regression tests and a real YouTube runtime case that justifies it

### Do not adopt (security / scope regressions)

- Publishing sidecar `:9800` to the host
- Dropping `SIDECAR_SECRET` or softening required `ENCRYPTION_KEY`
- Upstream [#55](https://github.com/clusterzx/ts6-manager/issues/55) scheduled container restart (we don’t manage TS containers)
- SSO ([#71](https://github.com/clusterzx/ts6-manager/issues/71)), Discord bridge ([#65](https://github.com/clusterzx/ts6-manager/issues/65)), PR [#76](https://github.com/clusterzx/ts6-manager/pull/76) suite — already excluded by this fork’s core focus

### Follow-up feature PRs

- Upstream [#82](https://github.com/clusterzx/ts6-manager/issues/82): verify image builds refresh yt-dlp; retest YouTube `!play` after video/timeout work
- Upstream [#53](https://github.com/clusterzx/ts6-manager/issues/53) / [#69](https://github.com/clusterzx/ts6-manager/issues/69): validate stream presets actually change delivered resolution after shared volume + encode tuning
- Upstream [#48](https://github.com/clusterzx/ts6-manager/issues/48): flow loop node (feature backlog)

See upstream issue/PR triage in the agent plan for additional skip notes.


## Beta13 / v1.6.0 ecosystem review (2026-09-19)

Reviewed current main and recent activity in uniskela (v1.5.2), clusterzx
(`dd26e57`), LgnRorooo (`4c734a6`), vibesoftwarecoder (`672d3b0`), KorppuJauho
(`c770824`), DomeNinchen/ts6-managerFork (`a728ab6`, now archived), and coom
(`83a0635`), plus the recent open upstream issue/PR list. Upstream #42 motivates
explicit channel ownership; #78 already has connection refresh here and receives
regression coverage. #79/#77/#66/#58/#70/#64 and coom playlist-import/cap features
already exist and are not reimported. LgnRorooo’s chat/progress ideas are selectively
adapted, with attribution in CREDITS. KorppuJauho’s encoder/H.264 experiments and
DomeNinchen’s CDN/startup-buffer work are outside this release.

Upstream [PR #83](https://github.com/clusterzx/ts6-manager/pull/83) adds bgutil
PO-token provider 2.0.0, pins an mweb extractor client, preserves media HTTP headers,
moves to Node 22, and switches playback to ephemeral direct-stream URLs. Its author
did not build the Linux container locally. PO-token generation may help the current
YouTube 403/extractor failures (#82/#84), including cached downloads, but effectiveness
in this fork has not been demonstrated. Evaluate it in a dedicated PR: compare
current client rotation/cookies with provider-assisted extraction, measure cold start
and token expiry, audit subprocess/network/header handling and licensing, test seek,
repeat, reconnect and cache behaviour, and retain SSRF/option-injection safeguards.
No provider installation, Node migration or playback replacement is included here.

Upstream #80 was assessed against this fork’s actual dependency graph and Trivy
results, not assumed to apply wholesale. See the release PR validation/security notes.
