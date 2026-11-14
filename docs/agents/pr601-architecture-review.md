# PR #601 independent architecture review

Agent working note. Not published.

| | |
|---|---|
| PR | #601, `integration/discord-bridge-commands-radio` |
| Reviewed baseline | `1fa8601e00d708f0f7814bd501e3238d38ae0e29` (fixed; newer commits not reviewed) |
| Review branch | `review/pr601-architecture-refactor`, six code commits on that baseline |
| D1 bridge source | Read and reviewed. Not changed (zero-line diff under `packages/discord-bridge`) |
| Date | 2026-11-05 |

## 1. Overall assessment

The PR is large but not sprawling. Most of its 45k added lines are tests, curated evidence and lab tooling. Production source is about 13.7k lines across four parts with clear boundaries:

| Part | Where | Assessment |
|---|---|---|
| D1 voice bridge | `packages/discord-bridge` (own lockfile, Node 24, outside the pnpm workspace) | Dense but deliberate. Lifecycle, fencing and DAVE state are explicit, documented at each field, and covered by 447 tests with a completeness-checking runner. The complexity is mostly required by the safety model. |
| Commands & Radio | `packages/backend/src/discord-command` | Good layering: signed HTTP edge → adapter (binding + role) → authorising wrapper (fresh binding re-read) → music service (media permissions, idempotency). Fails closed throughout. Some speculative or test-only surface (see P2-6). |
| Shared music logic | `packages/backend/src/voice/commands` | The PR extracted shared helpers (`pausePlayback`, `skipPlayback`, `library.ts`) so TeamSpeak chat and Discord share one queue and one catalog. That is the right direction. |
| Radio egress isolation | `services/media-fetcher` + `voice/egress/media-fetcher-client.ts` | Strong isolation design (Landlock, separate network, token files). Two gaps: its tests are not in CI, and stream backpressure is absent end to end. |

No P0 issue was found. Recommendation: **accept the architecture, do focused follow-up work on the P1 items before release.** Nothing found blocks the PR as an integration branch.

## 2. Findings

Severity: P0 security/correctness, P1 significant, P2 useful, P3 cosmetic.

### P1

**P1-1. Deleting a music bot that was ever bound to a Discord guild fails half-way.**
- Where: `packages/backend/prisma/schema.prisma:193` (`musicBot ... onDelete: Restrict`), `voice/voice-bot-manager.ts:614`.
- Evidence: real SQLite probe (Prisma `db push`, bind, revoke, delete bot) → `P2003 Foreign key constraint violated`; the bot row remains. Revoke keeps the row by design, so even a revoked binding blocks deletion. `removeBot()` has already stopped the bot, cleared its video queue and dropped it from memory before the delete throws.
- Impact: admin sees a 500, the bot is stopped but still listed in the DB. Latent today because bindings can only be written to the isolated test DB, but the schema ships to production through `db push`.
- Proposal: decide the product rule, then either delete or detach bindings for that bot before `musicBot.delete` (in a transaction), or refuse with a 409 before stopping the bot. Add a SQLite regression test.
- Risk: schema/product decision. Not implemented here.

**P1-2. No per-user command rate limit in production; the only limiter is keyed on Discord's egress.**
- Where: `backend-runtime.ts:208` builds the adapter without `rateLimit`; `app.ts:73-80` limits `/api/discord/interactions` to 120/min per `clientRateKey(req)`.
- Evidence: `MemoryCommandRateLimit` and the adapter's `rateLimit` hook exist but nothing wires them. Every interaction arrives from Discord's servers, so the IP limiter is effectively one shared bucket for all guilds and users.
- Impact: one member spamming `/play` can exhaust the shared bucket and deny every guild for the rest of the window. No per-user fairness.
- Proposal: wire `MemoryCommandRateLimit` per `guildId:userId` in `createBackendDiscordCommandRuntime`, keep the IP limiter as a flood guard, and bound the limiter's key map (it never prunes keys).
- Risk: behaviour change (new rejections), needs chosen limits. Not implemented.

**P1-3. Media-fetcher unit tests are not run by any CI workflow.**
- Where: `services/media-fetcher/*.test.mjs` (14 tests: policy, token, landlock, ffmpeg args). No workflow under `.github/workflows` references `services/`.
- Evidence: all 14 pass locally with Node 20; nothing executes them in CI.
- Impact: the component that enforces radio egress policy can regress without CI noticing.
- Proposal: add a step to the backend job: `node --test services/media-fetcher/*.test.mjs`. The parity test added on this branch (commit `bb52d1d`) already runs in the backend suite and covers policy agreement, but not token, Landlock or ffmpeg-argument tests.
- Risk: CI-only change; left to maintainers as a workflow edit.

