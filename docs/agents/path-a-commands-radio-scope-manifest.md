# Path A scope manifest — `release/commands-radio`

- Base: `origin/main` @ `2359748ff41cc862784cb7e6ebf40f70330dbf88`
- Source tip: integration `1de19c86c23af49c5d4f9a45425ad97915c679f0`
- Method: file-set checkout (not 144-commit cherry-pick)
- Included paths: 189 changed vs origin/main; table 190 rows including net-zero `pnpm-workspace.yaml`
- Explicitly excluded D1 paths: 150

## Exclusions (D1 / unfinished bridge)

- `.github/workflows/discord-bridge-ci.yml`
- `docs/agents/bridge-d1-dave-lifecycle-review.md`
- `docs/agents/bridge-d1-one-way-audio-investigation.md`
- `docs/internal/plans/2026-11-05-d1-commands-radio-integration.md`
- `docs/internal/superpowers/plans/2026-10-26-bridge-d5-setup-wizard.md`
- `packages/discord-bridge/.gitignore`
- `packages/discord-bridge/.npmrc`
- `packages/discord-bridge/README.md`
- `packages/discord-bridge/evidence/curated/churn-native-200k-2026-10-24.json`
- `packages/discord-bridge/evidence/curated/churn-native-2026-10-24.json`
- `packages/discord-bridge/evidence/curated/churn-native-r2-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/churn-native-r3-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/churn-native-r4-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/image-runtime-baseline-d1-2026-10-24.txt`
- `packages/discord-bridge/evidence/curated/image-runtime-d1-r1-2026-10-24.txt`
- `packages/discord-bridge/evidence/curated/image-runtime-d1-r2-2026-10-25.txt`
- `packages/discord-bridge/evidence/curated/image-runtime-d1-r3-2026-10-25.txt`
- `packages/discord-bridge/evidence/curated/image-runtime-d1-r4-2026-10-25.txt`
- `packages/discord-bridge/evidence/curated/live-one-person-smoke-2026-10-27.json`
- `packages/discord-bridge/evidence/curated/remediation-red-green-2026-10-24.json`
- `packages/discord-bridge/evidence/curated/remediation2-red-green-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/remediation3-red-green-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/remediation4-red-green-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/remediation5-red-green-2026-10-26.json`
- `packages/discord-bridge/evidence/curated/remediation6-red-green-2026-10-26.json`
- `packages/discord-bridge/evidence/curated/smoke-deps-container-2026-10-24.json`
- `packages/discord-bridge/evidence/curated/smoke-deps-r2-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/smoke-deps-r3-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/smoke-deps-r4-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/ts-live-container-2026-10-24.json`
- `packages/discord-bridge/evidence/curated/ts-live-container-r1-2026-10-24.json`
- `packages/discord-bridge/evidence/curated/ts-live-container-r2-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/ts-live-container-r3-2026-10-25.json`
- `packages/discord-bridge/evidence/curated/ts-live-container-r4-2026-10-25.json`
- `packages/discord-bridge/lab/ACCEPTANCE.md`
- `packages/discord-bridge/lab/D1-LIVE-OBSERVATIONS.md`
- `packages/discord-bridge/lab/Dockerfile`
- `packages/discord-bridge/lab/PRIVATE-BETA.md`
- `packages/discord-bridge/lab/PRIVATE-PILOT.md`
- `packages/discord-bridge/lab/docker-compose.private-beta.yml`
- `packages/discord-bridge/lab/docker-compose.private-pilot.yml`
- `packages/discord-bridge/lab/env.private-beta.example`
- `packages/discord-bridge/lab/env.private-pilot.example`
- `packages/discord-bridge/package.json`
- `packages/discord-bridge/pnpm-lock.yaml`
- `packages/discord-bridge/scripts/container-runtime-test.sh`
- `packages/discord-bridge/scripts/d1-ts-lab.sh`
- `packages/discord-bridge/scripts/d1-ts-lab.test.mjs`
- `packages/discord-bridge/scripts/expected-tests.json`
- `packages/discord-bridge/scripts/private-beta-container-test.sh`
- `packages/discord-bridge/scripts/private-beta.sh`
- `packages/discord-bridge/scripts/private-beta.test.mjs`
- `packages/discord-bridge/scripts/private-pilot.sh`
- `packages/discord-bridge/scripts/private-pilot.test.mjs`
- `packages/discord-bridge/scripts/run-live-container.sh`
- `packages/discord-bridge/scripts/run-live-container.test.mjs`
- `packages/discord-bridge/scripts/run-tests.fixture.test.mjs`
- `packages/discord-bridge/scripts/run-tests.mjs`
- `packages/discord-bridge/scripts/sync-tslib.mjs`
- `packages/discord-bridge/scripts/test-reporter.mjs`
- `packages/discord-bridge/scripts/test-verify.mjs`
- `packages/discord-bridge/scripts/test-verify.test.mjs`
- `packages/discord-bridge/scripts/verify-invite-permissions.mjs`
- `packages/discord-bridge/scripts/verify-invite-permissions.test.mjs`
- `packages/discord-bridge/src/adapters/discord-bot.budget.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.dave-session.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.dave.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.identity-lifecycle.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.identity-retention.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.isolation.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.lifecycle.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.playback.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.receive.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.recovery.test.ts`
- `packages/discord-bridge/src/adapters/discord-bot.ts`
- `packages/discord-bridge/src/adapters/ts-session.rollover.test.ts`
- `packages/discord-bridge/src/adapters/ts-session.test.ts`
- `packages/discord-bridge/src/adapters/ts-session.ts`
- `packages/discord-bridge/src/adapters/tslib.ts`
- `packages/discord-bridge/src/bridge/runtime.dave-idle.test.ts`
- `packages/discord-bridge/src/bridge/runtime.dave.test.ts`
- `packages/discord-bridge/src/bridge/runtime.dead-slot.test.ts`
- `packages/discord-bridge/src/bridge/runtime.exclusion.test.ts`
- `packages/discord-bridge/src/bridge/runtime.lifecycle.test.ts`
- `packages/discord-bridge/src/bridge/runtime.race.test.ts`
- `packages/discord-bridge/src/bridge/runtime.recovery.test.ts`
- `packages/discord-bridge/src/bridge/runtime.test.ts`
- `packages/discord-bridge/src/bridge/runtime.ts`
- `packages/discord-bridge/src/core/arrival-gap.ts`
- `packages/discord-bridge/src/core/audio-quality.test.ts`
- `packages/discord-bridge/src/core/audio-robustness.test.ts`
- `packages/discord-bridge/src/core/callback-errors.test.ts`
- `packages/discord-bridge/src/core/callback-errors.ts`
- `packages/discord-bridge/src/core/cleanup.test.ts`
- `packages/discord-bridge/src/core/client-directory.ts`
- `packages/discord-bridge/src/core/constants.ts`
- `packages/discord-bridge/src/core/core.test.ts`
- `packages/discord-bridge/src/core/dave-gate.ts`
- `packages/discord-bridge/src/core/dave-observe.test.ts`
- `packages/discord-bridge/src/core/dave-observe.ts`
- `packages/discord-bridge/src/core/dave-session.test.ts`
- `packages/discord-bridge/src/core/dave-session.ts`
- `packages/discord-bridge/src/core/discord-to-ts.ts`
- `packages/discord-bridge/src/core/frame-feed.ts`
- `packages/discord-bridge/src/core/frame-mixer.ts`
- `packages/discord-bridge/src/core/human-filter.test.ts`
- `packages/discord-bridge/src/core/human-filter.ts`
- `packages/discord-bridge/src/core/identity-requests.test.ts`
- `packages/discord-bridge/src/core/identity-requests.ts`
- `packages/discord-bridge/src/core/ids.ts`
- `packages/discord-bridge/src/core/join-errors.ts`
- `packages/discord-bridge/src/core/metrics.ts`
- `packages/discord-bridge/src/core/nickname.ts`
- `packages/discord-bridge/src/core/opus-packet.ts`
- `packages/discord-bridge/src/core/opus.ts`
- `packages/discord-bridge/src/core/pcm.ts`
- `packages/discord-bridge/src/core/rebuild-budget.test.ts`
- `packages/discord-bridge/src/core/rebuild-budget.ts`
- `packages/discord-bridge/src/core/receive-supervisor.ts`
- `packages/discord-bridge/src/core/receive.test.ts`
- `packages/discord-bridge/src/core/receiver-election.ts`
- `packages/discord-bridge/src/core/redact.ts`
- `packages/discord-bridge/src/core/slot-router.ts`
- `packages/discord-bridge/src/core/ts-to-discord.ts`
- `packages/discord-bridge/src/core/ts-voice-packet.ts`
- `packages/discord-bridge/src/core/voice-admission.test.ts`
- `packages/discord-bridge/src/core/voice-admission.ts`
- `packages/discord-bridge/src/lab/beta-status.test.ts`
- `packages/discord-bridge/src/lab/beta-status.ts`
- `packages/discord-bridge/src/lab/churn.ts`
- `packages/discord-bridge/src/lab/config.test.ts`
- `packages/discord-bridge/src/lab/config.ts`
- `packages/discord-bridge/src/lab/dave-library.test.ts`
- `packages/discord-bridge/src/lab/evidence.ts`
- `packages/discord-bridge/src/lab/invite.test.ts`
- `packages/discord-bridge/src/lab/invite.ts`
- `packages/discord-bridge/src/lab/live.ts`
- `packages/discord-bridge/src/lab/private-beta-health.ts`
- `packages/discord-bridge/src/lab/private-beta-mount-probe.ts`
- `packages/discord-bridge/src/lab/private-beta.ts`
- `packages/discord-bridge/src/lab/setup.ts`
- `packages/discord-bridge/src/lab/smoke-deps.ts`
- `packages/discord-bridge/src/lab/ts-handshake.ts`
- `packages/discord-bridge/src/lab/ts-live.ts`
- `packages/discord-bridge/src/testing/controlled-rest.ts`
- `packages/discord-bridge/src/testing/fake-runtime.ts`
- `packages/discord-bridge/src/testing/fake-voice.ts`
- `packages/discord-bridge/src/testing/gc.ts`
- `packages/discord-bridge/src/testing/real-runtime.ts`
- `packages/discord-bridge/tsconfig.json`

