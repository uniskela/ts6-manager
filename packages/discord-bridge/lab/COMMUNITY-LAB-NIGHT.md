# Community lab night — volunteer pack (draft — do not post without owner GO)

Operators run the unfinished bridge. Volunteers need only **TeamSpeak** and **Discord** clients + a headset.

## Announcement draft (Discord / GitHub Discussion)

**Title:** Volunteers needed — supervised Discord ↔ TeamSpeak voice bridge lab (scenario A)

We are testing an **experimental** voice bridge between a **disposable** TeamSpeak 6 lab and a **private** Discord test voice channel. This is not a production service.

**Need for the first session (scenario A):** 4 people at the same time — 2 speaking in TeamSpeak, 2 listening in Discord (nobody in both rooms). Later sessions cover Discord→TeamSpeak, receiver failover, and join/leave.

**You bring:** Discord + TeamSpeak clients, headset, ~45–60 minutes.  
**You do not get:** bot tokens, server admin, or the bridge software.

Audio crosses Discord and TeamSpeak and may drop or stop without notice. 18+ (or guardian consent). Voluntary / unpaid. Reply if interested; we will send private join details.

## Safe join instructions (fill placeholders privately — never commit secrets)

1. Read the disclosure in the announcement; confirm you agree.
2. Discord: accept the **private test-guild** invite; join voice channel **`<CHANNEL>`** when the operator says go. Headphones on.
3. TeamSpeak: connect to **`<TAILSCALE_OR_PRIVATE_HOST>`** UDP port **`<HOST_PORT>`** (default lab publish may be `19989` when `19987` is reserved). Nickname: something non-identifying is fine. Password: **`<ONE_TIME>`** (rotated after the session).
4. Stay only in the room assigned for this scenario (TS speakers **or** Discord listeners for A — not both).
5. When the operator calls end: leave both channels; discard the password.

## Participant checklist (A–D)

| Scenario | Your role | Do | Don’t |
|----------|-----------|----|--------|
| **A** | 2× TS speak + 2× Discord listen | Speak at the same time on TS; Discord listeners report two distinct bot voices | Sit in both rooms; record others without consent |
| **B** | 2× Discord speak + ≥1 TS listen | Speak at the same time in Discord; TS hears both once | Create feedback loops; stay after a FAIL |
| **C** | 1× Discord keep talking | Keep talking through the operator’s receiver kill | Start this run yourself |
| **D** | 1 already in Discord + 1 join/leave | Joiner speaks then leaves after DAVE is up | Kill the receiver |

## Results template (privacy-safe)

```text
Date (UTC):
Candidate SHA: 46ce40c9 (or exact HEAD)
Scenario: A / B / C / D
Operator present: yes/no

PASS / FAIL / BLOCKED:

Heard (one line, no audio files):
Not heard / problem:

Counters (operator paste only — no names/IPs/tokens):
  daveReady:
  protocolVersion:
  receiver:
  generation:
  duplicateReceivers:
  t2d.routedIdentities:   # A
  d2t.framesSent:         # B/C
  d2t.selfSourceDrops:
  daveReplacements:       # D
  decryptErrors:
  receiveSubscriptions:   # D

Clients (versions only): Discord … / TeamSpeak …

Notes:
```

Attach nothing: no `.env`, logs bundles, screenshots with tokens, or audio.
