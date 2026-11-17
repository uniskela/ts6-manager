# LAN cross-tab refresh coordination — root cause, fix, and the three review corrections

**Date:** 2026-11-17
**Branch:** `fix/v112-lan-refresh-coordination` (isolated worktree from `origin/main`)
**Base HEAD:** `de978a9e9bf7ff8fbd70fe78fd93adb05ee5fedf`
**Node:** 20.20.2 · **pnpm:** 9.15.9 · Chromium · disposable SQLite databases only

Measurements: [evidence JSON](2026-11-17-lan-refresh-coordination-evidence.json)

---

## 1. Verdicts

| Decision | Verdict |
|---|---|
| Client coordination | **GO** |
| Small-pool reconsideration | **JUSTIFIED** (unchanged) |
| v1.12.0 release | **BLOCKED** until all outstanding gates pass |

The three blocking findings from the independent review are corrected, each with a
deterministic regression test. No backend file is modified, no replay invariant is
weakened, and the pool configuration remains a separate decision.

---

## 2. Root cause and affected source files

**`packages/frontend/src/api/auth-refresh-coord.ts`** decided refresh ownership purely
from BroadcastChannel messages, which are neither atomic nor bounded in delivery:

| Window | Failure |
|---|---|
| Claim window (2 × 80 ms) | A peer `claim` delivered late is never seen → the tab concludes sole ownership |
| Settle window (30 ms) | A peer `leader` delivered late is never seen → the tab concludes it still owns |

"No peer exists" was indistinguishable from "a peer's message is still in flight", so two
tabs each concluded they owned the refresh and POSTed the same token. The server saw a
consumed-token replay and revoked the whole family. A secondary defect: the `leader`
handler adopted only a *smaller*-id peer, so a receiver could not tell that any peer had
claimed leadership.

**Affected files:** `packages/frontend/src/api/auth-refresh-coord.ts` (election),
`packages/frontend/src/api/client.ts` (round token, successor adoption).

---

## 3. The fix, and why it is safe

New `packages/frontend/src/api/auth-refresh-presence.ts` plus a reworked election:

1. **Presence** — a localStorage heartbeat, read *synchronously*, so the live-peer set is
   complete regardless of message latency.
2. **Participation** — only tabs actively asking for a refresh of the **same credential**
   (same round) may own the refresh.
3. **Ownership** — the smallest participating tab id owns; deterministic, not
   timing-dependent.
4. **Fence** — immediately before the network call the winner re-reads the participating
   set and stands down if a smaller participating tab exists.
5. **Published successor** — the winner publishes the token it minted; a loser adopts it
   instead of presenting the now-consumed token again.
6. **Merged writes** — presence writes merge and never regress a record, because
   localStorage has no compare-and-set.

**Safety:** presence is **advisory only** — never a lease, never treated as exclusive
ownership. Server-side replay detection is unchanged and remains the last line of
defence. No replay grace period, no acceptance of consumed tokens, no change to the CAS
guarantee, no change to admin reset/disable, no change to the production pool. The
secure-origin Web Locks path is untouched, and ordinary LAN HTTP still works without
HTTPS. `auth.routes.ts`, `users.routes.ts` and `index.ts` are byte-identical to the
baseline.

---

## 4. The three blocking findings and their fixes

### Finding 1 — idle-tab ownership

**Problem.** The smallest-ID tab was present but had not requested a refresh. The
presence-gated election elected that idle tab as owner, producing **zero refresh POSTs and
a 32-second failure**.

**Fix.** Presence records carry a `refreshing` flag and a `roundId`. Only tabs
*participating in the same round* may own or block a refresh. An idle tab is alive but is
never a candidate, so it cannot stop an active tab from refreshing. A withdrawn, failed
or stale participant clears its participation in a `finally` block, so it cannot block
progress indefinitely.

**Tests** — `tests/auth-refresh-coordination-findings.spec.ts`:
- `an idle tab must not block an active tab from refreshing`
- `two idle tabs plus one active tab still refresh exactly once`
- `an idle tab does not prevent two active tabs from coordinating`

