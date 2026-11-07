# B4 — `!playlistvote yes/no` (post-B3)

Status: **planning** (B3 merged `9ec216a5b0acc0c75539fb449d0c62efbf8ff6cb`). No implementation without R2 review + owner GO.

## Goal

Chat ballots for an open whole-playlist vote, sharing the merged B3 `PlaylistVoteRuntime` on `app.locals.playlistVotes` (one machine per process).

## In scope

- Register `!playlistvote yes` / `!playlistvote no` (and help/usage).
- Resolve bot + channel the same way as `!voteskip` / other music commands.
- Map invoker → TeamSpeak UID via existing listener identity helpers.
- Call `runtime.machine.castBallot` (requester `no` already cancels).
- Apply B3 rate limits / cooldowns already on the runtime; do not fork tally math.
- Private or channel replies consistent with other vote commands; never echo UIDs/paths.
- Before ballot: same deadline settle path as remote (reuse `settleExpiredVote` or a shared helper) so chat cannot bypass approval-time revalidation.

## Out of scope (later gates)

- **B4a** — `!playlist` opens/joins votes when voting is on.
- **B4b** — chat admin bypass queue without a vote.
- Remote API changes.
- Second vote runtime / machine instance.

## R2 checklist (minimum)

- [ ] Ballots only from live human listeners in the bot channel.
- [ ] Identity recycling / stale clid refused.
- [ ] Cancelled / expired / foreign vote → no queue.
- [ ] Chat settle uses approval-time restash + `refreshedAtMs` + vote-id ownership guard.
- [ ] Exactly-once queue on pass; fail-closed on listener lookup failure.
- [ ] Unrelated bot/channel votes untouched.
- [ ] Accepted limits unchanged: single-backend; lazy deadline.

## Dependencies

| Item | State |
|------|--------|
| B3 runtime + routes | on `main` @ `9ec216a` |
| B2 state machine | reuse only |
| Independent R2 + GO | **required before merge** |
| B4a / B4b | blocked on B4 + their own R2/GO |

## First implementation slice (when GO)

1. Command registration + parse `yes`/`no`.
2. Wire to `app.locals.playlistVotes` + live electorate.
3. Shared settle-before-ballot with remote.
4. Tests: yes pass, requester no cancel, non-listener refuse, post-deadline hide fail-closed, ownership with delayed restash.
