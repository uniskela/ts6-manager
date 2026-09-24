# Plan: #91 Slice 5 — TeamSpeak activity journal

Status: **design approved (Codex analysis); implementation not started**.  
Design attribution: Codex read-only analysis grounded on `main` @ [`bdcbaf3`](https://github.com/uniskela/ts6-manager/commit/bdcbaf3516cb4b886e87e3019133af7cc2964b24).

Refs: [#91](https://github.com/uniskela/ts6-manager/issues/91), prerequisite enrichment [#74](https://github.com/uniskela/ts6-manager/issues/74) (still open). Do not merge Release Please [#120](https://github.com/uniskela/ts6-manager/pull/120) based on this plan.

## Findings

1. EventBridge emits connection/SID-scoped `tsEvent` notifications and separate connection-status events.
2. Main forwards client notifications without the metadata enrichment requested by [#74](https://github.com/uniskela/ts6-manager/issues/74), which remains open.
3. SSH sessions are demand-driven.
4. Bot-engine cleanup can close sessions and `stop()` removes all `tsEvent` listeners, which would interfere with a separately attached journal subscriber.

## Assumptions

- The journal is observational: disconnected periods cannot be reconstructed.
- `client_type=0` means a voice client, not proof of a human.
- Bot classification requires known identity; nicknames alone are insufficient.
- Validate enter/leave notification semantics so view changes or initial registration do not become false connection events.

## Architecture

1. **Model** — Separate `ClientActivity` model: event ID, observed-at timestamp, connection/SID, connection generation, join/leave or explicitly classified event kind, client ID, and optional nickname/UID/database ID.
2. **Classification** — Record identity provenance and classification as known bot, Query, voice client, or unknown. Present “human” only where evidence supports it.
3. **Allow-listed fields** — Persist only allow-listed identity/context fields. Exclude IP addresses, raw notifications, chat text, arbitrary metadata, and GeoIP.
4. **Shared enrichment** — Enrich at one shared EventBridge boundary so flows and the journal receive the same payload. Cache by connection + SID + generation + client ID. Actual event fields take precedence over cached fields.
5. **Cache lifecycle** — Clear identity caches on disconnect/reconnect/teardown; evict after leave. Missing cache entries still produce journal records with unknown metadata. A startup snapshot may seed identities but must not manufacture join events.
6. **Stream ownership** — Reuse the main EventBridge stream and ignore command-listener duplicates. Do not collapse genuine rapid leave/rejoin sequences through broad time-based deduplication.
7. **Session ownership** — Add explicit session ownership for flows, music features, and opted-in journal capture. Removing one consumer must not disconnect others. Replace broad listener removal with removal of the engine’s own listener.
8. **Capture** — Opt-in per selected connection/SID. Show Disabled, Connecting, Capturing, Interrupted, and persistence-error states. Continued capture is event-driven; history reads need no short-interval polling.
9. **Queues** — Bounded persistence queues with visible loss/gap reporting on overflow or write failure.
10. **Retention** — **7 days, 10,000 rows per connection/SID, and a global 100,000-row cap**, plus bounded field sizes. Start with admin-only read/configuration access and cursor pagination.

Schema deployment follows **Prisma `db push` plus `SCHEMA_VERSION`**.

## Implementation steps

1. Land [#74](https://github.com/uniskela/ts6-manager/issues/74)’s shared enrichment first or alongside a focused prerequisite PR.
2. Fix session/listener ownership so journal capture does not fight the bot engine.
3. Add bounded journal persistence and retention.
4. Expose scoped read API and capture status.
5. Add history UI.

The journal must remain useful when enrichment is missing; #74 is not permission to discard incomplete events.

## Affected files

| Area | Paths |
|------|--------|
| Events / engine | `packages/backend/src/` EventBridge and bot `engine.ts` (current locations) |
| SSH | SSH registration status if needed |
| Schema | `packages/backend/prisma/schema.prisma`, `packages/backend/prisma/SCHEMA_VERSION` |
| Journal | New journal service / routes / types under `packages/backend/src/` |
| Lifecycle | Startup/shutdown integration |
| Frontend | History UI under `packages/frontend/src/` |
| Docs / tests | #74 flow/template documentation and tests |

## Tests

- Enter → leave enrichment; leave without cache
- Identical client IDs across servers; client-ID reuse after reconnect
- Authoritative event-field precedence; duplicate listeners
- Channel movement versus disconnect
- Known bots versus unknown voice clients
- Snapshot races; missing SSH/permissions
- Flow shutdown while journal capture continues
- Queue overflow / write failure; retention
- Authorization; context changes while history loads

## Risks and rollback

| Risk | Mitigation |
|------|------------|
| Identity reuse across reconnects | Cache keyed by connection + SID + generation + client ID |
| Duplicate notifications | Ignore command-listener duplicates; no broad time-based collapse |
| SSH slot / flood limits | Explicit multi-consumer session ownership |
| Invisible capture gaps | Visible Interrupted / persistence-error states and queue overflow reporting |

**Rollback:** Disable journal capture and release only its session ownership; existing flow/music consumers must continue. Retain or expire journal records under the documented policy. No hand-bumped package versions.
