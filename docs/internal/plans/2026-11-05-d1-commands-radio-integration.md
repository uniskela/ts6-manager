# D1 + Commands & Radio integration (2026-11-05)

**Branch:** `integration/discord-bridge-commands-radio`  
**Ancestry:** `main` → D1 `46ce40c` → merge `feat/discord-command-music-phase2` (`9b1ea8b`)  
**PR #504:** remains draft; this branch does not replace or merge it.

## What was verified offline

| Suite | Result |
|-------|--------|
| `packages/discord-bridge` (`pnpm test`) | 447/447 PASS (includes DAVE fail-closed / recovery / fencing coverage) |
| Commands & Radio backend tests (`discord-command/*`, startup isolation, path filter, listen-host) | 219/219 PASS |
| Backend + discord-bridge `tsc --noEmit` | PASS |
| Combined live Discord+TS+bridge session | **NOT RUN** on this branch |

## Retained behaviours

- D1: DAVE fail-closed routing, outbound epoch fencing, recovery budgets (package tree unchanged vs `46ce40c`)
- Commands & Radio: guild slash commands, music playback path, isolated DB/listen-host latches
- Administrator→TS6 admin only when **both** `TS6_ISOLATED_INTEGRATION` and `TS6_ISOLATED_LIVE_INTERACTIONS` are set
- `packages/discord-bridge` stays excluded from the root pnpm workspace (own Node ≥22.12 lockfile)

## Outstanding (from D1 evidence)

See `docs/internal/plans/2026-10-29-d1-live-evidence.md`. Phase 2b offline PASS does **not** close live acceptance A–D. Additional live failure-injection remains deferred. D1 merge to production remains **NO-GO** until those cases pass under supervision.

## Combined runtime gap

Independent suite PASS does not prove Commands slash-commands and D1 voice bridge share a production process/config safely. Any combined live test must use disposable TS + INT-TEST Discord only, with Interactions URL cleared afterward.