**P1-4. Address policy is maintained twice.** *(Mitigated on this branch.)*
- Where: `services/media-fetcher/policy.mjs` + `reserved-networks.json` vs `voice/egress/egress-policy.ts` + `utils/url-validator.ts`.
- Evidence: the fetcher header says "Keep aligned with egress-policy.ts"; nothing checked it.
- Done here: differential test over both implementations, mutation-checked (six drifts, all caught). Longer term, have the backend load the same JSON so there is one source of ranges.

### P2

**P2-1. Discord delivery dedupe set grew forever.** *(Fixed, `48b5869`.)* `discord-delivery.ts` kept every deferred interaction id until `dispose()`. Records now drop after the token TTL, the only window in which a repeat can do anything.

**P2-2. `/ts bridge` health request had no timeout.** *(Fixed, `6380104`.)* `bridge-health-port.ts` fetched the worker with no bound; `/ts bridge` is an immediate reply, so a hung worker overran Discord's 3 s window. Now aborts after 2 s and reports unavailable. Note: the D1 worker has no HTTP `/health` endpoint yet (it is a D2 contract); only the lab status-file path works today.

**P2-3. Radio stream has no backpressure anywhere.** Fetcher `fetcher.mjs:287` writes ffmpeg stdout to the socket ignoring `write()`'s return; backend `media-fetcher-client.ts:136` writes socket data into a `PassThrough` ignoring it; `voice-bot.ts:1266` consumes in flowing mode into an unbounded chunk list. A live Icecast stream arrives at real time, but a non-live source (HLS VOD or a file URL saved as a station) is decoded as fast as it downloads and buffered in backend memory. The unbounded consumer predates the PR; the PR adds two more unbounded hops. Proposal: pause the socket when the `PassThrough` is full, and cap or pace the radio chunk buffer. Media pipeline change; not implemented.

**P2-4. Fetcher client has no connect/header/cancel timeouts.** `media-fetcher-client.ts:40-60, 96`. A fetcher that accepts but never answers hangs `playStream`. On the Discord side the `/radio play` idempotency claim then stays pending forever (`idempotency.ts:3`: pending claims never expire). Proposal: bound the header wait (a few seconds) and the cancel RPC.

**P2-5. Discord command audit is a no-op in production.** `backend-runtime.ts:213` defaults `audit` to `() => {}` and `index.ts` passes none. Every Discord command, including refused ones, leaves no audit trail. Proposal: route to the existing activity/audit service.

**P2-6. Test-only and speculative surface exported as the module API.** Not used by production code: `outbound.ts` (hosted-hub HMAC session), `createDiscordCommandRuntime` in `runtime.ts` (a second composition root without the instance scoping and authorising wrapper that production uses), `handleSignedInteraction`, `parseInteractionBody`, `assertMusicNotImplemented`, `MusicCommandRequest`, the `PHASE_*` arrays. Several tests build their runtime through `createDiscordCommandRuntime`, so they test a composition production never runs. Proposal: move tests to `createBackendDiscordCommandRuntime` (or a shared builder), then delete or clearly mark future-only code. Not done here because it changes `index.ts` exports and many tests.

**P2-7. `CommandResult.ack` is dead data on the HTTP path.** `interaction.ts:6` (`planAcknowledgement`) alone decides immediate vs deferred; the `ack` each handler returns is ignored and sometimes disagrees (playlist `create`/`remove` return `immediate` but are deferred at HTTP). Proposal: drop the field from handler results or assert agreement in a test.

**P2-8. Discord users have no TeamSpeak identity.** `identityForUser` is not wired (`index.ts`), so `authorizeMediaCommand` sees an empty identity and every media group not set to "everyone" refuses Discord users. Fails closed; worth documenting for operators, since the Discord role lists are then the real gate.

**P2-9. Isolated Administrator grant relies on startup ordering.** `startup-isolation.ts`: `shouldEnableIsolatedLiveAdministratorGrant()` reads only the two env latches. It is safe today because `assertIsolatedIntegrationStartup()` runs first in `main()` and throws on an unsafe DB, host or app id. Hardening: have the grant also require `assessIsolatedIntegrationStartup(env).ok`, and refuse `NODE_ENV=production` under isolation. Authentication-sensitive; recommendation only.

**P2-10. Guild bindings cannot be created for a production DB.** The bind CLI refuses non-isolated DB basenames, and no HTTP route exists. Correct for this phase; record it as a release prerequisite so Commands are not announced before a production binding path exists.

### P3

- **P3-1.** Duplicated deferred follow-up job construction in `interactions-http.ts`. *(Fixed, `3fd1110`.)*
- **P3-2.** Duplicated binding row mapping and a catch that only rethrew. *(Fixed, `ca1517c`.)*
- **P3-3.** TeamSpeak `!radio` rebuilt the radio queue item and station query by hand. *(Fixed, `8e113da`.)*
- **P3-4.** Local `fail()`/`ok()` result helpers are defined separately in `adapter.ts`, `music-service.ts`, `backend-runtime.ts` and `http-response.ts`.
- **P3-5.** Three structural copies of the binding Prisma port type (`BindingDb`, two `BindingPrisma`).
- **P3-6.** `envFlag` is duplicated in `config.ts:11` and `startup-isolation.ts:22`.
- **P3-7.** `slash-registration.ts:185` sleeps the full Retry-After and then throws anyway.
- **P3-8.** D1 `runtime.ts:356` repeats the body of `applyRouterChanges()` inline in `refreshExclusions()`.

