# TeamSpeak beta13 metrics fixtures

## Status

**No real exposition dump is checked in yet.** Slice 1 (#91) scaffolding is fixture-gated: the scrape client, Prometheus text skeleton parser, config surface, and dashboard `dataSource` provenance ship without invented TeamSpeak metric names.

Drop a real scrape here as:

```text
packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.txt
```

Do **not** invent `# HELP` / `# TYPE` / sample lines. Parser allow-lists and VS-scoping rules must be derived from that dump only.

## Confirmed before capture

Official TeamSpeak 6 `CONFIG.md` documents:

- Enable: `TSSERVER_METRICS_ENABLED=1` (or `--metrics-enable`)
- Path: `GET /metrics`
- Default port: `9187`
- Bind: `TSSERVER_METRICS_IP` (default localhost-only — publish carefully)
- Unauthenticated HTTP listener (separate from WebQuery)

## Capture procedure (Docker)

```bash
# 1. Start beta13 with metrics on a published port (example only)
docker run -d --name ts6-metrics-capture \
  -p 127.0.0.1:10080:10080 \
  -p 127.0.0.1:9187:9187 \
  -e TSSERVER_LICENSE_ACCEPTED=accept \
  -e TSSERVER_QUERY_HTTP_ENABLED=1 \
  -e TSSERVER_METRICS_ENABLED=1 \
  -e TSSERVER_METRICS_IP=0.0.0.0 \
  teamspeaksystems/teamspeak6-server:6.0.0-beta13

# 2. Wait until the default virtual server is online (WebQuery health), then:
curl -sS -D /tmp/metrics.headers -o packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.txt \
  http://127.0.0.1:9187/metrics

# 3. Record observed response metadata next to the dump (do not invent values):
#    - HTTP status
#    - Content-Type header
#    - Whether any label uniquely identifies virtual server id / sid
#    - Whether voice metrics appear only when TSSERVER_METRICS_VOICE=1

# 4. Clean up
docker rm -f -v ts6-metrics-capture
```

Optional companion file (recommended): `ts6-beta13-metrics.meta.md` with the observed status line, `Content-Type`, bind/port used, image tag, and a short note on SID label presence/absence. Still no invented metric names.

## After capture

1. Commit the real `ts6-beta13-metrics.txt` (and optional `.meta.md`).
2. Derive the typed allow-list and scoping rule from that file only (`metrics-map.ts`).
3. Expand fixture-driven parser/mapper tests (currently `t.skip` when the file is missing).
4. Follow remaining checklist items in `docs/plans/91-slice-1-metrics.md`.

## Intentionally blank

This directory intentionally contains **no** sample Prometheus body until a real beta13 scrape is committed. Generic parser unit tests use clearly non-TeamSpeak synthetic lines only.
