# R2 security checklist — B3 whole-playlist voting

Authoritative: #465. Functional spec: #442. Draft PR must not merge without R2 + owner GO.

## Matrix (covered by `listener-remote.playlist-requests.test.ts` unless noted)

| Area | Check | Status |
| --- | --- | --- |
| Permission bypass | Propose requires playlist/queue group; ballot is listener-only; cancel is requester-only | covered |
| Identity / client-ID recycling | Live clid+uid+channel membership rechecked; leave channel → 401 | covered |
| Vote replay / double queue | Closed voteId → 404; queue length unchanged on replay | covered |
| Listener / channel membership | Human electorate from live clientlist; requester leave cancels on `/state` tick | covered (cancel path + state maintenance) |
| Playlist visibility changes | Hidden/non-request at approval → `playlist_unavailable`, nothing queued | covered |
| Request size / queue limits | empty / `request_too_large` / `queue_full` all-or-nothing | covered |
| Bot restart / disconnection | `onRestart` drops open votes; nothing queued | covered |
| Session expiry / revocation | Existing listener-remote session auth (shared) | covered by listener-remote suite |
| Concurrency / fail-closed | `vote_running`; listener list null → 503; sync single queue decision in B2 hook | covered |
| No voter PII in API | `/state` and vote payloads omit UIDs / voter names | covered |

## Manual / follow-up in R2 review

- [ ] Two real TeamSpeak clients: pass / fail / cancel
- [ ] Confirm channel announces ≤2 messages per vote once B4a lands
- [ ] Confirm ballot rate limit 10/min under load
- [ ] Confirm bot cooldown 120s and failed-requester 5m after real closes
- [ ] Code review: queue hook re-reads songs at approval; no partial `addMany`