## 3. D1 bridge: observations (no changes made)

The lifecycle model (`created → running → stopping → stopped`), the serial membership queue with deliberately unqueued activation and joins, generation fencing on receive, per-bot rebuild budget, and DAVE epoch binding are consistent and well tested. Earlier independent reviews already covered lifecycle and fencing in depth; this review did not re-run their probes. Structural observations only:

- **D1-1 (P2).** `BridgeRuntime.status()` calls `desiredMembers()`, which runs `pruneRecovery()` and `reclaimIdleRoutes()`. Those mutate router eligibility and emit `slotChange` outside the membership queue. Current analysis: harmless, because every state change that makes pruning matter also schedules a `sync()` that recomputes the same result. Still, a health read should not mutate. Proposal: split a pure `computeDesiredMembers()` for `status()`.
- **D1-2 (P2).** `adapters/discord-bot.ts:32` imports `BotPort`, `NickResult` and `nickErrorKind` from `bridge/runtime.ts`, so the adapter depends on the runtime it plugs into. Proposal: move the port types and `nickErrorKind` to `bridge/ports.ts` and re-export from `runtime.ts`.
- **D1-3 (P2).** `BridgeRuntime` carries seven maps for nickname sync (`appliedNick`, `desiredNick`, `pendingNick`, `nickDenied`, `nickFailCount`, `nickEpoch`, `nickChain`). Extracting a `NicknameSync` class would shrink the runtime and isolate the epoch logic, but it touches the unhealthy and leave paths, so it needs its own lifecycle review.
- **D1-4 (P3).** `discord-bot.ts` (1,079 lines) mixes connection management, DAVE observation, receive supervision and diagnostics counters. A split by concern is possible later; not worth the review churn before the D1 gate.

All D1 proposals are documentation only, per the rule that D1 lifecycle, DAVE and recovery-fencing changes are not made automatically.

## 4. Refactors on the review branch

| Commit | Change | Why | Regression risk |
|---|---|---|---|
| `48b5869` | Delivery dedupe records expire after the token TTL | Unbounded memory | Very low. Only differs for a repeat arriving after the TTL, which signature freshness (60 s) already prevents |
| `6380104` | `/ts bridge` health fetch aborts after 2 s | Reply could miss Discord's 3 s window | Low. A slow worker now reads as unavailable, same as any other fetch failure |
| `3fd1110` | Deferred path builds the follow-up job once | Two copies of the same payload could drift | Very low. Two new tests pin job fields and event order; one unreachable edge (a throwing diagnostic hook) noted in the commit |
| `ca1517c` | Shared binding row mapper; drop rethrow-only catch | Duplication | Very low. Same fields; error propagation covered by existing test 12 |
| `8e113da` | TeamSpeak `!radio` uses `loadRadioStations()` and `radioQueueItem()` | Same logic in two front ends | Very low. New test pins exact query, items and replies; passed before and after |
| `bb52d1d` | Fetcher/backend egress policy parity test | Unchecked duplicated security policy | None (test only). Mutation-checked |

Each change was preceded by a test that failed on the baseline (bug fixes) or passed on the baseline (pure refactors), then the targeted suites and `tsc --noEmit` were re-run.

Not changed on purpose: anything under `packages/discord-bridge`, signature verification, the authorising wrapper, role resolution, isolation latches, schema, CI workflows and compose files.

## 5. Test evidence

Toolchain as CI: backend on Node 20.20.2 + pnpm 9.15.9, bridge on Node 24.21.0 with its own lockfile.

| Run | Typecheck (all packages) | Backend suite | D1 bridge suite |
|---|---|---|---|
| Baseline `1fa8601` | pass | 199 files, 1,892 tests: 1,891 pass, 0 fail, 1 skipped | 447/447 pass in 43 files, runner-verified complete; bridge typecheck pass |
| Final `bb52d1d` | pass | 200 files, 1,902 tests: 1,901 pass, 0 fail, 1 skipped (same pre-existing skip) | 447/447 pass in 43 files, runner-verified complete; bridge typecheck pass |

The 10 extra backend tests are the new ones on this branch. Media-fetcher `*.test.mjs` (not in CI): 14/14 pass locally at baseline.

## 6. Recommendation

Accept the current architecture. Before release, do focused work on P1-1 (bot deletion), P1-2 (per-user rate limit) and P1-3 (fetcher tests in CI), and consider P2-3/P2-4 (radio backpressure and timeouts) together. The D1 proposals can wait for the D1 gate. No finding blocks PR #601 as an integration branch.
