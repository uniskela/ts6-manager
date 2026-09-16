# Opinionated TS6 Manager Fork Roadmap

Continuation of `clusterzx/ts6-manager` as `uniskela/ts6-manager` — **core-focused** (no Discord/SSO/full i18n absorption).

Community bug reports and PRs that informed this work are listed in [CREDITS.md](../../CREDITS.md).

## Completed phases

1. **Security baseline** — `expr-eval-fork`, dependency bumps, sidecar `SIDECAR_SECRET` auth, internal-only `:9800`, SSRF DNS fail-closed, required `ENCRYPTION_KEY` in production, LICENSE/SECURITY, fork rebrand, password UI alignment.
2. **Reliability** — BBCode URL strip, unknown escape tolerance, WebQuery test errors, auto-rank persistence, SSH reconnect on edit, music bot delete/clear-queue fixes, connection pool tear-down on refresh.
3. **Core QoL** — library filesystem scan, bot ID badges, server group membership UI, Spotify→YouTube resolve, AFK exempt channels, offline client permissions + modified-only filter, metadata encoding helpers, radio ID compact, `command_args_list`, safer temp-channel template, yt-dlp auto-update on startup.
4. **Video / restart reliability (v1.4.0)** — shared music volume for sidecar, non-looping on-demand clips + auto-stop, A/V sync clamp, multi-thread VP8 encode tuning, awaited SSH teardown, ServerQuery visibility in Channels, stream API timeouts (from [DomeNinchen/ts6forkmanager](https://github.com/DomeNinchen/ts6forkmanager)).
5. **Music-bot transport / memory reliability (v1.5.0)** — resolve the TeamSpeak UDP target once per connection, stream local/downloaded PCM incrementally with bounded memory and FFmpeg real-time pacing, and prevent overlapping reconnect attempts (adapted from [bro-network/ts6-manager](https://github.com/bro-network/ts6-manager)).

The yt-dlp HTTP-header transport subset evaluated in fork PR #45 was **reverted before v1.5.0** and is not part of the shipped phase above. Revisit it only as a fresh, current-main change if runtime evidence still shows temporary YouTube media URLs failing because FFmpeg lacks yt-dlp-selected headers.

## Backlog after v1.5.0

Do **not** fold these into opportunistic drive-by PRs; schedule them as dedicated follow-ups.

### Framework modernization (separate epic)

- React 19, Vite 8, Tailwind 4, React Router 8, TypeScript 7, Express 5, Prisma 7, Node 24, `@tanstack/react-table` v9
- One major bump series at a time with container verification per bump
- Move the workspace to a newer pnpm major only as an explicit migration, including override/build-script policy updates; CI currently targets pnpm 9

### CI / deps hygiene

- Manual Trivy (or equivalent) workflow adapted to our GHCR images
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

- [LgnRorooo/ts6-manager](https://github.com/LgnRorooo/ts6-manager) QoL: `!playlist` / `!seek` / `!remove` chat commands, yt-dlp download-progress UI, idle-queue auto-start when loading playlists
- Upstream [#82](https://github.com/clusterzx/ts6-manager/issues/82): verify image builds refresh yt-dlp; retest YouTube `!play` after video/timeout work
- Upstream [#53](https://github.com/clusterzx/ts6-manager/issues/53) / [#69](https://github.com/clusterzx/ts6-manager/issues/69): validate stream presets actually change delivered resolution after shared volume + encode tuning
- Upstream [#48](https://github.com/clusterzx/ts6-manager/issues/48): flow loop node (feature backlog)

See upstream issue/PR triage in the agent plan for additional skip notes.
