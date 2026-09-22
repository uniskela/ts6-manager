# Plan: #91 Slice 1 — Native TeamSpeak metrics data source

Status: **proposed** (not yet implemented). Written against `origin/main` @ `b9cf5a8` (v1.7.1).

> **Codex analysis-only run: did not execute.** `codex exec` (via `npx @openai/codex@0.155.1`,
> `-s read-only`) is installed in this environment but has no authenticated OpenAI credentials
> (`~/.codex` has no auth, no `OPENAI_API_KEY`; the CLI failed with repeated `401 Unauthorized`
> against `api.openai.com`). No architecture, findings, or recommendations below came from a
> Codex pass — this plan is grounded entirely in direct repository inspection (issue #91, `main`,
> and open PR #114). Anywhere Codex's second opinion would normally add value is called out
> explicitly as an **open question** below so a maintainer or a future Codex run can revisit it.

## 1. Current-state findings

**Issue #91 (Slice 1 requirements).** Add TeamSpeak's native metrics interface as an optional,
richer dashboard/diagnostic data source: server-side consumption only, scoped to the configured
connection + selected virtual server, clean fallback to authenticated WebQuery when disabled or
unavailable, explicit data-source/freshness labeling in the UI, no Prometheus/Grafana bundling, no
persistent historical storage, and polling only while a relevant view is active. Security
requirements: never let the browser supply a scrape target, preserve connection/server access
controls and admin-only fields, enforce timeout/response-size/redirect/network-boundary
protections, document that the metrics listener should stay private, and preserve existing SSRF
protections.

**TeamSpeak beta13 native metrics, as already documented in this repo**
(`docs/teamspeak-compatibility.md` "Prometheus metrics" section):

- Disabled by default; when enabled it's a **separate, unauthenticated HTTP endpoint** distinct
 from WebQuery, default port **9187**.
- Bind address controlled by `TSSERVER_METRICS_IP` (operator sets this on the TeamSpeak
 server/container, not on TS6 Manager).
- `TSSERVER_METRICS_VOICE` optionally adds per-packet voice diagnostics (higher overhead).
- Docs already say "TS6 Manager does not scrape or proxy these metrics" — Slice 1 changes that
 statement, so `docs/teamspeak-compatibility.md` and `docs/roadmap.md` need an update once this
 ships (issue's own acceptance criteria: "Public docs are updated after shipped behavior is
 stable").
- Exposition format is the standard Prometheus **text** format (`# HELP` / `# TYPE` / `metric{labels}
 value` lines) — this repo has no existing parser for it and no confirmed TS6 metric-name list
 committed anywhere.

**Existing building blocks to reuse (do not re-invent):**

- `packages/backend/src/utils/validate-ts-host.ts` — `sanitizeTsServerHost`,
 `validateTsServerPort`, `isAllowedTsServerHost`, `assertResolvableTsServerHost`,
 `createValidatedTsServerEndpoint`/`ValidatedTsServerEndpoint`. Already blocks cloud-metadata
 hosts, loopback/private ranges (opt-in via `TS_ALLOW_PRIVATE_HOSTS`, default **true** — self-hosted
 deployments commonly point at LAN/Docker-internal hosts), and non-hostname/IP tricks. This is the
 correct reuse point for "preserve existing SSRF protections" — a metrics fetch is architecturally
 the same shape of outbound call as WebQuery/SSH.
- `packages/backend/src/ts-client/webquery-client.ts` — shows the established pattern for a
 TeamSpeak-server-bound HTTP client: dedicated `axios` instance, `keepAlive` agent,
 `rejectUnauthorized: !config.tsAllowSelfSigned`, fixed timeout, and a `destroy()` teardown. A new
 metrics client should mirror this shape (own agent/instance, not reuse the WebQuery queue — see
 §3).
- `packages/backend/src/ts-client/connection-pool.ts` — per-`TsServerConfig` client lifecycle
 (`addClient` / `removeClient` / `refreshClient` / `destroy`), driven by
 `prisma.tsServerConfig.findMany({ where: { enabled: true } })` at startup and by the
 `PUT /:configId` route on edit. A metrics client (when configured) belongs in this same
 lifecycle so enable/disable/edit/delete stay consistent with WebQuery's.
- `packages/backend/prisma/schema.prisma` `model TsServerConfig` — currently has `host`,
 `webqueryPort`, `apiKey`, `useHttps`, `sshPort`, `sshUsername`, `sshPassword`,
 `sshHostKeyFingerprint`, `enabled`, `isDemo`. No metrics-related columns exist yet.
- `packages/backend/src/routes/dashboard.routes.ts` + `packages/frontend/src/pages/Dashboard.tsx`
 + `packages/frontend/src/hooks/use-dashboard.ts` — the only current "richer runtime" surface.
 WebQuery-only today: `serverinfo` + `clientlist` + `channellist` +
 `serverrequestconnectioninfo` in one `Promise.all`, mapped into a flat `DashboardData` shape
 (`packages/common/src/types/api.ts`). `useDashboard` polls every 10s **only while mounted**
 (React Query `enabled` gate on a valid config/sid) — i.e. the codebase already has the
 "poll only while a relevant view is active" pattern the issue asks for; Slice 1 should extend it,
 not add a second polling mechanism.
- `packages/backend/src/ts-client/demo-webquery-client.ts` + `ConnectionPool.addDemoClient` —
 demo mode returns canned WebQuery-shaped data with no network calls. A metrics data source needs
 an equivalent demo behavior (canned metrics payload, or an explicit "not applicable in demo mode"
 state) so the existing demo tour doesn't regress.
- **PR #114** (`cursor/staged-connection-diagnostics-ad59`, draft, not yet merged, Slice 2 —
 "staged connection diagnostics") is the most directly relevant prior art:
 - `packages/backend/src/ts-client/connection-diagnostics.ts` introduces a
 `DiagnosticWebQueryClient` minimal-surface interface, a `ConnectionDiagnosticReport` /
 `DiagnosticStageResult` staged-result shape (`packages/common/src/types/api.ts`), and an error
 classifier (`network` / `timeout` / `flood` / `auth` / `permission` / `unknown`) that redacts
 secrets from messages via `SENSITIVE_SUBSTRINGS`.
 - It also hardens WebQuery path-building against SSRF/path-injection
 (`validateTsQueryServerId`, `sanitizeWebQueryCommand`, `buildWebQueryPath` added to
 `validate-ts-host.ts`) as a CodeQL `js/request-forgery` follow-up.
 - **This PR is still a draft on `origin`, not merged into `main`.** Slice 1 must not assume its
 types/helpers exist; if #114 merges first, Slice 1 should reuse
 `ConnectionDiagnosticReport`'s "distinguish current/fallback/unavailable" spirit for the
 metrics data-source badge instead of inventing a parallel status enum. If #114 has *not*
 merged when Slice 1 starts, Slice 1 should not take a hard dependency on it — the two are
 independently mergeable per the issue's "independent PRs" instruction — but should keep naming
 (e.g. `DiagnosticStageId`-style stable string enums, redact-before-log discipline) consistent so
 a later merge doesn't produce two divergent status vocabularies.
- **RBAC**: `requireRole('admin')` (`packages/backend/src/middleware/rbac.ts`) is the only role
 gate currently in `servers.routes.ts`/connection config. `UserInfo.role` is
 `'admin' | 'moderator' | 'viewer'`. The issue asks for "role filtering" of metrics validation
 coverage — today there's no per-field RBAC inside a single response payload (e.g. dashboard data
 is all-or-nothing based on route-level auth), so "admin-only fields" for metrics likely means new
 fields, not retrofitting existing ones.