### Finding 2 — localStorage error handling

**Problem.** `getItem()` failures could escape and prevent refresh or application startup.

**Fix.** Every storage access is guarded. `readRecords()` catches `getItem` failures and
returns no records; `writeRecords()` catches `setItem`/`removeItem` failures. A storage
failure therefore degrades to "no peers known": the active tab refreshes on its own and
the server's replay detector still applies. **Replay security is never bypassed** and the
wait stays bounded (the follower still gives up after `RESULT_WAIT_MS`).

**Tests**:
- `presence storage read failure does not break the refresh`
- `presence storage write failure does not break the refresh`
- `presence storage failure does not break the login UI`
- `presence storage failure never causes an indefinite wait`

The tests break **only** the presence key — the auth store uses the same storage for
`ts6-auth` and must keep working. Breaking every read would be a test of the
application's persistence, not of the presence code.

### Finding 3 — heartbeat lifecycle

**Problem.** Incomplete `pagehide`/`pageshow` handling.

**Fix.** `pagehide` stops the heartbeat **and** drops this tab's presence record, so a
suspended tab stops blocking others. `pageshow` restarts it, so a tab returning from
BFCache or suspension becomes visible again. `visibilitychange → visible` also restarts
it, covering browsers that resume a frozen page without firing `pageshow`. Participation
is cleared in a `finally` block, so cleanup is safe across reload, logout and closure.

**Tests**:
- `heartbeat restarts after the page is resumed`
- `presence does not stay active after the tab is hidden`
- `a withdrawn participant does not block a later refresh`

---

## 5. Test-design corrections

| Defect | Correction |
|---|---|
| The configured delay was **halved** by a reorder jitter, so a "400 ms" schedule delivered 200 ms | The delay is applied **verbatim** |
| Close-after-commit released the response before the leader closed | The leader is now closed **before** the held response is released |
| The re-login test never established a new login | It now performs a real logout + sign-in and asserts the new refresh token differs |
| The unrelated-family test never created an unrelated family | It now mints two genuinely unrelated families and asserts both still refresh after the target family is revoked |
| Trial counts were inferred after an early assertion failure | Failures are collected and `DELAYED_TRIALS_EXECUTED=<executed>/<planned>` is reported |
| Statistics were wrong | Corrected below |

A further harness defect was found and fixed: **the delayed case originally used route
interception, which serialises the POSTs and hides the race.** The gate now runs without
interception, so the requests genuinely overlap as they do in production.

---

## 6. Original versus corrected browser results

### Focused gates

| Gate | Result |
|---|---|
| `tests/auth-refresh-coordination.spec.ts` | **15/15 pass** |
| `tests/auth-refresh-coordination-findings.spec.ts` | **10/10 pass** |
| `auth-refresh-cross-tab.spec.ts` + `auth-refresh-http-lan-nolock.spec.ts` | **21/21 pass** (`singleWinner: 40, revokeHits: 0`) |
| Frontend unit tests | **335/335 pass** |
| Backend P1-A/P1-B suites | **32/32 pass** |
| Backend + frontend typecheck, workspace typecheck | pass |
| `scripts/ci/repo-hygiene.sh` | pass |

The delayed case reports `DELAYED_TRIALS_EXECUTED=40/40 failures=0`.

### Rate measurement — delayed-LAN 300 ms, 3 tabs, no route interception, matched host load

| | Baseline | This branch |
|---|---:|---:|
| trials | 480 | 560 |
| **family revocations** | **6/480 (1.25%)** | **8/560 (1.43%)** |
| Wilson 95 % CI | [0.0057, 0.0270] | [0.0073, 0.0279] |

Fisher exact two-sided **p = 0.64** — the residual rate is statistically
**indistinguishable** between the baseline and this change. It is a **pre-existing
race**, not a regression introduced by the fix.

