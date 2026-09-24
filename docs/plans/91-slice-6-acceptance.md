# #91 Slice 6 / #101 — Acceptance evidence

**Status:** Documentation and acceptance consolidation (Slice 6 **PR 7**).  
**Checkout recorded:** `main` @ `d2fcd6b` (includes [#153](https://github.com/uniskela/ts6-manager/pull/153) and [#155](https://github.com/uniskela/ts6-manager/pull/155)).  
**Hold:** Release Please [#120](https://github.com/uniskela/ts6-manager/pull/120) until release-note curation matches shipped behavior on `main`.

This document records **demonstrated** behavior only. It is not a deferred test plan for unfinished work.

---

## Shipped PR map

### #91 Slice 6 — Operational safety and on-demand diagnostics

| Plan PR | Deliverable | Status | Merge |
| --- | --- | --- | --- |
| 1 | Action and draft ownership | **Shipped** | [#144](https://github.com/uniskela/ts6-manager/pull/144) |
| 2 | Demand-driven query policy | **Shipped** | [#146](https://github.com/uniskela/ts6-manager/pull/146) |
| 3 | Bounded storage execution | **Shipped** | [#151](https://github.com/uniskela/ts6-manager/pull/151) |
| 4 | Contextual compatibility / permission guidance | **Shipped** | [#152](https://github.com/uniskela/ts6-manager/pull/152) |
| 5 | Runtime / media diagnostics | **Shipped** | [#153](https://github.com/uniskela/ts6-manager/pull/153) @ `aa926b5` |
| 6 | History / status consistency | **Shipped** | [#155](https://github.com/uniskela/ts6-manager/pull/155) @ `d2fcd6b` |
| 7 | Documentation and acceptance | This PR | — |

### #91 earlier slices (for issue acceptance honesty)

| Slice | Status | Primary evidence |
| --- | --- | --- |
| 1 Native metrics | **Shipped** | [#126](https://github.com/uniskela/ts6-manager/pull/126); fixture `packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.*` |
| 2 Staged connection diagnostics | **Shipped** | [#114](https://github.com/uniskela/ts6-manager/pull/114) |
| 3 Server Logs 2.0 | **Shipped** | [#132](https://github.com/uniskela/ts6-manager/pull/132), [#137](https://github.com/uniskela/ts6-manager/pull/137), [#139](https://github.com/uniskela/ts6-manager/pull/139), [#142](https://github.com/uniskela/ts6-manager/pull/142), plus Slice 6 PR 6 [#155](https://github.com/uniskela/ts6-manager/pull/155) |
| 4 Administrative audit | **Shipped** | [#134](https://github.com/uniskela/ts6-manager/pull/134), [#135](https://github.com/uniskela/ts6-manager/pull/135), [#140](https://github.com/uniskela/ts6-manager/pull/140), [#155](https://github.com/uniskela/ts6-manager/pull/155) |
| 5 Activity journal | **Shipped** | [#133](https://github.com/uniskela/ts6-manager/pull/133), [#136](https://github.com/uniskela/ts6-manager/pull/136), [#138](https://github.com/uniskela/ts6-manager/pull/138), [#140](https://github.com/uniskela/ts6-manager/pull/140), [#155](https://github.com/uniskela/ts6-manager/pull/155) |

### #101 Appearance 1.8

| Part | Status | Merge |
| --- | --- | --- |
| A Backgrounds + motion + intensity | **Shipped** | [#122](https://github.com/uniskela/ts6-manager/pull/122) |
| B Custom CSS + `?safe-ui=1` | **Shipped** | [#128](https://github.com/uniskela/ts6-manager/pull/128) |

Docs: [server-management](../server-management.md) (Appearance), [security](../security.md#appearance-custom-css), [troubleshooting](../troubleshooting.md#appearance-custom-css-made-the-ui-unusable).

---

## Slice 6 acceptance scenarios → evidence

Plan scenarios from [`91-slice-6-ops-polish.md`](91-slice-6-ops-polish.md). Coverage is automated unless noted.

| # | Scenario | Evidence |
| --- | --- | --- |
| 1 | Delete on A; switch to B; confirm sends **no** request to B | `packages/frontend/tests/unit/action-ownership.test.ts` — `canConfirmFileAction` / target binding |
| 2 | Action on A; switch to B before completion; invalidate A without altering B’s dialog | Same file — `shouldCloseFileDialog` |
| 3 | Connection test; edit credentials; obsolete success leaves draft untested | Same file — `shouldApplyConnectionTestResult` |
| 4 | Summaries + channel-list change + PWA recovery + file mutation do **not** start another scan | `packages/frontend/tests/unit/demand-driven-query-policy.test.ts` — request-count suite; `PwaStatus.tsx` filtered recovery |
| 5 | ≥257 channels usable; unscanned coverage explicit | Frontend policy tests + `packages/backend/src/routes/file-summary-scan.test.ts` (`selectChannelsForSummaryScan`, omitted remainder) |
| 6 | Invalidate during active scan; completion cannot restore valid cache | `file-summary-scan.test.ts` scenario 6 |
| 7 | Shared scan; one cancel; other waiter still receives result | `file-summary-scan.test.ts` scenario 7 |
| 8 | Exhaust scan budget; labels honest; no further commands | `file-summary-scan.test.ts` scenario 8 |
| 9 | New unit tests execute in CI | `.github/workflows/pr-validation.yml` — **Run frontend unit tests** (`find tests/unit …`) and backend `*.test.ts` discovery |

### History / status consistency (plan PR 6)

| Behavior | Evidence |
| --- | --- |
| Journal pagination resets with connection/SID; capture Unknown / stale / current | `packages/frontend/tests/unit/history-status-consistency.test.ts`; `docs/server-management.md` |
| Logs gated on confirmed VS context; failed refresh never claims “up to date” | Same unit file + `packages/frontend/tests/logs.spec.ts` |
| Audit failed refresh keeps rows with interrupted label; Live suppressed | Unit coverage + operator docs on Journal / Audit |

---

## Retained checks (beta13 / mobile / PWA)

### TeamSpeak beta13

| Check | Evidence |
| --- | --- |
| Pinned image | `docker-compose.pr-test.yml` → `teamspeaksystems/teamspeak6-server:6.0.0-beta13` |
| Compat workflow default | `.github/workflows/ts6-compat.yml` default tag `6.0.0-beta13` |
| Native metrics fixture | `packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.txt` (+ headers / meta); parser tests in `metrics-parse.test.ts` |
| Operator docs | [teamspeak-compatibility.md](../teamspeak-compatibility.md), [troubleshooting.md](../troubleshooting.md) |

Live pr-test smoke (restricted key, missing SSH, metrics fallback, logs 2052, journal coexistence) remains an operator checklist on a beta13 stack; it is not re-executed by this documentation PR.

### Mobile / responsive

| Check | Evidence |
| --- | --- |
| Appearance + mobile viewport | `packages/frontend/tests/pwa.spec.ts` — settings appearance contained on mobile; `appearance-custom-css.spec.ts` — editor usable on mobile viewport |
| Backgrounds / motion | `packages/frontend/tests/appearance-background.spec.ts` |
| Custom CSS recovery | `appearance-custom-css.spec.ts` + unit `custom-css.test.ts` |

### PWA

| Check | Evidence |
| --- | --- |
| Production worker suite | `packages/frontend/tests/pwa.spec.ts` (manifest, cache boundary, update flow, API network-only) |
| CI wire-up | PR validation **Test production PWA** |
| Expensive diagnostics on recovery | Unit policy tests + `PwaStatus.tsx`: recovery refreshes ordinary live queries; expensive diagnostics invalidate with `refetchType: 'none'` (no summary / runtime-media rescan) |
| Maintenance checklist | [pwa-maintenance.md](../pwa-maintenance.md) physical-device release checklist (OS install certification is **not** claimed by cloud CI) |

---

## #91 issue acceptance checklist (honest mapping)

| Acceptance item | Demonstrated? | Notes |
| --- | --- | --- |
| Connection tests distinguish reachability, auth, usable permissions | **Yes** | #114 + action-guidance / diagnostics docs |
| v1.7 behavior and PWA/network boundaries preserved | **Yes (automated)** | PWA Playwright + demand-driven recovery policy; physical install checklist still applies at release |
| Optional native metrics never require a publicly exposed metrics listener | **Yes** | #126 backend-mediated scrape |
| Dashboard degrades to WebQuery when metrics unavailable | **Yes** | #126 |
| Logs useful context/time; mobile-safe | **Yes** | Logs 2.0 + #155 context gate and honest refresh labels |
| Administrative audit excludes secrets; bounded retention | **Yes** | #134 / #135 |
| Client activity scoped to connection + VS | **Yes** | #133 journal |
| Expensive diagnostics demand-driven | **Yes** | #146 / #151 / #153 |
| Focused backend/frontend tests + beta13 coverage | **Yes** | Unit + backend scan tests + beta13 fixture/CI; live pr-test smoke is operator-retained |
| Public docs updated after stable behavior | **This PR** | Plus per-behavior docs already landed with #152 / #153 / #155 |

---

## #101 acceptance checklist (honest mapping)

| Acceptance item | Demonstrated? | Evidence |
| --- | --- | --- |
| Existing 1.7 appearance intact; default look unchanged | **Yes** | #122 docs + Grid default |
| Backgrounds restrained / readable | **Yes** | Playwright contrast/containment coverage |
| Reduced-motion respected | **Yes** | System motion + tests |
| Custom CSS explicitly opt-in | **Yes** | #128; enable + Save CSS |
| Broken CSS has practical recovery | **Yes** | `?safe-ui=1` docs + Playwright |
| No backend/security/PWA boundary regressions | **Yes** | Security doc + PWA suite + custom-css tests |
| Mobile remains usable | **Yes** | Mobile viewport Playwright cases |

---

## Release Please

Do **not** merge [#120](https://github.com/uniskela/ts6-manager/pull/120) until:

1. This acceptance matrix still matches `main` after PR 7 merges, and  
2. Release-note curation reflects shipped behavior only (remove reverted/duplicate bullets).
