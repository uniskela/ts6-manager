# Bridge-D1 live evidence (2026-10-29)

**Status:** D1 merge remains **NO-GO**. This file records operator-provided laboratory counters. It does not replace `packages/discord-bridge/lab/ACCEPTANCE.md` on draft PR [#504](https://github.com/uniskela/ts6-manager/pull/504) (that path is not on `main`).

**Do not** treat DAVE readiness as bidirectional audio. Do not overwrite older PASS rows.

## Sources

| Record | What it is | What it is not |
|---|---|---|
| `live-one-person-smoke-2026-10-27.json` (on #504) | Independently filed LIVE smoke: DAVE ready 511 s, `framesSent=1295`, both directions operator-attested | Not SHA `7f4d6c7` |
| Operator status snapshots on SHA `7f4d6c73049a1643f825d15c413eea1491a4e128` | Live Discord + disposable TS lab counters for DAVE leave/rejoin | Not hear-test evidence. Snapshots reported **no audio packets** |

No tokens, guild names, user names, host addresses, or raw logs are stored here.

## SHA `7f4d6c7` — DAVE leave/rejoin (operator-provided)

Laboratory / private-beta status, operator-supplied. Receiver stayed `slot-0`.

| Observation | Value | Class |
|---|---|---|
| Protocol-1 DAVE established | yes | operator live counters |
| Discord membership departure → DAVE unready | yes | operator live counters |
| DAVE restored after participants returned | twice | operator live counters |
| Receiver | `slot-0` throughout | operator live counters |
| Receive generation | 4 → 6 | operator live counters (allowed MLS/generation change) |
| `decryptErrors` | 0 | operator live counters |
| `daveReplacements` | 0 | operator live counters |
| Recoveries / scheduled reconnects | 0 | operator live counters |
| Duplicate receivers | 0 | operator live counters |
| Audio packets in these snapshots | none | **not** a hear-test |
| Discord → TeamSpeak heard on this SHA | unverified | no operator-attested hear note |
| TeamSpeak → Discord heard on this SHA | unverified | no operator-attested hear note |

**Mark:** last-human (or equivalent) DAVE restoration is **observed live** on this SHA. Bidirectional audio on this SHA is **unverified**. Do not copy this row onto the 2026-10-27 smoke PASS.

This is **not** ACCEPTANCE D (`live-dave-transition`). D requires a second authorised human joining while another remains, speaking, then leaving. That case is still NOT-RUN.

## Outstanding D1 acceptance (unchanged)

From ACCEPTANCE.md. None of these are PASS from the `7f4d6c7` snapshots.

| Case | State |
|---|---|
| Two real TeamSpeak speakers → separate Discord bots (A) | NOT-RUN |
| Two real Discord speakers → TeamSpeak, no feedback (B) | NOT-RUN |
| Membership change while another Discord human remains (D) | NOT-RUN |
| Receiver failover during speech (C) | NOT-RUN — needs authorised `--allow-recovery` |
| Independent security/lifecycle review of the **final** commit | not requested until A–D PASS |
| D1 merge / public image / production TeamSpeak | **NO-GO** |

One-person smoke PASS on an earlier SHA still stands. It does not close A–D.

## Resume checklist (supervised)

Do not start until the operator authorises the run. Keep `D1_DAVE_SINGLE_ATTEMPT=1` on the current beta. Do not recreate the image.

1. Confirm disposable TS lab (`d1-ts-lab`), not production. Confirm digest `sha256:32e5d68136c5d3701f84ed908583a5ac0efeea54dc9d385ee5c0744edad1e9b4` if still on the published `7f4d6c7` pin.
2. If a previous interactive / Portainer session is still running, **operator shutdown first**. Do not attach a second runtime.
3. Snapshot `health`, `daveReady`, `singleAttempt`, `receiver`, `generation`, `framesSent`, `recoveries`, `duplicateReceivers`.
4. **T2:** both directions with headphones; `framesSent` must rise; operator attest hear/not-hear.
5. **T1:** last remaining Discord human leaves ≥10 s, rejoins, DAVE returns, speech resumes. Fail-closed during the empty window is allowed; permanent fail-closed after rejoin is FAIL.
6. Later sessions (separate authorisation): A, B, D on `--single-attempt`; C only on `--allow-recovery`.
7. Keep ACCEPTANCE `mark` files out of private-beta usage JSON.

Related: [#502](https://github.com/uniskela/ts6-manager/issues/502), [#504](https://github.com/uniskela/ts6-manager/pull/504), [#531](https://github.com/uniskela/ts6-manager/issues/531).
