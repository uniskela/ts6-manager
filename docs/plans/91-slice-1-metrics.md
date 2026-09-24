# Plan: #91 Slice 1 — Native TeamSpeak metrics data source

Status: **fixture gate PASSED on [#126](https://github.com/uniskela/ts6-manager/pull/126) branch evidence only; still FAILED on `main`** (implementation not started on `main`).  
Merged onto `origin/main` @ `cdb6c3d` (after Slice 2 / PR #114 merged as `2a096bf`, the appearance work in PR #122, and PR #121 itself landing as `cdb6c3d`).

Design attribution for the deltas below: Codex read-only analysis grounded on `main` @ [`bdcbaf3`](https://github.com/uniskela/ts6-manager/commit/bdcbaf3516cb4b886e87e3019133af7cc2964b24), plus inspection of the candidate fixture on [#126](https://github.com/uniskela/ts6-manager/pull/126) head `3ffe375` (not an implementation review of #126).

Supersedes the discovery-only draft merged from PR #121 (`cursor/docs-91-slice-1-plan-c289`, commit `cdb6c3d`), which was written against older `main` and assumed #114 was still open. Do **not** implement #121's architecture unchanged; this fixture-gated plan is the authoritative one going forward. #121's current-state findings on existing building blocks (`validate-ts-host.ts`, `webquery-client.ts`, `connection-pool.ts`, `TsServerConfig` schema) remain accurate background reading but do not change the blocking gate or architecture below.

**Do not merge Release Please [#120](https://github.com/uniskela/ts6-manager/pull/120)** based merely on the presence of #126.

## Blocking gate (Codex review contract)

Before any allow-listed metric names, typed mapper, or dashboard field mapping land in application code:

1. Confirm dashboard route: **`GET /api/servers/:configId/vs/:sid/dashboard`** (verified on current `main` in `packages/backend/src/app.ts` + `dashboard.routes.ts` + frontend `dashboard.api.ts`).
2. Obtain a **real** TeamSpeak 6 **beta13** Prometheus text exposition dump.
3. From that dump (and only that dump), confirm:
   - exact metric **names**;
   - exact **labels** (especially any virtual-server identifier);
   - HTTP **content-type**;
   - whether samples are **scoped to a SID** or instance-wide / unscoped.

### Gate status (reconciled)

| Branch / evidence | Gate status |
|-------------------|-------------|
| `main` @ `bdcbaf3` | **FAILED** — capture instructions exist under `packages/backend/src/ts-client/__fixtures__/README.md`, but **no dump is on `main`**. |
| [#126](https://github.com/uniskela/ts6-manager/pull/126) head `3ffe375` | **PASSED (candidate only)** — substantive fixture `ts6-beta13-metrics.txt` with headers/metadata reporting beta13, HTTP 200, and `text/plain; version=0.0.4; charset=utf-8`. Capture’s `TSSERVER_METRICS_VOICE` setting is explicitly unknown. Codex inspected that evidence; it did not independently reproduce the capture. |

Until the accepted fixture lands on `main` (or an implementation PR that integrates #126 against this contract), **do not invent metric names or claim the main-branch gate passed**. Evaluate #126 against this contract before treating Slice 1 as complete.

Capture instructions live in `packages/backend/src/ts-client/__fixtures__/README.md`. Reconcile the fixture filename with the plan when integrating (`ts6-beta13-metrics.txt` on #126 vs prior `beta13-metrics.txt` wording).

## Confirmed facts (safe to rely on without a fixture)

From official TeamSpeak 6 server docs (`teamspeak/teamspeak6-server` `CONFIG.md`) and this repo's compatibility notes:

| Fact | Evidence |
|------|----------|
| Endpoint path | `GET /metrics` |
| Default port | `9187` (`TSSERVER_METRICS_PORT` / `--metrics-port`) |
| Protocol | Separate HTTP listener (do **not** inherit WebQuery `useHttps`) |
| Auth | Unauthenticated by design |
| Bind | `TSSERVER_METRICS_IP` / `--metrics-ip` (default localhost-only) |
| Enable | `TSSERVER_METRICS_ENABLED` / `--metrics-enable` (default off) |
| Voice extras | `TSSERVER_METRICS_VOICE` adds per-packet voice diagnostics (overhead) |
| Format family | Prometheus text exposition (names/labels **not** documented in CONFIG.md) |

**Still unknown without a fixture on `main`:** final accepted metric names, label keys/values, content-type string, and whether any label uniquely identifies `sid` / virtual server. Candidate answers exist only on #126 (see allow-list delta below).

## Current-state findings (Codex @ `bdcbaf3` + #126 inspection)

- Main’s dashboard remains WebQuery-based. The pool owns WebQuery clients; #114 supplies SID validation and staged diagnostics.
- The frontend currently expects bandwidth in bytes/second, ping in milliseconds, and packet loss as a ratio.
- The #126 candidate shows one virtual server, not a multi-server isolation demonstration.
- SID alone cannot prove that a separately configured metrics listener belongs to the same TeamSpeak server.
- The fixture’s packet-loss classes are not equivalent to the dashboard’s existing total-loss field.

## Intentionally unsupported topologies (Slice 1)

- **Unscoped / instance-wide metrics as a dashboard source for a selected SID.** If the real dump proves samples lack an exact virtual-server identifier that matches the selected SID, mark metrics `unavailable` with reason `unscoped` and return the normal WebQuery dashboard. Do **not** claim unscoped metrics support.
- Browser-supplied scrape host/port/SID for outbound construction (SSRF).
- Metrics listener over WebQuery HTTPS settings by silent inheritance.
- Raw Prometheus dump passthrough to clients.
- Background / always-on scraper (keep React Query view-scoped polling only).
- Bundled Prometheus/Grafana or persistent time-series storage.
- Demo mode network scrapes (demo stays network-free, WebQuery/demo only).

## Architecture (authoritative for implementation — replaces #121)

### 1. WebQuery remains the Slice 1 base

`DashboardData` identity and structure fields (name, platform, version, channels, authenticated VS context, etc.) continue to come from authenticated WebQuery. Native metrics **augment** capacity/traffic/runtime fields only after a proven allow-list exists.

### 2. Concurrent best-effort metrics fetch (non-blocking)

When `metricsEnabled` is true, the dashboard route starts WebQuery and metrics **concurrently**. Make the “must not delay WebQuery” requirement executable:

- Start both sources together.
- When WebQuery completes, use already-completed valid metrics **or** return WebQuery immediately and **cancel** the outstanding scrape.
- A simple `Promise.all` would still wait for metrics — do not use that pattern.

A metrics timeout/failure must **not** serialize ahead of WebQuery and must not delay or fail the WebQuery path.

### 3. Composite provenance (not a single `kind` enum)

```ts
dataSource: {
  webquery: { status: 'current' | 'unavailable'; fetchedAt?: string },
  metrics: {
    status: 'disabled' | 'current' | 'unavailable';
    fetchedAt?: string;
    reason?: 'timeout' | 'unreachable' | 'invalid' | 'unscoped';
  };
}
```

UI copy:

- WebQuery only → “WebQuery only”
- WebQuery + scoped metrics → “WebQuery + native metrics”
- Never label a mixed response as metrics-only

Only advertise augmentation when a valid metric field was actually used. Preserve WebQuery values when optional metric samples are absent or invalid. Reject non-finite, negative, contradictory, and ambiguous values rather than converting them to zero.

### 4. Fail closed on scoping (identity join)

Resolve the selected SID through `teamspeak_virtualserver_info.virtualserver_id`, obtaining `virtualserver_unique_identifier`. Require that UID to agree with authenticated WebQuery identity, then accept only samples carrying that exact UID. Missing, ambiguous, conflicting, or mismatched identity fails closed as `unscoped`.

If metrics cannot be **proven** scoped to the selected SID (exact VS identifier on samples), set `metrics.status = 'unavailable'`, `reason: 'unscoped'`, omit metrics-derived fields, and return the normal WebQuery dashboard.

### 5. Allow-list only (candidate from #126 dump)

Typed, documented allow-list derived from the real fixture. Parser supports only the Prometheus text subset needed for that fixture. Missing optional metrics are **omitted** — never filled with misleading zeroes.

Candidate allow-list from the inspected #126 dump (integrate only after evaluating #126 against this contract):

| Dashboard field | Observed source and rule |
|-----------------|--------------------------|
| Online users | `teamspeak_clients_online` minus `teamspeak_query_clients_online`; require both valid counts |
| Capacity | `teamspeak_max_clients` |
| Channels | `teamspeak_channels_online` |
| Incoming/outgoing bandwidth | `teamspeak_connection_bandwidth_bytes_per_second`, exact `received`/`sent` direction |
| Ping | `teamspeak_ping_seconds` × 1,000 |
| Uptime | Retain WebQuery initially; the proposed calculation uses an unscoped host timestamp |
| Total packet loss | Retain WebQuery; do not substitute the `speech` class or average class ratios |

### 6. Security / validation

- `validateTsQueryServerId` on `sid`; preserve `serverAccess`; verify SID belongs to the configured connection.
- Outbound metrics URL built only from **persisted** admin config (never from the dashboard request body).
- Reuse PR #114 helpers already on `main`: `validateTsQueryServerId`, host validators, diagnostics redaction patterns.
- Separate `MetricsClient` from the WebQuery flood queue.
- Reject redirects; real response-stream byte cap (including decompressed); short timeout/abort; status + content-type checks.
- **No** WebQuery API key/auth header on metrics requests.
- No raw upstream errors to clients; SSRF/network tests required.
- **DNS / rebinding:** Validate DNS resolution at connection time and use the validated address for the actual connection. A separate validation lookup followed by an unrestricted second lookup leaves a rebinding gap.

### 7. Config surface

| Field | Default | Notes |
|-------|---------|-------|
| `metricsEnabled` | `false` | Opt-in; no behavior change for existing connections |
| `metricsPort` | `9187` | Validated with existing port helpers |
| `metricsHost` | **optional**; default = WebQuery `host` server-side | Needed because `TSSERVER_METRICS_IP` may bind a different address than WebQuery. Admin-only on create/update/list/get. Validated with host helpers. Never accepted from the dashboard request. |

Metrics listener is **HTTP** unless a future real fixture/docs prove otherwise — do not silently inherit `useHttps`.

Schema changes use this repository’s **Prisma `db push` plus `SCHEMA_VERSION`** mechanism (not a migration-history workflow), then `pnpm db:generate` when implementing.

### 8. Connection pool / routes

- Separate metrics registry/getter or composite client; do **not** weaken `WebQueryClient` / `getClient()`.
- Lifecycle create/destroy on initialize/add/refresh/remove/destroy.
- Demo = network-free, WebQuery-only/demo.
- Admin RBAC for metrics fields on create/update/list/get.

### 9. Frontend (when implementing)

- `ConnectionFormState`, defaults, Settings save/edit, `ConnectionFormDialog`, `ConnectionSetupWizard`, `connection-setup.ts`
- Inline guidance: metrics listener is unauthenticated → keep private
- Update local `DashboardData` + accessible source/freshness badge
- Preserve React Query polling; no background scraper
- Also: `serve-production.mjs`, Playwright fixtures

### 10. Docs (when behavior is stable)

- Update `docs/teamspeak-compatibility.md` with real endpoint/config/privacy/scoping from the fixture.
- Update `docs/roadmap.md` **only after** behavior is stable.
- Do not claim unscoped metrics support.

## Implementation steps (post-fixture)

1. Accept and integrate the capture evidence (evaluate #126 against this contract; land fixture on `main` or with the implementation PR).
2. Document the identity join and conservative mapping; write fixture-driven parser/mapper tests.
3. Prisma fields + `SCHEMA_VERSION`; `pnpm db:generate`.
4. Verify transport restrictions (`metrics-client.ts` + SSRF/timeout/size/redirect/DNS tests; no auth header).
5. Wire pool lifecycle and non-blocking composite dashboard route.
6. Frontend config + provenance badge; Playwright/demo/`serve-production.mjs`.
7. Compatibility docs; optional beta13 live check if Docker available.
8. Conventional commit `feat: …`; no hand-bumped versions.

## Affected files

The authoritative plan, fixture documentation, Prisma schema/`SCHEMA_VERSION`, metrics parser/mapper/client, connection pool, server/dashboard routes, shared response types, connection forms, dashboard, and corresponding fixtures/tests under `packages/backend/` and `packages/frontend/`.

## Tests

Include fixture-derived mapping; conflicting SID/UID mappings; a metrics listener for the wrong server with the same numeric SID; missing Query counts; optional fields; duplicate samples; units; and traffic-class semantics. Verify fast WebQuery with hanging metrics, WebQuery failure, cancellation, redirects, DNS/address restrictions including IPv6 forms, chunked/compressed oversize responses, timeouts, content type, RBAC, credential absence, demo isolation, and truthful frontend provenance.

## Verification commands (when implementing)

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @ts6/backend run typecheck
pnpm --filter @ts6/frontend run typecheck
pnpm lint
mapfile -t tests < <(find packages/backend/src -type f -name '*.test.ts' | sort)
pnpm exec tsx --test "${tests[@]}"
```

## Risks and rollback

| Risk | Mitigation |
|------|------------|
| Cross-server attribution | UID identity join; fail closed as `unscoped` |
| Silently changing metric meaning | Conservative allow-list; retain WebQuery for uptime / total packet loss |
| Metrics delaying dashboard | Concurrent fetch + cancel on WebQuery completion |

Keep the feature disabled by default; disabling metrics must immediately restore ordinary WebQuery behavior. Do not merge #120 based merely on the presence of #126.

## What this docs update ships

Plan deltas only (gate reconciliation + architecture deltas from Codex Jobs 1–5 analysis). No application code, no invented metrics beyond documenting the #126 candidate allow-list, no version bumps. Refs #91.
