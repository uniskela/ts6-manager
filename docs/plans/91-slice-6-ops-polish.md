# #91 Slice 6 — Operational safety and on-demand diagnostics polish

**Status:** Behavior PRs 1–5 **shipped on `main`**; PR 6 history/status consistency **open** ([#155](https://github.com/uniskela/ts6-manager/pull/155)); PR 7 acceptance evidence in [`91-slice-6-acceptance.md`](91-slice-6-acceptance.md). Hold Release Please [#120](https://github.com/uniskela/ts6-manager/pull/120) until #155 lands and acceptance still matches `main`.

**Reviewed checkout (design):** `9df08fd` (Codex). **Shipped tip recorded for acceptance:** `aa926b5` (includes [#153](https://github.com/uniskela/ts6-manager/pull/153)).

**Sequencing guidance:** Action ownership and refresh control first; runtime diagnostics afterward — complete through PR 5 on `main`.

---

## Goals

- Surface relevant server/version/permission/context warnings at the action that needs them
- Keep stale connection/SID protection explicit
- Never present stale diagnostic data as current
- Expensive scans/summaries only on page entry / manual refresh
- Avoid unconditional short-interval polling for expensive diagnostics

## Non-goals

New monitoring stack; manager self-update; broad SSO; unrelated major upgrades; merging #120 until #91/#101 acceptance is honest.

---

## Additional current-state findings (Codex follow-up)

**Storage has two additional refresh/scale traps.** In `Files.tsx`, channel IDs form part of the summary query key. A changed channel list can therefore trigger another scan without page entry or manual refresh. The frontend also submits every channel, while the backend accepts at most 256; larger servers receive a request error that the summary UI does not explain.

**File-action ownership includes the path and channel.** The delete handler constructs its path at confirmation time, and mutation functions read the current connection/SID/channel. Protection must bind the complete original target, not merely reset selection when switching servers.

**Aborting HTTP does not currently cancel a scan.** `files.api.ts` does not forward an abort signal. The backend recursively schedules SSH work, and `EventBridge.executeCommand` resolves the current shared connection for each call. A scan needs generation checks during execution, as well as before displaying or caching its result.

**Frontend unit-test placement needs explicit CI wiring.** `playwright.config.ts` excludes `tests/unit/**`. PR validation runs Playwright and backend tests without a separate frontend-unit invocation. New policy tests placed only in that directory would not be covered unless CI is updated.

---

## Decisions and defaults

- An expensive diagnostic gets **one opportunity** to run after page entry and context validation. Renders and channel-list changes do not create another opportunity.
- Entering while offline shows **"Not checked."** Recovery does not silently start a deferred scan; offer **Refresh**.
- A configuration edit **invalidates** previous diagnostic applicability. It does **not** itself authorize a new expensive probe.
- For more than **256 channels**, show a bounded summary selection and explicitly label the remainder **"Not scanned."** Avoid automatically working through unlimited batches.
- A snapshot from another connection revision is **removed** from the current result area. A failed refresh in the **same** scope may retain the previous observation, clearly labelled.
- Exact scan budgets need measurement against beta13. Choose conservative deadline, command and entry caps initially; report partial completion instead of increasing them until every tree succeeds.
- Cross-tab configuration changes remain eventually observed unless an existing notification mechanism supplies them. Do not claim instantaneous cross-tab freshness or add a notification subsystem solely for this slice.

---

## Architecture rules

### Refresh policy

Shared classification for demand-driven queries:

| Trigger | Expensive diagnostic | Ordinary live/list query |
| --- | --- | --- |
| Valid page entry | One bounded attempt or clearly labelled cached observation | Existing policy |
| Manual refresh | New attempt; coalesce compatible in-flight work | Refresh |
| PWA recovery | Mark stale; no scan | Refresh active eligible queries |
| File mutation | Mark affected summary stale | Refresh affected directory |
| Channel-list change | Mark coverage stale; no scan | Update channel list |
| Connection revision change | Cancel/discard obsolete result | Invalidate relevant scope |
| Window focus / idle interval | No scan | Existing policy |

In `PwaStatus.tsx`, replace unrestricted invalidation with filtered behavior. Use TanStack Query `refetchType: 'none'` for expensive queries; preserve normal recovery for eligible live queries.

Query metadata alone is not enforcement. Mount behavior, changing keys and explicit `refetch()` calls must obey the same policy.

### Scan lifecycle

A scan should capture:

- Connection, SID and bounded channel set
- Connection/runtime generation
- Cache-invalidation generation
- Deadline and remaining work budget

Check these before scheduling each additional SSH command and before publishing results.

Cancellation:

- Stop scheduling further work
- Discard obsolete completions
- Allow an already transmitted command to complete through the existing transport
- Do not destroy the shared SSH session
- If requests share a scan, one disconnected caller must not cancel work still needed by another

Cached results:

- Preserve each observation's original `scannedAt`
- Distinguish response delivery time from scan time
- Never cache partial totals as complete totals
- Ensure an old scan's cleanup cannot remove a newer in-flight entry

### Mutation ownership

Pass immutable variables into mutations:

```ts
{
  configId,
  sid,
  cid,
  fullPath,
  ownerGeneration
}
```

Validate ownership before dispatch. Success callbacks must invalidate the **submitted target's** queries, even if the user navigated elsewhere while the request ran. They must not close a newly opened dialog belonging to another target.

Apply the same principle to instance settings and journal controls where appropriate.

---

## Small-PR sequence

| PR | Deliverable | Required evidence | Status |
| --- | --- | --- | --- |
| **1. Action and draft ownership** | Files target binding, instance draft protection, connection-test generation guards | Switching context cannot redirect a pending action or apply an obsolete result | **Shipped** [#144](https://github.com/uniskela/ts6-manager/pull/144) |
| **2. Demand-driven query policy** | Filtered PWA recovery, explicit summary refresh, controlled page-entry trigger, truthful missing/error states | Request-count tests show no scan after recovery, mutation invalidation or channel-list changes | **Shipped** [#146](https://github.com/uniskela/ts6-manager/pull/146) |
| **3. Bounded storage execution** | Request-wide budgets, generation-aware cache, cancellation/coalescing, coverage labels and channel-count handling | Large/denied/interrupted trees return honest bounded results | **Shipped** [#151](https://github.com/uniskela/ts6-manager/pull/151) |
| **4. Contextual compatibility and permission guidance** | Action-local warnings and meaningful prerequisite errors | Read success never implies write authorization | **Shipped** [#152](https://github.com/uniskela/ts6-manager/pull/152) |
| **5. Runtime/media diagnostics** | Bounded executable and sidecar checks beside relevant actions | Routine status polling performs no probes; failures terminate within bounds | **Shipped** [#153](https://github.com/uniskela/ts6-manager/pull/153) @ `aa926b5` |
| **6. History/status consistency** | Journal pagination reset, unknown/stale capture states, log context gating, accurate refresh labels | Scope changes and failed refreshes cannot preserve misleading current-state labels | **In flight** [#155](https://github.com/uniskela/ts6-manager/pull/155) — not on `main` |
| **7. Documentation and acceptance** | Correct shipped-status docs and record beta13/mobile/PWA evidence | #91/#101 claims match demonstrated behavior | [`91-slice-6-acceptance.md`](91-slice-6-acceptance.md) |

Each behavior PR includes focused tests and relevant docs. PR 7 consolidates acceptance evidence; it must not become a deferred testing bucket.

---

## Additional affected files

Beyond the original file list, explicitly include:

- `packages/frontend/src/api/files.api.ts` — request cancellation and typed summary results
- `packages/backend/src/bot-engine/event-bridge.ts` — narrowly scoped generation/ownership support if required
- `packages/backend/src/ts-client/connection-pool.ts` — revision lifecycle
- `packages/frontend/tests/pwa.spec.ts` — recovery request-count regression
- `.github/workflows/pr-validation.yml` — explicit execution of any new frontend unit tests

Avoid a general SSH transport rewrite as part of storage-summary polish.

---

## Acceptance tests (highest value)

1. Open Delete on connection A; switch to B; confirmation sends **no request to B**.
2. Submit an action on A; switch to B before completion; invalidate A's data without altering B's dialog.
3. Start a connection test; edit credentials; resolve the old request successfully; the edited draft remains untested.
4. Load summaries, modify the channel list, recover the backend and perform a file mutation; none starts another summary scan.
5. Open a server with 257 channels; browsing remains usable and unscanned coverage is explicit.
6. Invalidate a summary during an active scan; its completion cannot restore a valid cache entry.
7. Two callers share a scan; one cancels; the other can still receive its result.
8. Exhaust the total scan budget; completed observations remain labelled correctly and no additional commands are scheduled.
9. Verify the new test files actually execute in CI.

Retain live beta13, restricted-key, missing-SSH, metrics-fallback, logs, journal coexistence and mobile/PWA checks.

---

## Risks and rollback

Main risks: unintended scan triggers, obsolete cache writes, interference with shared SSH consumers. Keep changes local, add request-count tests, preserve existing transport ownership.

If storage diagnostics regress: disable automatic entry scans and retain manual refresh while keeping target protection and honest freshness labels. Runtime probes should be independently removable without affecting playback controls or cheap health endpoints.

Keep #120 on hold until #91/#101 acceptance is supported by evidence.
