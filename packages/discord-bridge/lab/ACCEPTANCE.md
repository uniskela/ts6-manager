# Bridge-D1 remaining live acceptance

Operator-only. Do not start a run until every participant is present and the operator authorises that run. Use only the disposable TS6 laboratory (`d1-ts-lab.sh`) and one private Discord testing voice channel. Do not use production TeamSpeak.

A–D may be completed in controlled sessions during the restricted private beta. Keep these PASS/FAIL evidence files separate from private-beta usage counters (`lab/PRIVATE-BETA.md`). The private-beta runner has no `mark` / `kill-receiver` stdin commands.

Evidence is counters plus operator-attested hear/not-hear notes. Do not record audio, tokens, guild names, user names, or host addresses. `mark` notes may say "two distinct voices" or "heard after failover" only.

## Current gate

| Item | State |
|---|---|
| One-person live smoke | PASS (`live-one-person-smoke-2026-10-27.json`): DAVE ready 511 s, `daveReplacements=0`, `decryptErrors=0`, `framesSent=1295`, both directions attested |
| Two real TeamSpeak speakers | NOT-RUN |
| Two real Discord speakers / no feedback | NOT-RUN |
| Receiver failover during speech | NOT-RUN |
| Membership join/leave after DAVE | NOT-RUN |
| Independent security/lifecycle review of the final commit | NOT requested until the four rows above PASS |
| D1 merge | **NO-GO** |

## Shared start (every run)

1. Presence only, no connections:

```bash
packages/discord-bridge/scripts/d1-ts-lab.sh start
packages/discord-bridge/scripts/run-live-container.sh
```

Expect each required variable as `SET` or `MISSING`. Stop if any is `MISSING`. Do not pass `--confirm` yet.

2. After the operator names the run and the participants are on the disposable TS lab and the private Discord test channel, start **one** of:

```bash
# A, B, D — no automatic reconnects
packages/discord-bridge/scripts/run-live-container.sh --confirm --single-attempt

# C only — successor rebuild allowed
packages/discord-bridge/scripts/run-live-container.sh --confirm --allow-recovery
```

3. Commands on stdin: `status`, `kill-receiver`, `mark <id> pass|fail <note>`, `write`, `quit`.
4. After `quit`, keep the evidence file from `lab/evidence/` (mode `0700`). Do not attach raw logs or `.env`.
5. Stop: `quit`, then `packages/discord-bridge/scripts/d1-ts-lab.sh stop`. That removes only `d1-ts6-lab`, `d1-ts6-lab-data`, and `d1-ts-lab`.

If DAVE is not ready (`dave.<receiver>.ready` false, or `protocolVersion` 0) before the first speaker, **FAIL** the run, `quit`, and do not continue.

## A — Two TeamSpeak speakers, two Discord identities

**Mark id:** `live-two-speakers`  
**Start:** `--single-attempt`

Two humans speak at the same time on the disposable TeamSpeak channel. Two other people listen on Discord (headphones). Nobody is in both rooms.

| Watch (`status`) | PASS | FAIL |
|---|---|---|
| `t2d.routedIdentities` | `2` | `1` or `0` while both speak |
| `slots` | two `true` | both speakers on overflow only, or one slot |
| `dave.<slot>.ready` on those two sender bots | `true` | false / protocol 0 |
| `daveReplacements` | `0` | any increment |
| Operator hear | two distinct Discord bot users, each one voice | one bot plays both, mix on one identity, or silence |

Recovery: `quit`, stop the lab. Do not retry inside a failed DAVE session.

## B — Two Discord speakers, no duplicate / no feedback

**Mark ids:** `live-d2t`, `live-no-feedback`  
**Start:** `--single-attempt`

Two humans speak at the same time in the private Discord test channel. Listeners on TeamSpeak use headphones. Nobody is in both rooms.

| Watch (`status`) | PASS | FAIL |
|---|---|---|
| `receiver` | exactly one id | `null` or changing without a kill |
| `duplicateReceivers` | `[]` | any extra receiver |
| `d2t.framesSent` | increases while they talk | stuck at 0 |
| `d2t.selfSourceDrops` | `0` | > 0 |
| `d2t.daveDropped` / `admissionDropped` | 0 during steady speech | climbing while both stay in channel |
| `decryptErrors` on the receiver | `0` | > 0 |
| Operator hear | both voices once on TeamSpeak, no echo | doubled speech, feedback, or one speaker missing |

Recovery: `quit`, stop the lab. A feedback FAIL means stop immediately; do not keep the channel open.

## C — Receiver failover during speech

**Mark id:** `live-kill-receiver`  
**Start:** `--allow-recovery` only. `--single-attempt` cannot elect a successor.

One Discord human keeps talking. Record `status` (`receiver`, `generation`, `d2t.framesSent`). Type `kill-receiver`. Wait until `status` shows a new receiver and DAVE ready. Keep talking through the cut.

| Watch (`status`) | PASS | FAIL |
|---|---|---|
| `generation` | increases by ≥ 1 | unchanged after kill |
| `receiver` | different id, then stable | `null` for > 15 s, or two ids in `duplicateReceivers` |
| `duplicateReceivers` | `[]` after the new receiver is ready | any extra |
| `d2t.framesSent` | resumes increasing | stays flat after the new receiver is ready |
| `d2t.fenceDroppedAtMix` | may rise at the cut, then stop | keeps rising after the new generation is ready |
| Operator hear | speech returns as one voice | permanent silence, doubled voice, or leftover audio from the killed bot |

Recovery: `quit`, stop the lab. Do not run A/B/D on this same `--allow-recovery` process.

## D — Membership change after DAVE is up

**Mark id:** `live-dave-transition`  
**Start:** `--single-attempt`

Establish DAVE with one Discord human already speaking (`dave.<receiver>.ready=true`, `lastKind` welcome or commit). Then a second authorised human joins the same private Discord channel, speaks, and leaves. Do not kill the receiver.

| Watch (`status`) | PASS | FAIL |
|---|---|---|
| `daveReplacements` on the receiver | `0` (epoch welcome/commit on the same session) | increment (new session) |
| `decryptErrors` | `0` | > 0 |
| `receiveSubscriptions` on the receiver | 2 while both are in channel; 1 after leave | stays 2 after leave, or 0 while both are present |
| `d2t.admissionDropped` | may rise at leave, then stop | keeps rising after leave while the remaining speaker is heard |
| Operator hear | new joiner heard; after leave their voice is gone | joiner never heard, ghost audio after leave, or DAVE drop |

Recovery: `quit`, stop the lab.

## After all four PASS

1. Keep the four evidence files. Redact nothing that is already counters-only; do not add names or addresses.
2. Request an independent security/lifecycle review of that exact HEAD (not this draft text).
3. Merge is still blocked until that review is GO and the squash message stays `chore:` (this lab must not open a 1.12.0 release). D2–D6 stay unstarted. Production TeamSpeak stays unused.
