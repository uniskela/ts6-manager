# Plan: #91 Slice 3 — Logs 2.0

Status: **design approved; implementing on `cursor/logs-2-0-paging-2c1f`**.  
Design attribution: Codex read-only analysis grounded on `main` @ [`bdcbaf3`](https://github.com/uniskela/ts6-manager/commit/bdcbaf3516cb4b886e87e3019133af7cc2964b24).

Refs: [#91](https://github.com/uniskela/ts6-manager/issues/91). Keep separate from metrics Slice 1. Do not merge Release Please [#120](https://github.com/uniskela/ts6-manager/pull/120) based on this plan.

## Findings

1. The admin-only backend forwards `lines`, `reverse`, `instance`, and `begin_pos` to `logview`.
2. The UI fetches one batch of 50–500 lines, filters that batch locally, displays raw timestamps, and classifies unknown levels as INFO.
3. It does not expose pagination or explicit query-error presentation.
4. Shared date/time, page-header, refresh, and stale-data components already exist.

## Assumptions

- Verify beta13’s actual cursor semantics, response metadata, timestamp timezone, and rotation behavior before implementing pagination or timestamp conversion.
- A selected SID identifies the request context; it does not automatically establish every row’s source context.

## Architecture

1. **Route** — Retain the existing scoped, admin-only route. Validate scalar parameters and enforce a bounded source page size.
2. **Page envelope** — Return a typed page with entries, requested context, fetch time, and a verified continuation cursor when available. Preserve source text and source timestamps.
3. **Cursors** — Never derive a byte cursor from displayed string length or invent a total result count.
4. **Paging UX** — Start with one bounded page plus Previous/Older navigation and a small cursor stack. Refresh restarts at the newest page. No server-side log retention.
5. **Filters** — Label search and level filters **“this page”**. Do not silently fetch the entire history to satisfy a filter.
6. **Parsing** — Parse recognized fields conservatively. Unknown levels remain Unknown; unparsed rows remain visible.
7. **Timestamps** — Offer Browser local and UTC presentation only for timestamps whose source timezone is established. Otherwise show the source timestamp with “timezone unknown.” Preserve raw timestamps in details.
8. **Context labeling** — Distinguish connection, selected VS, and instance-log mode. Never label an instance-wide row as belonging to the selected VS without evidence.
9. **Shared UX** — Use shared loading/error/stale patterns, with “No entries” separate from “No matches” and fetch failure. Bound scrolling inside the log panel and wrap long content.

## Implementation steps

1. Confirm source behavior with representative beta13 `logview` responses (cursor, timezone, rotation).
2. Add validation and typed page contract on the backend route.
3. Implement paging and conservative parsing.
4. Apply filtering / time / context UI.
5. Add production tests and operator documentation.

Keep this slice separate from metrics.

## Affected files

| Area | Paths |
|------|--------|
| Backend | `packages/backend/src/routes/logs.routes.ts` (or current logs route) |
| Frontend page | `packages/frontend/src/pages/ServerLogs.tsx` |
| API client | Existing logs API in `packages/frontend/src/api/bans.api.ts` (current location) |
| Shared | Log types / parser / formatting under frontend (and shared types if present) |
| Demo / tests | Demo responses and production Playwright / backend tests |

## Tests

- Larger pages, boundaries, empty pages
- Cursor rotation / invalidation
- Malformed parameters
- Instance vs VS distinction
- Unknown levels; Unicode and escaping
- Unparseable timestamps; DST / local / UTC presentation
- Initial errors versus stale refresh errors
- Context switches during requests
- Admin authorization
- Narrow-screen overflow

## Risks and rollback

| Risk | Mitigation |
|------|------------|
| Source rotation invalidates cursors | Offer Refresh rather than silently duplicating/skipping history |
| Incorrect timezone inference | Prefer explicit “timezone unknown” over wrong conversion |
| Over-fetching for filters | Keep filters page-local and labeled |

**Rollback:** UI/API change is reversible without database migration or retained log data. No version hand-bumps.