## Included files

| File | Origin | Why required | Notes |
| `docs/agents/path-a-commands-radio-scope-manifest.md` | new-on-Path-A | Auditable include/exclude record | Generated for Phase 1 |
|------|--------|--------------|-------|
| `.env.discord-integration-test.example` | unchanged-from-integration | INT env example |  |
| `.github/workflows/pr-validation.yml` | unchanged-from-integration | CI: media-fetcher tests in PR validation |  |
| `.gitignore` | unchanged-from-integration | Ignore INT local env/job dirs |  |
| `docker-compose.discord-int-media-fetcher.yml` | unchanged-from-integration | INT lab compose (non-prod) |  |
| `docker-compose.discord-int-ts.yml` | unchanged-from-integration | INT lab compose (non-prod) |  |
| `docker-compose.media-fetcher.yml` | phase-2-adapted | Production-style fetcher overlay (radio fail-closed without it) | Documents MEDIA_FETCHER_IMAGE / GHCR pull path |
| `docs/agents/pr601-architecture-review.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/internal/discord-isolated-integration-4b.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/internal/discord-slash-command-registration.md` | phase-2-adapted | Commands/Radio operator or internal docs | Production app checklist + prod guild-bind dry-run; no live apply |
| `docs/internal/plans/2026-11-05-commands-radio-full-registry-matrix.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/internal/plans/2026-11-05-commands-radio-release-strategy.md` | phase-2-adapted | Commands/Radio operator or internal docs | Path A cut = Draft #658; Phase 2 status; merge still blocked pending release GO |
| `docs/internal/plans/2026-11-05-commands-radio-supervised-live-plan.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/internal/plans/2026-11-05-pr601-ci-disposition.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/internal/plans/discord-commands-media-proposal.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/manifest.json` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/public/environment-variables.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/public/index.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/public/installation.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/public/music-bots.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/public/radio-fetcher.md` | phase-2-adapted | Operator docs for fetcher | Deploy matrix + Landlock ABI>=4 + fail-closed; GHCR image tag |
| `docs/public/security.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/public/troubleshooting.md` | unchanged-from-integration | Commands/Radio operator or internal docs |  |
| `docs/public/upgrading.md` | phase-2-adapted | Commands/Radio operator or internal docs | nameKey finalise path + backup/restore/rollback; radio fetcher breaking note |
| `packages/backend/prisma/migrations/20261103000000_playlist_name_key/02_constraints.sql` | unchanged-from-integration | Schema/migrations for bindings + playlist name key |  |
| `packages/backend/prisma/migrations/20261103000000_playlist_name_key/migration.sql` | unchanged-from-integration | Schema/migrations for bindings + playlist name key |  |
| `packages/backend/prisma/migrations/20261103120000_discord_guild_binding/migration.sql` | unchanged-from-integration | Schema/migrations for bindings + playlist name key |  |
| `packages/backend/prisma/schema.prisma` | unchanged-from-integration | Schema/migrations for bindings + playlist name key |  |
| `packages/backend/src/app.rate-limits.test.ts` | unchanged-from-integration | Fair command rate limits |  |
| `packages/backend/src/app.ts` | unchanged-from-integration | Wire Discord runtime + rate limits |  |
| `packages/backend/src/config.ts` | unchanged-from-integration | Discord/fetcher/isolation config flags |  |
| `packages/backend/src/discord-command/adapter.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/adapter.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/backend-runtime.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/backend-runtime.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/bridge-health-port.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/bridge-health-port.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/command-audit.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/command-audit.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/d1-coexistence.test.ts` | adapted | Discord Commands implementation/tests | Rewrote seam test: assert package absent; keep production Administrator-grant default |
| `packages/backend/src/discord-command/discord-delivery.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/discord-delivery.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/discord-int-configure-musicbot.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/discord-int-musicbot-probe.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/discord-int-validate-play-url.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/fixtures/remote-guild-empty.json` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/fixtures/remote-guild-unrelated.json` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/follow-up.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/guild-bind-cli.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/guild-bind.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/guild-bind.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/guild-bindings.sqlite.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/guild-bindings.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/http-response.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/idempotency.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/idempotency.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/index.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/integration-readiness-cli.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/integration-readiness.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/integration-readiness.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/interaction.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/interactions-http.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/interactions-http.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/isolated-db-cli.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/isolated-db-target.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/isolated-db-target.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/isolated-db.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/isolated-db.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/music-inspect.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/music-service.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/music-service.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/music.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/outbound.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/outbound.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/presence.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/presence.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/public-messages.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/public-messages.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/rate-limit.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/rate-limit.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/runtime.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/security.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/security.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/slash-commands.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/slash-commands.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/slash-register-cli.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/slash-registration.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/slash-registration.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/step4a-integration-smoke.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/ts-presence-port.test.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-command/ts-presence-port.ts` | unchanged-from-integration | Discord Commands implementation/tests |  |
| `packages/backend/src/discord-int-path-filter-cli.ts` | unchanged-from-integration | INT tunnel path filter |  |
| `packages/backend/src/discord-int-path-filter.test.ts` | unchanged-from-integration | INT tunnel path filter |  |
| `packages/backend/src/discord-int-path-filter.ts` | unchanged-from-integration | INT tunnel path filter |  |
| `packages/backend/src/index.ts` | unchanged-from-integration | Startup wiring for Discord interactions |  |
| `packages/backend/src/listen-host.test.ts` | unchanged-from-integration | Bind-host helpers for isolated INT |  |
| `packages/backend/src/listen-host.ts` | unchanged-from-integration | Bind-host helpers for isolated INT |  |
| `packages/backend/src/routes/playlists.add-songs.test.ts` | unchanged-from-integration | Scoped playlist name uniqueness used by commands/library |  |
| `packages/backend/src/routes/playlists.routes.ts` | unchanged-from-integration | Scoped playlist name uniqueness used by commands/library |  |
| `packages/backend/src/routes/playlists.scope.test.ts` | unchanged-from-integration | Scoped playlist name uniqueness used by commands/library |  |
| `packages/backend/src/startup-isolation.test.ts` | unchanged-from-integration | Fail-closed isolated integration latches |  |
| `packages/backend/src/startup-isolation.ts` | unchanged-from-integration | Fail-closed isolated integration latches |  |
| `packages/backend/src/voice/audio/icy-metadata.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/audio/icy-metadata.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/audio/pipeline-radio-stream.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/audio/pipeline-radio-tls.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/audio/pipeline.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/audio/youtube-playlist-import.ts` | unchanged-from-integration | Scoped playlist name uniqueness used by commands/library |  |
| `packages/backend/src/voice/commands/chat-media-request.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/history.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/library.add-url.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/library.enqueue.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/library.remove.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/library.scope.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/library.test-catalog.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/library.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/music-command-handler.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/playback.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/commands/playlist-name.sqlite.test.ts` | unchanged-from-integration | Scoped playlist name uniqueness used by commands/library |  |
| `packages/backend/src/voice/commands/playlist-name.ts` | phase-2-adapted | Scoped playlist name uniqueness used by commands/library | previewPlaylistNameKeyMigration + finalize companion for db push |
| `packages/backend/src/voice/commands/queue.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/egress/egress-policy.parity.test.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/egress/egress-policy.test.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/egress/egress-policy.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/egress/media-egress-proxy.test.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/egress/media-egress-proxy.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/egress/media-egress.test.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/egress/media-egress.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/egress/media-fetcher-client.test.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/egress/media-fetcher-client.ts` | unchanged-from-integration | Radio/media egress + fetcher client + SSRF policy |  |
| `packages/backend/src/voice/media-command-permissions.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/media-session.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/media-session.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/media-url-pipeline.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/music-command-handler.controls.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/music-command-handler.history.test.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/ts6-chat-format.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/tslib/client.ts` | unchanged-from-integration | Shared voice/music/radio behaviour for Commands & Radio |  |
| `packages/backend/src/voice/voice-bot-manager.automation.test.ts` | unchanged-from-integration | PCM HWM/EOF drain + radio lifecycle |  |
| `packages/backend/src/voice/voice-bot-manager.ts` | unchanged-from-integration | PCM HWM/EOF drain + radio lifecycle |  |
| `packages/backend/src/voice/voice-bot-manager.video-queue.test.ts` | unchanged-from-integration | PCM HWM/EOF drain + radio lifecycle |  |
| `packages/backend/src/voice/voice-bot.automation.test.ts` | unchanged-from-integration | PCM HWM/EOF drain + radio lifecycle |  |
| `packages/backend/src/voice/voice-bot.media-session.test.ts` | unchanged-from-integration | PCM HWM/EOF drain + radio lifecycle |  |
| `packages/backend/src/voice/voice-bot.ts` | unchanged-from-integration | PCM HWM/EOF drain + radio lifecycle |  |
| `packages/common/src/constants/chat-commands.ts` | unchanged-from-integration | Shared constants/types for commands/audit |  |
| `packages/common/src/types/audit.ts` | unchanged-from-integration | Command audit types/UI label |  |
| `packages/frontend/src/pages/AuditHistory.tsx` | unchanged-from-integration | Audit history label for Discord command events |  |
| `.gitleaksignore` | path-a-ci | CI adaptation | Fingerprints for superseded hex fixtures in `988c057d`; tip uses placeholders |
| `.github/workflows/publish-images.yml` | phase-2-adapted | Release publish | Adds media-fetcher to release image matrix / promote / Hub packages |
| `docker-commands/apply-schema.sh` | phase-2-adapted | Schema startup | Runs nameKey finalize after `db push`; refuses conflicts without recording schema version |
| `packages/backend/prisma/SCHEMA_VERSION` | phase-2-adapted | Schema startup | Bumped for playlist nameKey finalisation marker |
| `packages/backend/src/discord-command/prod-db-target.test.ts` | phase-2-new | Production guild-bind | Allowlist tests; no allow-any bypass |
| `packages/backend/src/discord-command/prod-db-target.ts` | phase-2-new | Production guild-bind | Explicit `ts6webui.db` allowlist |
| `packages/backend/src/discord-command/prod-guild-bind-audit.ts` | phase-2-new | Production guild-bind | Audit log preflight + append; fail-loud after mutation |
| `packages/backend/src/discord-command/prod-guild-bind-cli.ts` | phase-2-new | Production guild-bind | Preview/confirm/audit CLI separate from isolated-db tooling |
| `packages/backend/src/discord-command/prod-guild-bind.test.ts` | phase-2-new | Production guild-bind | Disposable DB bind/revoke tests |
| `packages/backend/src/discord-command/prod-guild-bind.ts` | phase-2-new | Production guild-bind | Operator + app/guild verification; preview before write |
| `packages/backend/src/voice/commands/playlist-namekey-finalize-cli.ts` | phase-2-new | nameKey migration | Preview/confirm finalize used by apply-schema |
| `packages/backend/src/voice/commands/playlist-namekey-startup.test.ts` | phase-2-new | nameKey migration | Legacy-copy + duplicate-refuse + restart idempotence |
| `scripts/ci/prerelease-guards.sh` | phase-2-adapted | Release publish | Includes media-fetcher in component allowlist |
| `pnpm-workspace.yaml` | net-zero vs main | N/A (identical to origin/main) | Integration had `!packages/discord-bridge`; Path A keeps main `packages/*` only — not a changed PR path |
| `scripts/ci/repo-hygiene.sh` | unchanged-from-integration | Compose hygiene for media-fetcher overlay |  |
| `scripts/discord-int-media-fetcher-compose.sh` | unchanged-from-integration | INT media-fetcher helpers |  |
| `scripts/discord-int-media-fetcher-ipc-check.sh` | unchanged-from-integration | INT media-fetcher helpers |  |
| `scripts/discord-int-media-fetcher-stack-check.sh` | unchanged-from-integration | INT media-fetcher helpers |  |
| `services/media-fetcher/Dockerfile` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/README.md` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/fetcher.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/ffmpeg-args.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/ffmpeg-args.test.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/fixtures/Dockerfile.world` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/fixtures/client.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/fixtures/world.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/install-token.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/ipc-check.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/landlock.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/landlock.test.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/ll-wrap.c` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/peer-pid.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/pending-job.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/pending-job.test.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/policy.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/policy.test.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/proxy.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/reserved-networks.json` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/socket-guards.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/socket-guards.test.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/token.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/token.test.mjs` | unchanged-from-integration | Isolated radio media-fetcher service |  |
| `services/media-fetcher/validate-local.sh` | unchanged-from-integration | Isolated radio media-fetcher service |  |

## Unresolved D1 dependencies

- None as build/runtime imports. `/ts bridge` uses optional `bridge-health-port` (file/HTTP); honest-unavailable without a worker.
- `DISCORD_BRIDGE_*` config comments may mention a compose profile name; Path A does not ship `packages/discord-bridge`.
- Main already contains `publish-discord-bridge-private-beta.yml` + related CI unit tests from prior work; Path A does not add the package those publish.

## Existing TeamSpeak behaviour changes

- **Radio** requires the media-fetcher Compose overlay; without it radio fails closed (no insecure in-process fallback). Library/YouTube/queue/video remain in-process egress paths.
- VoiceBot PCM high-water / EOF drain changes shared radio stream playback.
- Playlist scoped name uniqueness (`playlist_name_key` migration) applies to TS and Discord playlist create/import paths.
- Music bot delete detaches Discord guild bindings first (P1-1); Restrict FK retained.

## Path A CI adaptation (post file-set)

- Replaced gitleaks-flagged hex fixture tokens in `media-fetcher-client.test.ts`, `validate-local.sh`, and `token.test.mjs` with obvious `ts6-*-token-*` placeholders (behaviour unchanged; Path A introduces these lines as a new commit vs main).
- Added `.gitleaksignore` fingerprints for the superseded hex fixtures in commit `988c057d` (tip uses non-secret placeholders).

## Phase 2 additions (Draft #658)

- Playlist `nameKey`: `db push` + finalize CLI wired in `apply-schema.sh`; conflicts refuse without destructive changes; schema version recorded only after success.
- Production guild-bind CLI (`prod-guild-bind*`) with basename allowlist `ts6webui.db` only — no `--allow-any-database`.
- Discord ops: dry-run slash preview / compare docs; production app checklist; interactions enable/disable via env latch. No live production Discord changes in this PR.
- media-fetcher included in `publish-images.yml` + prerelease guards; operator deploy matrix in `docs/public/radio-fetcher.md`.
- Evidence preserved: 21/21 command acceptance + sustained audible playback (INT); natural EOF remains unit-only caveat; `/ts bridge` honest-unavailable without D1 worker.
