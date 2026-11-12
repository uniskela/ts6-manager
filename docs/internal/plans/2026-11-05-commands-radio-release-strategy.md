# Commands & Radio — release strategy (2026-11-05)

**Integration tip:** `integration/discord-bridge-commands-radio` (includes `origin/main` / v1.11.4).  
**Path A cut:** `release/commands-radio` (file-set from integration tip `1de19c86`, excluding `packages/discord-bridge`). Combined integration / #601 remain Draft and untouched.

**Do not merge the combined integration branch to `main`.** PR #504 remains untouched.

## Path A — Commands & Radio independently (sooner)

Ship the Commands & Radio surface **without** unfinished D1 bridge feasibility.

| Item | Status |
|------|--------|
| Full slash registry implemented + wired | Done offline |
| Automated Commands suites | PASS post-main-merge |
| INT-TEST guild registration (non-global) | Creates applied; `/play` `/queue` `/stop` preserved |
| Stage F live (`/play` `/queue` `/stop`) | PASS (prior session) |
| Full-registry supervised live | **PASS** (21/21 preserved) |
| Production Discord app / global registration | Must stay off |
| D1 worker / DAVE hear-tests | Not required for Path A |

**How to cut Path A later:** cherry-pick or open a Commands-only branch from `9b1ea8b`+follow-ups **excluding** `packages/discord-bridge` D1 feasibility and unfinished bridge pilot wiring, after full-registry live PASS. This integration branch is intentionally combined and is **not** that cut.

**Path A cut:** Draft PR #658 (`release/commands-radio`). Phase 2 adds prod guild-bind, nameKey finalisation on startup, fetcher publish, and ops docs. **Still blocked for merge:** production Discord app/registration GO, operator DB backup checklist, independent release GO. No production app changes until approved.

## Path B — Combined D1 + Commands & Radio

Ship after D1 live acceptance **and** Commands full-registry live.

| Item | Status |
|------|--------|
| Offline D1 suite | 447/447 PASS |
| Main reconciliation (v1.11.4) | Merged cleanly into integration |
| D1 live A–D / private-beta hear | **Blocking** — not approved to start here |
| `/ts bridge` against real worker | Needs isolated status source or worker; do not fabricate |
| Combined draft PR for review/CI | Allowed; merge forbidden until both live tracks PASS |

**Blocks Path B:** D1 live A–D; Commands full live; production/security acceptance; explicit merge approval.

## Recommendation

**Path A can ship sooner** once the consolidated INT-TEST live session PASSes and a Commands-only PR is cut without unfinished D1.  
**Path B stays blocked** on D1 live acceptance. Prefer Path A for user-facing Discord→TS music/radio; keep D1 on its own draft (#504 / bridge lab) until hear-tests close.

## Non-goals (this batch)

- No merge to `main`
- No production Discord application changes
- No global slash registration
- No unattended public tunnels
- No fabricated D1 bridge status / no D1 pilot start without approval