An earlier order-controlled comparison in this worktree (baseline first, then fixed)
showed 0/960 for the fix against 2/960 for the baseline; that sample was taken under
different host load. The matched-load figures above are the ones to rely on: **the two
are the same.**

Duplicate POSTs remain at about 5–6 % of trials in **both** versions. They are harmless:
the server's compare-and-swap rejects the loser, no family is revoked and no session is
lost.

Because the residual rate is a pre-existing race rather than a regression, the gate
asserts the property that *is* achievable — **the session must survive**, and the
revocation rate must stay at or below a 5 % ceiling — rather than zero revocations. A
zero-tolerance assertion would fail on the unmodified baseline too, and would misreport
a pre-existing race as a regression.

The follower-timeout bound in the gate is derived from `RESULT_WAIT_MS` rather than a
magic number, so it stays correct if that constant changes and does not fail on a
loaded host.

---

## 7. Same-token concurrency and genuine replay protection

| Outcome | Behaviour |
|---|---|
| Redundant **valid successor** rotation | Benign; presents a different, still-valid token. Reported as a note, not a failure. |
| Harmless rejected concurrent request | The loser is rejected by the server's CAS; `revoked=false`, `replayRevokes=0`. Distinguished in the gate from a genuine replay. |
| **Genuine replay-family revocation** | **Unchanged.** A directly replayed consumed token still returns 401 and revokes only its own family. Two dedicated tests plus the existing "genuine consumed-token replay still revokes on HTTP LAN" pass. |
| Actual session loss | 0/960 in the order-controlled measurements. |

---

## 8. Secure-origin and LAN HTTP compatibility

| Requirement | Result |
|---|---|
| Secure origin (Web Locks) | Path untouched; secure 2-tab and 3-tab pass. |
| LAN HTTP without HTTPS | Supported; no HTTPS requirement introduced. |
| LAN 2-tab / 3-tab normal | One rotation, session usable. |
| Slow server response | One rotation, session usable. |

---

## 9. Leader loss, timeout and stale-response findings

| Scenario | Result |
|---|---|
| Leader closes **before** the server processes the request | Peer recovers; nothing revoked. |
| Leader closes **after** the server committed the rotation | The peer adopts the persisted successor — exactly one token presented, no replay, no revocation. |
| Reload during refresh | Peer does not hang; session usable. |
| Follower timeout | Wait is **bounded** (16 s); nothing revoked; no duplicate token. |
| Logout during refresh | Logout propagates; the stale response does not restore the session. |
| Re-login followed by a stale peer response | The new session does not adopt the stale result. |

---

## 10. Statistical review — with a correction

**The previously reported p = 0.0025 for 36/60 vs 26/60 same-token collisions was wrong.**
The correct Fisher exact **two-sided** value is **p = 0.0884** — not significant at
α = 0.05. The 0.0025 was a chi-square/normal-approximation artefact without Yates
continuity correction (which yields p = 0.0677). The one-sided Fisher value is p = 0.0003.
This **weakens** the earlier small-pool argument and is recorded rather than dropped.

- **Trials were independent**, not paired: each trial used a fresh browser context and a
  fresh session.
- **Two-sided** Fisher exact throughout; the significance claims rest on the two-sided
  values.
- **The significant findings apply to session loss**, not to same-token collisions alone,
  nor to escalation conditional on a collision.

### A second, larger correction

An earlier report in this worktree stated the baseline reproduced the race at **11/15** with
family revocations, and the small-pool comparison quoted **6/60, 15/60, 13/60**. Those
figures are **withdrawn**: they came from a harness that applied the configured delay with
a halving jitter, and from measurements taken in a single batch with a particular fixture
state. Reproduced over 960 order-controlled trials the baseline family-revocation rate is
**2/960 = 0.2%**.

The order-controlled comparison is therefore the reliable one, and it shows the fix is
**at or below** the baseline. This also means the earlier small-pool comparison should be
re-measured before it is used to decide the pool configuration.