- **No existing metrics/Prometheus code** anywhere in `packages/backend` or `packages/frontend`
 (`rg -i "metric|prometheus"` under `packages/` returns nothing outside docs). This is a
 greenfield addition inside an established codebase, not a refactor.

## 2. Assumptions and open questions

These are the points where a Codex second pass (once credentials are available) would add the
most value; flagging them explicitly rather than guessing an implementation detail:

1. **Exact TS6 beta13 metric names/labels.** Docs confirm the endpoint exists and is
 Prometheus-text-format, but no committed fixture or metric-name list was found in this repo.
 The plan below treats the parser as "parse generic Prometheus text exposition into
 `{ name, labels, value }[]`, then map a *documented allow-list* of known metric names into the
 typed API surface" rather than assuming specific names today. **Action before/at implementation
 start:** capture a real `curl` dump from a live beta13 container with metrics enabled (the repo
 already has TeamSpeak compatibility CI plumbing per `docs/teamspeak-compatibility.md` "Compatibility
 CI" section) and commit it as a test fixture. Do not hand-wave metric names into the shared
 `@ts6/common` types without that fixture.
2. **Per-virtual-server scoping of native metrics.** WebQuery is inherently scoped by `sid` in the
 URL path; it is not yet confirmed from docs alone whether beta13's Prometheus metrics expose a
 `virtualserver_id`-style label for multi-VS filtering or are instance-global. If metrics turn out
 to be instance-global only, the backend must still enforce "scope metrics to the configured
 connection and selected virtual server" by filtering server-side on whatever label is available,
 and by refusing to serve metrics for a `configId`/`sid` pair that doesn't match the caller's
 selected/authorized virtual server — not by trusting the browser's `sid` blindly (same class of
 concern PR #114 just fixed for WebQuery paths).
3. **Where the metrics listener host/port is configured.** Two reasonable designs:
 - (a) New optional fields on `TsServerConfig` (`metricsEnabled`, `metricsHost`, `metricsPort`,
 maybe defaulting `metricsHost` to the existing `host`), or
 - (b) Reuse `host` always, only add `metricsEnabled` + `metricsPort` (since `TSSERVER_METRICS_IP`
 is typically bound to the same TeamSpeak host/interface as WebQuery in the documented Docker
 deployment).
 This plan recommends (b) as the minimal, most consistent-with-existing-fields option (mirrors
 how `sshPort` reuses `host` rather than having its own `sshHost`), but flags it as a decision a
 maintainer should confirm — a fully separate `metricsHost` is one field away if a future
 deployment genuinely runs metrics on a different interface.
4. **Fallback UX granularity.** The issue wants "clearly identify the active data source and
 freshness" in the UI. Given the existing `DashboardData` shape is flat, the cleanest non-breaking
 approach is an additive `dataSource: { kind: 'native_metrics' | 'webquery'; fetchedAt: string }`
 field rather than restructuring `DashboardData`. Confirm with a maintainer before broad rollout if
 a richer per-metric provenance model is wanted later (out of scope for Slice 1 per the issue's
 "avoid persistent historical storage" / "no dozens of raw metrics" UX principles).
5. **Auth model for the metrics endpoint.** Docs say the endpoint is unauthenticated by design
 (beta13 behavior) and must stay off the public internet — TS6 Manager's job is *only* to be the
 one legitimate backend-side consumer, never to expose a pass-through route. Confirmed: no new
 route should ever forward an arbitrary host/port from the request body to the metrics fetch (this
 is the "never expose an arbitrary scrape target" requirement) — only the persisted, admin-set
 `TsServerConfig` value is ever used server-side.

## 3. Recommended architecture

```
Frontend (Dashboard.tsx)
  useDashboard() -> GET /api/servers/:configId/:sid/dashboard
       |
       v
Backend dashboard route
  - if server has metricsEnabled: try MetricsClient.fetch(scoped to sid)
      - success -> map allow-listed metric names into DashboardData + dataSource: 'native_metrics'
      - failure/timeout/parse-error -> fall through to WebQuery path, dataSource: 'webquery'
  - else: WebQuery path only (current behavior, unchanged), dataSource: 'webquery'
```

- **New `MetricsClient`** (`packages/backend/src/ts-client/metrics-client.ts`), independent of
 `WebQueryClient`'s command queue (native metrics is a plain unauthenticated `GET /` scrape, not a
 WebQuery command — it must not share the flood-control queue or its priority semantics, since
 flooding does not apply to a Prometheus text scrape the way it applies to Query commands).
 - Constructed the same way `createWebQueryClient` is: validate host via
 `sanitizeTsServerHost`/`isAllowedTsServerHost` (reuse, do not duplicate), validate port via
 `validateTsServerPort`, build the origin via `createValidatedTsServerEndpoint`.
 - Strict `axios` config: fixed short timeout (e.g. 3–5s — this is a local/LAN scrape, not a
 general HTTP fetch), `maxRedirects: 0` (mirrors PR #114's SSRF hardening on WebQuery),
 `maxContentLength` / `maxBodyLength` capped (e.g. 1–2 MiB, matching the "response-size"
 requirement and PR #114's WebQuery precedent), and a dedicated `http`/`https` agent
 (`keepAlive` optional here since polling is infrequent and view-scoped — a fresh short-lived
 connection per scrape is simpler and avoids holding a socket open when no dashboard view is
 active).
 - No API key / auth header sent (the beta13 endpoint doesn't use one) — this must be explicit and
 commented so a future contributor doesn't assume the same `x-api-key` pattern as WebQuery.
- **New Prometheus text parser** (`packages/backend/src/ts-client/metrics-parser.ts`), pure
 function(s), no network/IO: `parsePrometheusText(raw: string): PrometheusMetric[]` producing
 `{ name: string; labels: Record<string,string>; value: number }[]`, tolerant of `# HELP`/`# TYPE`
 comment lines and quoted label values, rejecting NaN/`+Inf`/`-Inf` samples defensively. Then a
 thin mapping layer `mapMetricsToDashboardExtras(metrics, sid)` that only reads a **documented
 allow-list** of metric names (populated once the real beta13 fixture from §2.1 is captured) and
 ignores everything else — this bounds "avoid dozens of raw metrics" and avoids accidentally
 piping arbitrary high-cardinality label data into the API response.
- **Config surface**: `TsServerConfig.metricsEnabled: Boolean @default(false)` +
 `TsServerConfig.metricsPort: Int @default(9187)` (see §2.3 for the `metricsHost` decision point).
 New Prisma migration, additive/nullable-safe so existing rows default `metricsEnabled=false`
 (preserves current WebQuery-only behavior for every existing deployment — no behavior change
 without an explicit admin opt-in, matching the issue's "optional" framing).
- **`ConnectionPool`**: extend `addClient`/`refreshClient`/`removeClient` to also
 create/destroy a `MetricsClient` alongside the `WebQueryClient` when `metricsEnabled` is true,
 keyed the same way (`Map<configId, ...>`), so lifecycle stays symmetric with the existing
 WebQuery client instead of introducing a second, differently-shaped registry.
- **Dashboard route** (`dashboard.routes.ts`): try native metrics first (bounded timeout), catch
 *any* failure (network, timeout, parse, missing-metric) and fall back to the existing WebQuery
 `Promise.all` path unchanged — the WebQuery path must remain the source of truth for fields
 metrics can't provide (e.g. `serverName`, `channelCount` from `channellist`) even when metrics
 succeeds, i.e. metrics *augments* traffic/runtime numbers rather than fully replacing the WebQuery
 calls in Slice 1. This keeps the fallback genuinely "clean" (no partial/half-populated dashboard)
 and avoids a second, parallel dashboard-shape contract.
- **Types** (`packages/common/src/types/api.ts`): extend `DashboardData` additively with an
 optional `dataSource?: { kind: 'native_metrics' | 'webquery'; fetchedAt: string }` (see §2.4) —
 do not remove/rename existing fields (v1.7 UI/consumers must not regress per the issue's own
 acceptance criteria).
- **Frontend**: `Dashboard.tsx` renders a small badge/label next to the existing "ONLINE" badge
 using `data.dataSource?.kind`, following the existing `Badge` component and
 `RefreshStatus`/`StaleDataNotice` idioms already in the file — no new bespoke status system.
- **Settings/Connection form**: add a `metricsEnabled` toggle (+ port field if `metricsHost` is
 ever added) to `ConnectionFormDialog.tsx`, following the existing `useHttps` toggle pattern
 (`Switch` + `FieldLabel`/`FIELD_HELP`). Include inline help text stating the metrics listener
 should remain private/restricted (per the issue's documentation requirement) rather than only
 covering that in `docs/`.
- **Demo mode**: `DemoWebQueryClient`/`ConnectionPool.addDemoClient` should expose a fixed demo
 metrics payload (or simply report `dataSource: 'webquery'` and skip metrics entirely, if that's
 simpler) so the demo tour doesn't imply a live metrics listener that doesn't exist.

## 4. Implementation steps

1. Capture a real beta13 metrics text dump (per §2.1) and commit it as a backend test fixture
  (e.g. `packages/backend/src/ts-client/__fixtures__/beta13-metrics.txt`) before writing the
  mapping allow-list, so the parser/mapper are tested against real exposition text, not invented
  strings.
2. Add the Prisma migration for `metricsEnabled`/`metricsPort` (and `metricsHost` if the
  maintainer decides against reusing `host`); regenerate the Prisma client
  (`pnpm db:generate`) and update `packages/backend/prisma/schema.prisma`.
3. Implement `metrics-parser.ts` (pure, unit-testable) + its allow-list mapping function.
4. Implement `metrics-client.ts` (SSRF-validated construction, strict timeout/size/redirect caps,
  no auth header, `destroy()`), following `webquery-client.ts`'s shape but its own queue-free
  request path.
5. Wire `MetricsClient` into `ConnectionPool` lifecycle (create on `initialize`/`addClient` when
  enabled, tear down on `removeClient`/`refreshClient`, mirroring the existing WebQuery calls in
  that file).
6. Extend `dashboard.routes.ts` to attempt metrics first (bounded try/catch with its own short
  timeout independent of the route's overall response time), fall back to the existing WebQuery
  `Promise.all`, and populate the new `dataSource` field either way.
7. Extend `packages/common/src/types/api.ts` (`DashboardData`) and
  `packages/backend/src/routes/servers.routes.ts` (`ServerConfig`/`CreateServerConfig`/
  `UpdateServerConfig` — add `metricsEnabled`/`metricsPort` to the create/update field allow-list
  the same way `webqueryPort` is handled today, including port validation via
  `validateTsServerPort`).
8. Update `ConnectionFormDialog.tsx` (+ `ConnectionSetupWizard.tsx` if the wizard also collects
  connection fields) with the new toggle/field and inline "keep this private" guidance.
9. Update `Dashboard.tsx` to render the data-source badge/label.
10. Update demo-mode behavior (`DemoWebQueryClient`/`ConnectionPool.addDemoClient`) so the demo
  tour's dashboard is unaffected (either canned metrics or explicit skip).
11. Update `docs/teamspeak-compatibility.md` ("TS6 Manager does not scrape or proxy these
  metrics" line needs revision) and `docs/roadmap.md` (the "optional use of TeamSpeak native
  metrics..." bullet moves from "direction" to "shipped") once behavior is stable — per the
  issue's own acceptance criteria, do this only after the feature is stable, not speculatively
  mid-implementation.
12. Do not hand-bump `version.txt`/package versions — Release Please owns that per this repo's
  `AGENTS.md`.

## 5. Affected files (expected)

**Backend**
- `packages/backend/prisma/schema.prisma` (+ new migration under `packages/backend/prisma/migrations/`)
- `packages/backend/src/ts-client/metrics-client.ts` (new)
- `packages/backend/src/ts-client/metrics-parser.ts` (new)
- `packages/backend/src/ts-client/metrics-client.test.ts` (new)
- `packages/backend/src/ts-client/metrics-parser.test.ts` (new)
- `packages/backend/src/ts-client/connection-pool.ts`
- `packages/backend/src/ts-client/demo-webquery-client.ts`
- `packages/backend/src/routes/dashboard.routes.ts`
- `packages/backend/src/routes/servers.routes.ts`
- `packages/backend/src/utils/validate-ts-host.ts` (reuse only — extend if a metrics-specific
 validation helper turns out to be needed, e.g. a distinct default port constant)

**Common**
- `packages/common/src/types/api.ts` (`DashboardData`, `ServerConfig`/`CreateServerConfig`/
 `UpdateServerConfig`)

**Frontend**
- `packages/frontend/src/pages/Dashboard.tsx`
- `packages/frontend/src/components/connections/ConnectionFormDialog.tsx`
- `packages/frontend/src/components/connections/ConnectionSetupWizard.tsx` (if applicable)
- `packages/frontend/src/api/servers.api.ts` (if new fields need explicit typing there)

**Docs**
- `docs/teamspeak-compatibility.md`
- `docs/roadmap.md`
- `docs/environment-variables.md` (only if a new TS6-Manager-side env var is introduced — not
 expected, since the metrics *listener* config lives on the TeamSpeak side per beta13's own
 `TSSERVER_METRICS_*` variables)

## 6. Tests and verification

- **Parser unit tests**: valid Prometheus text with comments/labels/quoted values; malformed
 lines; `NaN`/`+Inf`/`-Inf` sample rejection; empty body.
- **Mapper unit tests**: allow-list mapping from parsed metrics to `DashboardData` extras;
 unknown/extra metrics ignored; missing expected metric names degrade gracefully (partial data,
 not a thrown error).
- **`MetricsClient` unit tests**: SSRF validation delegated to `validate-ts-host.ts` (host
 rejected, port rejected); timeout enforced; response-size cap enforced; no auth header sent;
 `destroy()` tears down the agent.
- **`ConnectionPool` tests**: metrics client created only when `metricsEnabled`; torn down on
 `removeClient`/disable via `refreshClient`; demo servers never get a metrics client.
- **Dashboard route tests**: metrics success -> `dataSource: 'native_metrics'`; metrics
 disabled -> `dataSource: 'webquery'` with unchanged existing behavior; metrics enabled but
 failing/timing out -> clean fallback to WebQuery with `dataSource: 'webquery'`, no user-facing
 error where WebQuery itself would have succeeded; scoping check — a `sid` that doesn't belong to
 the configured connection must not leak another virtual server's metrics.
- **RBAC/role coverage**: confirm any new admin-only config fields (`metricsEnabled`/
 `metricsPort`) are only writable via the existing `requireRole('admin')` gate on
 `servers.routes.ts`, matching current WebQuery/SSH field handling.
- **No secret/host leakage**: assert error paths never surface the metrics host/port or WebQuery
 credentials to non-admin roles or client-visible error messages (same discipline PR #114 applied
 via `SENSITIVE_SUBSTRINGS`).
- **Live beta13 compatibility** (per issue's "live beta13 compatibility where practical" and this
 repo's existing compatibility CI pattern in `docs/teamspeak-compatibility.md`): run against a real
 beta13 container with `TSSERVER_METRICS_IP` enabled, confirm the parser/mapper handle the actual
 exposition format, and confirm fallback works cleanly when metrics are left disabled (the
 default).
- **Frontend**: extend or add a Playwright spec analogous to `packages/frontend/tests/dashboard.spec.ts`
 covering the new data-source badge in both states (if that spec exists and is a suitable
 extension point — confirm at implementation time).
- **Full verification commands** (per `AGENTS.md`):
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

## 7. Risks and rollback

- **Risk: SSRF via a misconfigured/attacker-influenced metrics host/port.** Mitigated by requiring
 the metrics fetch to go through the same `validate-ts-host.ts` gate as WebQuery/SSH, and by never
 accepting a request-body-supplied host/port for the metrics fetch (mirrors PR #114's CodeQL fix
 for WebQuery paths — this must not regress the same class of finding for a new client).
- **Risk: unauthenticated internal endpoint becomes a proxyable target.** Mitigated by keeping the
 metrics client strictly server-to-server (no route ever echoes the raw scrape body verbatim to
 the browser — only the mapped, allow-listed `DashboardData` fields are returned) and by
 documentation clearly stating the listener must stay off the public interface.
- **Risk: response-size/redirect abuse turning a "metrics scrape" into an SSRF/DoS vector.**
 Mitigated by `maxRedirects: 0` and content-length caps mirroring PR #114's WebQuery hardening.
- **Risk: dashboard availability regression if metrics integration has a bug.** Mitigated
 architecturally — metrics is strictly additive/best-effort in the dashboard route; any metrics
 failure (network, timeout, parse) must fall through to the existing WebQuery path unchanged, so a
 metrics bug degrades to today's behavior rather than breaking the dashboard.
- **Risk: schema drift / migration risk.** Mitigated by additive, default-`false` nullable-safe
 Prisma fields; no existing `TsServerConfig` row changes behavior without an explicit admin opt-in.
- **Rollback plan**: the feature is fully gated by `metricsEnabled` (default `false`). If a serious
 issue surfaces post-merge, an admin can disable metrics per-connection without any migration
 rollback; a full code rollback is a normal revert of the feature PR since no other Slice 1 code
 path is load-bearing for existing WebQuery-only behavior. The Prisma migration itself is additive
 and safe to leave in place even if the feature is later reverted at the application level.
- **Sequencing risk**: PR #114 (Slice 2) is still an open draft. If it merges with a different
 shared vocabulary than assumed here (e.g. `ConnectionDiagnosticReport`), reconcile naming before
 merging Slice 1's dashboard `dataSource` field so the two don't produce inconsistent
 "current / fallback / unavailable" language across the UI.
