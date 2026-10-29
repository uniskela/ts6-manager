# D1 live observations (SHA `7f4d6c7`)

Operator private-beta, not the disposable laboratory. Do not mark Bridge-D1 A–D PASS from this note.

## Confirmed sequence

1. Both audio directions worked for an extended period. TeamSpeak music-bot playback was audible in Discord.
2. Additional TeamSpeak clients joined. Discord slot bots joined as occupancy required.
3. TeamSpeak → Discord later went silent while Discord → TeamSpeak was still reported working.
4. A later status snapshot showed `health=fail-closed`, receiver `slot-0`, generation 15, `daveReady=false`, `recoveries=0`, `scheduledReconnects=0`, cumulative `framesSent=45695`.
5. Receiver events: `slot-0` → `slot-2`, then back to `slot-0`, then DAVE lost on `slot-0` and still unready ~7.5 minutes later.

`framesSent` is cumulative Discord → TeamSpeak. It does not prove that direction was live at the snapshot. Do not claim both directions at that instant.

## Health: bots-only park vs fail-closed

With only bridge bots in the mapped Discord channel, the worker parks the MLS wait: the voice connection is kept, audio boundaries stay fail-closed, single-attempt does not charge a reconnect. Status previously reported that as `fail-closed` and Docker `unhealthy`.

This branch reports that as `health=parked` when `knownBotsOnly` is true (voice-state cache **and** MLS `connectedClients`, same predicate as the audio idle park), including initial bots-only MLS wait before a receiver is elected. Occupancy integers `voiceMembers`/`voiceBots` stay diagnostic; equal bot counts alone must not park, because a human can be in MLS peers before voice-state cache updates. A human-present DAVE failure and unknown membership stay `fail-closed`.

AudioPlayer / sender DAVE / reconnect lifecycle is owned by a separate investigation. Do not treat this note as that root cause.

## Music-bot exclusion

Bridge-K: music bots and system clients are excluded by default (`client_type`, known `MusicBot` uniqueIds).

Private-beta `BridgeRuntime` is constructed **without** `excludedUniqueIds`. TeamSpeak music bots are ordinary clients (`client_type` 0), so they take slots and are forwarded. That matches the operator hearing music-bot audio in Discord. Do not change product policy here; an opt-in remains a separate decision.

The pipeline already drops `excludedUniqueIds` and ServerQuery clients when that set is supplied (`runtime.exclusion.test.ts`, `core.test.ts`).

## Nickname synchronisation

`ClientDirectory` updated the nickname cache on `notifyclientupdated` and emitted no directory event, so Discord nicks often stayed stale (music-bot titles especially). `applyNickname` also marked a name applied before Discord confirmed. This branch emits `nick` and only records success after Discord accepts, with an epoch so a late response cannot overwrite a newer name. UniqueId→slot mapping is unchanged. Audio, DAVE, and election are not touched by that path.

## Counters added (detailed status only, `0600`)

Aligned with the restricted snapshot table in Draft PR #564's investigation report. `host-status.json` stays the short view. No tokens, uniqueIds, usernames, host addresses, audio, or crypto material.

| Report boundary | This branch | Not here |
| --- | --- | --- |
| TS UDP before decrypt | `tsWhisperDropped` (non-channel voice after decrypt emit) | Packet-type totals, encrypted vs unencrypted, auth success/fail, receive generation, rollover success, time since last valid channel voice. Those need tslib `client.ts` instrumentation owned by #564. |
| Directory/router | `t2dReceived`, `t2dForwarded`, `t2dMalformed`, `t2dUnknownSpeakers`, `t2dOwnVoice`, `t2dExcluded`, `t2dNotInChannel`, plus unsupported/invalid/decode/voice-stop | None of those drop reasons include identities. |
| Each required slot | `senders[id]`: `inChannel`, `healthy`, `daveReady`, `playerStatus`, occupancy integers `voiceMembers`/`voiceBots`, health `parked` vs `fail-closed` | Connection status string, subscription presence/identity match, unknown-vs-human member split. |
| Sender/feed | `framesSent` (feed offers), `playbackDropped`, `playbackStarved`, `playbackHealthRejected`, `playbackDaveRejected` | Queued depth, prepare/dispatch success, last-success age. `forwarded` still counts sink calls even when sendOpus rejects. |
| Lifecycle | existing recoveries / scheduledReconnects / event ring | Fixed reason-category enum for join/leave/undeafen/destroy. |

Incoming TeamSpeak **packet generation and authentication failures are not exposed here** so this branch does not edit `packages/backend/src/voice/tslib/client.ts` (PR #564).

## Notes for the TeamSpeak → Discord audio investigation

These are source facts, not a claimed live root cause:

- Encrypted receive-generation wrap (65,536 packets) is reproduced on #564. Incident attribution remains unproven: encryption mode and packet count were not in the old status file.
- `TsToDiscordPipeline.forwarded` still counts sink calls when `sendOpus` returns without playing. New `playbackHealthRejected` / `playbackDaveRejected` split that silent return.
- Private-beta health previously used **receiver** DAVE and Discord → TeamSpeak `framesSent` only.
- Repeated slot join logs are expected when TeamSpeak uniqueIds appear; `recoveries=0` means those were not budgeted reconnects.
