# Plan: #91 Slice 1 — Native TeamSpeak metrics data source

Status: **fixture landed — allow-list + VS-scoped dashboard mapping active** (from `ts6-beta13-metrics.txt`).  
Merged plan onto `origin/main` @ `cdb6c3d` (after Slice 2 / PR #114 merged as `2a096bf`, the appearance work in PR #122, and PR #121 itself landing as `cdb6c3d`).

Supersedes the discovery-only draft merged from PR #121 (`cursor/docs-91-slice-1-plan-c289`, commit `cdb6c3d`), which was written against older `main` and assumed #114 was still open. Do **not** implement #121's architecture unchanged; this fixture-gated plan is the authoritative one going forward. #121's current-state findings on existing building blocks (`validate-ts-host.ts`, `webquery-client.ts`, `connection-pool.ts`, `TsServerConfig` schema) remain accurate background reading but do not change the blocking gate or architecture below.

## Blocking gate (Codex review contract)

Before any allow-listed metric names, typed mapper, or dashboard field mapping land in application code:

1. Confirm dashboard route: **`GET /api/servers/:configId/vs/:sid/dashboard`** (verified on current `main` in `packages/backend/src/app.ts` + `dashboard.routes.ts` + frontend `dashboard.api.ts`).
2. Obtain a **real** TeamSpeak 6 **beta13** Prometheus text exposition dump.
3. From that dump (and only that dump), confirm:
   - exact metric **names**;
   - exact **labels** (especially any virtual-server identifier);
   - HTTP **content-type**;
   - whether samples are **scoped to a SID** or instance-wide / unscoped.

**Current status of the gate:** **PASSED** — real dump at `packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.txt` (Content-Type `text/plain; version=0.0.4; charset=utf-8`; VS label `virtualserver_unique_identifier`; SID via `teamspeak_virtualserver_info.virtualserver_id`).

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

**Still unknown without a fixture:** metric names, label keys/values, content-type string, and whether any label uniquely identifies `sid` / virtual server.

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

### 2. Concurrent best-effort metrics fetch

When `metricsEnabled` is true, the dashboard route starts WebQuery and metrics **concurrently**. A metrics timeout/failure must **not** serialize ahead of WebQuery and must not delay or fail the WebQuery path.

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

### 4. Fail closed on scoping

If metrics cannot be **proven** scoped to the selected SID (exact VS identifier on samples), set `metrics.status = 'unavailable'`, `reason: 'unscoped'`, omit metrics-derived fields, and return the normal WebQuery dashboard.

### 5. Allow-list only

Typed, documented allow-list derived from the real fixture. Parser supports only the Prometheus text subset needed for that fixture. Missing optional metrics are **omitted** — never filled with misleading zeroes.

### 6. Security / validation

- `validateTsQueryServerId` on `sid`; preserve `serverAccess`; verify SID belongs to the configured connection.
- Outbound metrics URL built only from **persisted** admin config (never from the dashboard request body).
- Reuse PR #114 helpers already on `main`: `validateTsQueryServerId`, host validators, diagnostics redaction patterns.
- Separate `MetricsClient` from the WebQuery flood queue.
- Reject redirects; real response-stream byte cap (including decompressed); short timeout/abort; status + content-type checks.
- **No** WebQuery API key/auth header on metrics requests.
- No raw upstream errors to clients; SSRF/network tests required.

### 7. Config surface

| Field | Default | Notes |
|-------|---------|-------|
| `metricsEnabled` | `false` | Opt-in; no behavior change for existing connections |
| `metricsPort` | `9187` | Validated with existing port helpers |
| `metricsHost` | **optional**; default = WebQuery `host` server-side | Needed because `TSSERVER_METRICS_IP` may bind a different address than WebQuery. Admin-only on create/update/list/get. Validated with host helpers. Never accepted from the dashboard request. |

Metrics listener is **HTTP** unless a future real fixture/docs prove otherwise — do not silently inherit `useHttps`.

Prisma migration + `pnpm db:generate` when implementing.

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

## Implementation checklist (post-fixture only)

1. Commit real `beta13-metrics.txt` (+ note observed content-type / path / SID label).
2. Derive allow-list + scoping rule from the fixture; write fixture-driven parser/mapper tests.
3. Prisma fields + migration; `pnpm db:generate`.
4. `metrics-client.ts` + SSRF/timeout/size/redirect tests (no auth header).
5. Wire pool lifecycle; composite dashboard route (concurrent WebQuery + metrics).
6. Frontend config + badge; Playwright/demo/`serve-production.mjs`.
7. Compatibility docs; optional beta13 live check if Docker available.
8. Conventional commit `feat: …`; no hand-bumped versions.

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

## What this PR ships

Docs + fixture placeholder instructions only. No application code, no invented metrics, no version bumps. Refs #91. Close or supersede PR #121 once this plan is accepted.
