# Discord listener presence in the D1 private preview

## Decision

Show the verified Discord voice-channel occupancy on the existing bridge client's TeamSpeak nickname. With one silent participant, TeamSpeak shows `[DC] 1 in voice` in the mapped channel. Zero restores `ts6-bridge-d1-beta`. The count includes speaking and silent humans. It conveys occupancy without exposing identities.

The October Presence-1 spec on main reserves a named roster for after D1 acceptance and persistent TeamSpeak identity. This branch implements an anonymous, DAVE-gated private preview under the November handover. The product milestone retains its original prerequisites. Individual roster entries would each need a connected TS protocol client with its own identity, socket, handshake, and slot. A ServerQuery connection cannot supply a regular voice client entry. The shared bridge client can present the occupancy without those sessions.

## Existing behavior

- `packages/discord-bridge/src/bridge/runtime.ts:245` seeds the router from TeamSpeak membership. `desiredMembers()` at line 486 already keeps slot 0 in the Discord channel when there are no occupied TS slots. `src/bridge/runtime.dave-idle.test.ts` verifies that a late human can establish DAVE on that parked connection.
- `src/adapters/discord-bot.ts:213` observes voice-state updates independently of speech. `src/core/voice-admission.ts` and `src/core/discord-to-ts.ts` gate received audio separately. `src/core/human-filter.ts` verifies human identity using cached Discord data and bounded lookups for unknown users.
- `src/adapters/ts-session.ts:44` sets the nickname on connect. The backend's avatar code demonstrates a correlated reply for `clientupdate` using the existing TS transport. The preview uses that command on the bridge's own connection.

## Behavior and failure handling

The private-beta runner reads the elected bot's current mapped guild voice-state cache every two seconds. It requires a ready gateway, an available guild, a healthy bot in the mapped channel, and an established, identifiable DAVE session. It counts only users that pass the bot's existing human filter. Every poll reads current membership, so a late lookup cannot re-add a departed user. Presence generates no Discord join demand and uses no additional bot identity. Voice admission and mixing follow their existing paths.

The TeamSpeak nickname update is coalesced and serialized using the last acknowledged count. Leave, move, voice transport loss, gateway unavailability, and DAVE loss cause the next eligible update to clear or recompute the display. A failed or unacknowledged TS update makes the displayed state uncertain. Retry from live state after a 30-second hold to respect flood limits. TeamSpeak may retain the previous count until it accepts the correction. The worker only emits a fixed diagnostic for an update failure. Shutdown cancels the timer and reply listener, then the existing TeamSpeak disconnect removes the entry.

The preview sends only a fixed nickname and aggregate count to TeamSpeak. Both status schemas retain their existing field allowlists. It adds no identifiers, audio, or raw command errors to evidence or logs.

## Verification

Exercise a silent listener with zero TeamSpeak speakers using the offline Discord runtime harness. Check authentication gates, identity lookup settlement, leave/move, bot failure, DAVE loss, and shutdown. Verify coalescing, command acknowledgment, and refusal retry with synthetic TeamSpeak replies. Check the full bridge suite, native dependency smoke, and isolated container probes.

For an authorized live session, use the TeamSpeak client list itself to verify the nickname changes. Listen at both ends when evaluating audio. The earlier one-way investigation shows that frame counters can rise while audio is silent, and that the cause of the prior private-beta incident remains unresolved. Offline tests do not establish TS6 nickname acceptance or native Discord MLS behavior.