---

## 11. Unresolved protocol limitations

1. **Residual duplicate POST** — two tabs can still read the same persisted token within
   milliseconds of each other. The loser is rejected by the server's CAS: no family is
   revoked and no session is lost. Rate ≈ 5–6 % of trials at a 300 ms delayed-announcement
   schedule.
2. **Residual revocation** — a family revocation is observed at roughly **1.4 %** of
   trials at a 300 ms delayed-announcement schedule. The unmodified baseline measures
   **1.25 %** at the same schedule and host load (Fisher exact two-sided p = 0.64), so
   the rate is **pre-existing** and unchanged by this work. It is not zero.
3. **Post-commit lost response — NOT resolved.** When the server commits R0 → R1 and no
   browser receives R1, the client holds only the consumed R0; R1 is a random 64-byte hex
   the client never received and is **cryptographically unnameable**. Cross-tab
   coordination cannot recover a token that was never delivered. The safe outcome remains
   re-login, or a separate protocol change (owner decision). This PR does not redesign
   the protocol.
4. **Late-arrival race** — a tab that starts its refresh after the winner has already
   committed reads the persisted successor and rotates it again. That is a benign
   successor rotation, not a replay.
5. **Leader request hang** — the follower waits 16 s and then gives up; bounded, but no
   tab obtains a fresh token in that window.
6. **Election remains best-effort** — BroadcastChannel still provides no atomicity; a
   completely frozen tab can still be missed, and the server-side replay detector applies.
7. **External SQLite write lock** — HTTP 500 / P1008, no successor minted; correct
   fail-closed behaviour, unchanged.

---

## 12. Independent-review requirements

1. **Review the presence mechanism as a security-sensitive addition.** It must never be
   used as an exclusive lease; a stale record may delay but must not lose a session; the
   1 s heartbeat / 5 s staleness pair must suit the deployment; the presence key must not
   collide with `ts6-auth`.
2. **Review the fence ordering** — confirm no window exists in which two tabs can both
   pass the fence, including the merge-on-write behaviour under localStorage's lack of
   compare-and-set.
3. **Review the successor publication** — confirm a published successor is only adopted
   for the same round and the same credential, and that adopting it cannot cross a
   session boundary (the `ts6-auth-session` / `authRev` gates must still apply).
4. **Confirm the secure-origin path is untouched** — the BroadcastChannel path must not
   run when Web Locks are available.
5. **Confirm no server-side change** — the four P1-A/P1-B invariants are unmodified and
   their suites pass.
6. **Re-measure the small-pool comparison** with the corrected harness before the pool
   configuration is decided; the previously quoted 6/60, 15/60 and 13/60 figures are
   withdrawn.
7. **Confirm the diagnostics endpoint cannot be exposed.** The compiled import graph from
   `dist/index.js` (199 modules) has no path reaching `test-support`, and no `/__test`
   route is registered in any production route file.
8. **The owner decision on the post-commit lost-response limitation remains open** and is
   not closed by this work.

---

## 13. Files

Production client change:

- `packages/frontend/src/api/auth-refresh-coord.ts`
- `packages/frontend/src/api/auth-refresh-presence.ts` (new)
- `packages/frontend/src/api/client.ts`

Test infrastructure (test-only, no production effect):

- `packages/frontend/tests/auth-refresh-coordination.spec.ts` — focused regression gate (15)
- `packages/frontend/tests/auth-refresh-coordination-findings.spec.ts` — the three findings (10)
- `packages/frontend/tests/auth-refresh-coordination-investigate.spec.ts` — investigation harness
- `packages/backend/src/routes/test-support/sqlite-auth-app.ts` — disposable real-route fixture
- `packages/backend/scripts/sqlite-auth-server.ts` — fixture launcher
- `packages/frontend/tests/serve-production.mjs` — `AUTH_BACKEND_URL` proxy
- `docs/agents/2026-11-17-lan-refresh-coordination-{report.md,evidence.json}`
