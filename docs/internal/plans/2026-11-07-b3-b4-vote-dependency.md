# B3 → B4 / B4a / B4b dependency notes

Status: B3 implements remote propose/vote/queue. Chat voting (B4+) waits on B3 + R2 + owner GO.

## Shared voting code (do not parallel-edit)

| Module | Owner now | Later consumers |
| --- | --- | --- |
| `voice/playlist-vote/state-machine.ts` (B2) | frozen for B3 | B4/B4a read + ballot/cancel only |
| `voice/playlist-vote/runtime.ts` (B3) | B3 routes + `/state` | B4a should reuse `PlaylistVoteRuntime` / same machine instance on `app.locals.playlistVotes` |
| `voice/playlist-vote-settings.ts` (B1) | settings API | unchanged |

Avoid a second machine instance for chat. B4a must call the same runtime so remote `/state` and chat see one open vote per bot+channel.

## B4 — `!playlistvote yes/no`

- Depends on: B3 merged (R2 + GO), B2 machine.
- Scope: chat ballots → `castBallot` / requester `no` cancel; no new vote rules.
- Do not fork tally math; map chat identity → UID the same way as voteskip.

## B4a — chat `!playlist` opens / joins the B3 vote when voting is on

- Depends on: B4 (ballot path), B3 runtime singleton.
- When voting off: keep today's direct `!playlist` behaviour (out of scope for B3 remote path).
- When voting on: open or attach via `openVote` with the same stash/revalidate/queue hook as B3.
- Announce open/result in channel (at most two messages per vote — already emitted as machine events).

## B4b — "Queue playlists without a vote" (chat admin bypass)

- Depends on: B4a.
- Server-group permission; chat only. Remote has no admin bypass (#442 / API).
- Keep bypass out of `PlaylistVoteMachine`; short-circuit before `openVote`.

## Merge gates

- B3/B4/B4a/B4b: R2 review + explicit owner GO.
- No release / tags / production images from this workstream.
