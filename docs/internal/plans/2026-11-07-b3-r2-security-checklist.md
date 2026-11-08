# R2 security checklist — B3 / B4 whole-playlist voting

Authoritative: #465. Functional spec: #442. Draft PR must not merge without R2 + owner GO.

B3 merged on main at `9ec216a` (#624). History follow-up: #628. B4 draft implementation reuses shared `PlaylistVoteRuntime` via `playlistVotesForRemote` (not a second Express/`app.locals` instance in `MusicCommandHandler`). Planning stays on #627. Overall R2 remains incomplete until B4* + owner GO.

## B3 matrix (covered by `listener-remote.playlist-requests.test.ts` unless noted)

| Area | Check | Status |
| --- | --- | --- |
| Permission bypass | Propose requires playlist/queue group; ballot is listener-only; cancel is requester-only | covered |
| Identity / client-ID recycling | Live clid+uid+channel membership rechecked; leave channel → 401 | covered |
| Vote replay / double queue | Closed voteId → 404; queue length unchanged on replay | covered |
| Listener / channel membership | Human electorate from live clientlist; requester leave cancels on `/state` tick | covered (cancel path + state maintenance) |
| Playlist visibility changes | Hidden/non-request at approval → `playlist_unavailable`, nothing queued | covered |
| Request size / queue limits | empty / `request_too_large` / `queue_full` all-or-nothing | covered |
| Bot restart / disconnection | `onRestart` + `bot_unavailable` on move/disconnect/stop; nothing queued | covered |
| Session expiry / revocation | Requester/bot-wide revoke cancels open vote; peers cannot approve | covered |
| Concurrency / fail-closed | `vote_running`; listener list null → 503; sync single queue decision in B2 hook | covered |
| No voter PII in API | `/state` and vote payloads omit UIDs / voter names | covered |
| Pending stash isolation | Rejected Playlist B propose / clearStash must not wipe Playlist A's tracks; A still queues once | covered |
| Deadline without `/state` | Past window + next propose terminalises the open vote (no indefinite `vote_running`) | covered |
| Unavailable ≠ empty electorate | Electorate lookup null → ballot 503 / deadline `listeners_unavailable`; `[]` → B2 deadline closeSilent | covered |
| Deadline queue history | `/state`/ballot/cancel/withdraw settle records request history once; hide → no history | covered (#628) |

## B4 matrix (covered by `playlist-vote-chat.test.ts` + shared B3 settle)

| Area | Check | Status |
| --- | --- | --- |
| Valid yes → threshold | Chat yes reaches threshold and queues once with history | covered |
| Requester no | Chat no cancels; nothing queued / no history | covered |
| Non-listener / stale identity | Live clid+uid check rejects outsider and mismatched uid | covered |
| Hidden playlist | Post-deadline chat cannot queue after hide; no history | covered |
| Deadline revalidation | Still-requestable post-deadline chat settle queues once with history | covered |
| Concurrent remote+chat | Real HTTP vs chat races (both orderings + deadline `/state` settle + successor stash) in `cross-interface-race.test.ts` | covered |
| Unavailable listener lookup | Bridge throw fails closed; nothing queued | covered |
| Bot unavailable / revoke | Move/disconnect and requester revoke cancel; chat cannot approve | covered |
| Private replies | Replies omit UIDs, session tokens, and file paths | covered |
| Shared runtime | Chat resolves runtime via `playlistVotesForRemote` (lifecycle WeakMap) | covered |

## Manual / follow-up in R2 review

- [ ] Two real TeamSpeak clients: pass / fail / cancel (remote + `!playlistvote`)
- [ ] Confirm channel announces ≤2 messages per vote once B4a lands
- [ ] Confirm ballot rate limit 10/min under load (remote + chat share `checkBallotRate`)
- [ ] Confirm bot cooldown 120s and failed-requester 5m after real closes
- [ ] Code review: queue hook re-reads songs at approval; no partial `addMany`
- [ ] **Stash ownership:** concurrent foreign propose / same-playlist retry must not clear or replace another open vote's pending tracks
- [ ] **Unavailable electorate:** lookup `null` must not be treated as `[]`; ballots 503; deadline → `listeners_unavailable` (no pass)
- [ ] **Deadline without further API activity:** open vote stays open until a later request/state settles it; must not block forever once something authenticates after the window
- [ ] **Mid-vote permission/settings changes:** playlist hide / remoteAccess demotion / maxRequestSize shrink at approval fail closed; threshold changes do not rewrite an already-open vote's stored percent
- [ ] **Exactly-once queue:** proposal sole-pass, ballot threshold pass, deadline tick, and chat/remote concurrent ballots each queue at most once through the sync hook
- [ ] Independent Thermos R2 on B4 draft + explicit owner GO before merge (do not merge B4a/B4b; keep #617 draft; keep #609 open)
- [ ] **Follow-up (nit):** mid-window threshold pass (chat + remote PUT) still duplicates start+history vs shared settle `onQueued` — behaviour matches; share helper only if drift appears
