# OpenCode handover for the D1 listener presence preview

**Date** 2026-11-26

**Repository** `uniskela/ts6-manager`

```text
SOURCE_SHA: 6345bf3fd5ed466ed7613a35c2f4db47ed6e98bc
PR_NUMBER: N/A (local candidate for draft PR #504)
BRANCH: lab/d1-discord-listener-presence
COMMIT_SUBJECT: chore(discord-bridge): show anonymous listener presence in the D1 preview
CONFIRM: publish-private-beta-6345bf3fd5ed466ed7613a35c2f4db47ed6e98bc
COMMIT_ON_PR_504: no
```

## Publication preconditions

**Dispatch would fail source verification today.** The candidate is local. Draft #504 was open and same-repository at base `f1b0845d403d66fc58a19b82da0aef38ab8f72fe`. Before dispatch, fetch the current PR head. A normal fast-forward of the review branch to `bridge-d1/discord-voice-lab` can place both local commits on #504 if its head is still an ancestor. Verify that the workflow's PR-commit API lists `SOURCE_SHA`. If review or a newer head requires rebasing or cherry-picking, use the resulting source SHA, rerun verification, and regenerate `CONFIRM` before dispatch.

```text
CONTAINER_TEST_GATES_CHANGED: no
WORKFLOW_OR_CI_SCRIPTS_MODIFIED: no
DEPENDENCY_CHANGES: none
BASE_IMAGE_CHANGED: no
OCI_LABEL_CHANGES: no
NEW_ENV_VARS: none
COMPOSE_OR_CONFIG_CHANGES: none
STANDARD_PROCEDURE_CHANGED: no
```

The strict test manifest records two additional regressions. The Dockerfile, container probe scripts, source verifier, publish workflow, lockfile, and build inputs for the base image keep their existing definitions.

## What changed

- `packages/discord-bridge/src/adapters/discord-bot.ts` counts verified humans in the elected bot's mapped channel while Discord gateway state is available and DAVE is established.
- `packages/discord-bridge/src/adapters/ts-session.ts` and `src/adapters/tslib.ts` send an escaped `clientupdate` and wait for its correlated server reply.
- `packages/discord-bridge/src/lab/listener-presence.ts` and `src/lab/private-beta.ts` drive and stop the private-beta nickname monitor.
- `packages/discord-bridge/src/adapters/ts-session.test.ts`, `src/bridge/runtime.dave-idle.test.ts`, and `scripts/expected-tests.json` cover identity, lifecycle, DAVE loss, refusal and cleanup.
- `packages/discord-bridge/lab/OPERATOR-CHECKLIST.md` points to this preview's source pin. The [decision record](../internal/plans/2026-11-26-discord-listener-ts-presence.md) describes the scope and behavior.

A single verified Discord member in the mapped voice channel produces `[DC] 1 in voice` on the existing TeamSpeak bridge client even when nobody speaks. Zero restores `ts6-bridge-d1-beta`. The preview uses the existing idle slot and elected receiver. Identity, membership and encryption gates operate independently of speech. The TeamSpeak nickname contains an aggregate count. Neither status schema gains fields.

## Offline verification

Host commands ran from `packages/discord-bridge` with Node 24.21.0 and pnpm 9.15.9.

| Command | Result |
| --- | --- |
| `CI=1 pnpm install --frozen-lockfile --ignore-workspace` | Passed. Native Opus compiled from source after the matching prebuilt binary returned 404. |
| `node scripts/sync-tslib.mjs` | Passed. |
| `./node_modules/.bin/tsc --noEmit` | Passed. |
| `node --import tsx --test src/adapters/ts-session.test.ts src/bridge/runtime.dave-idle.test.ts` | Passed, 20 tests. |
| `node scripts/run-tests.mjs --update` | Passed, 449 tests in 43 files. |
| `node scripts/run-tests.mjs` | Passed, 449 tests in 43 files. No failed, skipped, todo, cancelled, or missing tests. |
| `./node_modules/.bin/tsx src/lab/smoke-deps.ts` | Passed. Native Opus, Opus fallback, DAVE key-package creation and voice dependency report. |

The host pnpm wrapper's generic run estimate exceeded available scratch space. The smoke command above calls the same installed executable as `pnpm run smoke:deps`.

Container commands ran from the repository root, targeting the rootless Docker context.

```sh
preview_sha=6345bf3fd5ed466ed7613a35c2f4db47ed6e98bc
preview_image="ts6-discord-bridge-lab:d1-$preview_sha"
vps-storage-sense run --estimate-gib 3 -- /usr/bin/docker --context rootless build \
  --progress plain -f packages/discord-bridge/lab/Dockerfile \
  --build-arg SOURCE_COMMIT="$preview_sha" -t "$preview_image" .

vps-storage-sense run --estimate-gib 5 -- bash -c '
  set -eu
  docker() { /usr/bin/docker --context rootless "$@"; }
  export -f docker
  packages/discord-bridge/scripts/container-runtime-test.sh "$1"
  packages/discord-bridge/scripts/private-beta-container-test.sh "$1"
' d1-probes "$preview_image"
```

The image build passed typecheck, 449 strict tests in 43 files, and native dependency smoke on pinned Node 24.22.1. The local image's `org.opencontainers.image.revision` equals `SOURCE_SHA`. Both probes passed, including the offline runtime, uid 1000, limited write access, both status projections, and final host status after SIGTERM. The local Docker wrapper initially treated the probe's container-side `sh -c` as a Docker context flag. The guarded command above runs both original scripts with the rootless client pinned for their entire execution.

## Operator run and evidence

Follow [Private beta](../../packages/discord-bridge/lab/PRIVATE-BETA.md) on the disposable lab after authorization. For a later authorized private pilot, [Private pilot](../../packages/discord-bridge/lab/PRIVATE-PILOT.md) uses the full `SOURCE_COMMIT` above and the matching digest in `D1_BRIDGE_IMAGE`.

1. In TeamSpeak, open the mapped channel's client list. Have one verified person enter the mapped Discord voice channel and stay silent. With DAVE established, look for `[DC] 1 in voice` on the existing bridge client within the two-second poll interval plus identity and server response time.
2. Have the participant leave or move. The bridge should recover its default nickname when the last verified human leaves. If DAVE drops or the gateway becomes unavailable, expect the same clear. A refused or unacknowledged rename emits the fixed warning `TeamSpeak listener presence nickname update unconfirmed; retrying after hold`. A stale nickname can persist until TeamSpeak accepts a correction. The retry hold is 30 seconds.
3. Verify audio separately with an actual listener at each end. `framesSent` and feed counters measure pipeline activity and can rise during silence. The prior one-way incident's cause remains unconfirmed. A successful nickname update shows presence only.

The offline tests use simulated Discord transport and TeamSpeak replies. Live server nickname permissions and acknowledgments, native DAVE negotiation with a real silent sitter, and audible delivery remain unverified. This candidate supplies no D1 A–D acceptance evidence.

## Trust statement

```text
TRUST_STATEMENT_ACKNOWLEDGED: yes
```

The attestation is reduced-trust preview evidence. GitHub signs the tarball bytes for the workflow identity on `refs/heads/main` with the dispatch `source_sha` in the predicate. Source-to-image equivalence requires separate evidence. Keep the image maintainer-only pending a rebuild from merged `main` with the stable release workflows.
