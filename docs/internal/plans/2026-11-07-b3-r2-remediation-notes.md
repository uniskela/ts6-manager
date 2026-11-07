# B3 R2 remediation notes (private)

Tip after remediation: see PR #624 HEAD. Spec #442 / security #465.

## High — approval-time revalidation

**Root cause:** `ensureOpenBeforeDeadline` → `tickDeadline` could queue via the sync hook using the open-time stash. DELETE cancel/withdraw never called `restashForApproval` / `settleExpiredVote`.

**Fix:**
- DELETE ballot + DELETE cancel call `settleExpiredVote` (restash then tick) before machine mutators.
- Pending stash carries `refreshedAtMs`; post-deadline `queuePlaylist` refuses when `refreshedAtMs < deadlineMs`.
- Restash re-checks the open vote id/playlist after the async load so it cannot overwrite an unrelated channel vote.

## Medium — bot lifecycle

**Root cause:** B2 exposed `bot_unavailable` but nothing wired it; bot disconnect only revoked sessions.

**Fix:** `PlaylistVoteRuntime.cancelBotUnavailable` + `cancelPlaylistVotesBotUnavailable` on disconnect, stop/error, bot move (`revokeDepartedRemote`), and `unregisterBot`. Clears matching stash only for that botKey.

## Medium — admin revoke

**Root cause:** `POST .../revoke` dropped sessions only; peers could still pass an open vote.

**Fix:** Admin revoke calls `cancelRequesterRevoked` (uid) or `cancelAllRevoked` (bot-wide). Grant invalidation cancels only on `revoked` / `rejected` (see lifecycle correction below). Unrelated botKeys untouched.

## Spec correction — session expiry must not cancel (#442)

**Root cause:** `onGrantInvalidated` → `cancelRequesterRevoked` ran for every `remove()`, including `prune()` expiry and `issue()` replacement of a prior `!remote` grant.

**Fix:** `ListenerRemoteService.remove(grant, reason)` with
`expired | replaced | revoked | rejected | error`. Search still clears on all reasons.
Playlist-vote lifecycle cancels only for `revoked` (admin / leave / bot revoke) and
`rejected` (live identity check failed). Expiry and `!remote` replacement leave the
vote open while the requester remains a channel listener.

## Low — status

| Item | Disposition |
| --- | --- |
| Lazy deadline (no timer) | **Retained** — checklist-accepted; settle on propose/ballot/`/state`/DELETE |
| `onRestart` vs pending | **Fixed** — `PlaylistVoteRuntime.onRestart` clears machine open + pending + starts |
| `/state` null electorate display | **Retained** — settle keeps null≠[]; view still uses `listeners ?? []` (display only) |
| History vs queued snapshot | **Fixed** — history uses `takeStart().items` (queued stash), not a second playlist load |
| `permissions.vote: true` | **Fixed** — derived via `authorizeMediaCommand(..., 'voteskip')` (policy currently always allows; identity remains session-gated) |

## Re-review tip

Immutable tip for independent Thermos re-review: PR #624 HEAD after this push (record SHA in the remediation reply).
