# Plan: #91 Slice 4 — Administrative audit

Status: **shipped on `main`** via [#134](https://github.com/uniskela/ts6-manager/pull/134), [#135](https://github.com/uniskela/ts6-manager/pull/135), [#140](https://github.com/uniskela/ts6-manager/pull/140). Acceptance roll-up: [`91-slice-6-acceptance.md`](91-slice-6-acceptance.md).  
Design attribution (historical): Codex read-only analysis grounded on `main` @ [`bdcbaf3`](https://github.com/uniskela/ts6-manager/commit/bdcbaf3516cb4b886e87e3019133af7cc2964b24).

Refs: [#91](https://github.com/uniskela/ts6-manager/issues/91). Hold Release Please [#120](https://github.com/uniskela/ts6-manager/pull/120) until Slice 6 acceptance is honest.

## Findings

1. Authentication checks the user’s current enabled status and role. Admins have access across connections; viewers use per-server grants.
2. Mutations are spread across route handlers.
3. Prisma has bot execution history but no dedicated administrative audit model.
4. Several handlers accept sensitive payloads; some token values are carried in URL paths, so generic HTTP request logging is unsuitable.

## Assumptions

- Admin-only audit access initially, matching existing administrative surfaces.
- This records Manager-initiated actions; it cannot prove changes made directly through TeamSpeak or reconstruct complete history before installation.

## Architecture

1. **Model** — Dedicated audit model with immutable operation ID, actor ID, action enum, connection ID, optional SID, target type / non-secret identifier, timestamps, outcome, and allow-listed result code.
2. **Retention of identity** — Keep retained context identifiers after user/connection deletion; avoid cascading away the history being audited.
3. **No secret serialization** — Use typed event constructors per action. Never serialize request bodies, raw URLs, headers, responses, flow JSON, snapshots, free-text messages/reasons, credential values, or raw exception text.
4. **Secret changes** — Represent as facts such as “credentials changed,” without old/new values. Resolve authenticated actors server-side and record the actual validated execution target.
5. **Taxonomy** — Moderation; connection changes; VS operations; channel/group/membership/permission changes; flow create/edit/delete/enable/disable; and explicitly enumerated high-impact settings/account writes.
6. **Outcomes** — Record operation stages, not merely HTTP status. A persisted flow edit followed by failed engine reload is partial success, not an entirely failed mutation.
7. **External TeamSpeak writes** — Persist an attempt before dispatch and a result afterward. If the initial audit write fails, reject before dispatch. If dispatch may have succeeded but completion cannot be established, show **unknown outcome** and never automatically retry the mutation.
8. **Local DB changes** — Commit the mutation and success record transactionally.
9. **Retention** — Documented **30 days or 100,000 rows, whichever limit is reached first**, with bounded payloads and chunked cleanup. Show retention in the UI; ordinary users cannot delete audit records.
10. **Read surface** — Admin-only history with bounded cursor pagination and filters for time, actor, action, connection/SID, and outcome. Keep it visibly separate from TeamSpeak activity.

Schema deployment follows this repository’s **Prisma `db push` plus `SCHEMA_VERSION`** mechanism (not a migration-history workflow).

## Implementation steps

1. Agree event coverage and outcome semantics.
2. Add schema / writer / retention.
3. Instrument representative local and remote operations.
4. Extend coverage across the agreed route inventory.
5. Add read API / UI and privacy tests.

Several small PRs are preferable; document coverage until complete.

## Affected files

| Area | Paths |
|------|--------|
| Schema | `packages/backend/prisma/schema.prisma`, `packages/backend/prisma/SCHEMA_VERSION` |
| Service / routes | New audit service, routes, and shared types under `packages/backend/src/` |
| Lifecycle | Application startup/shutdown hooks |
| Mutations | Administrative mutation routes across `packages/backend/src/routes/` |
| Frontend | Admin history surface and navigation under `packages/frontend/src/` |

## Tests

- Secrets absent using sentinel values in nested payloads, errors, token paths, flow definitions, and settings
- Actor spoofing; current-role checks; viewer denial
- Target context; local atomicity
- Upstream success / failure / timeout; partial outcomes; crash recovery
- Audit-storage failure; deleted actors/connections
- Retention limits; stable pagination

## Risks and rollback

| Risk | Mitigation |
|------|------------|
| Audit storage failure blocks admin writes | Make fail-closed policy explicit operationally |
| Not tamper-proof against DB controllers | Document threat model; typed allow-listed fields only |
| Destructive schema downgrade | Rollback retains audit table/data; do not rely on destructive schema push |

**Rollback:** Retain the audit table/data; disable writer/UI. No hand-bumped package versions.
