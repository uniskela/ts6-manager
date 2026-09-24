# TeamSpeak beta13 metrics fixtures

## Status

Real exposition dump is checked in:

| File | Role |
|------|------|
| `ts6-beta13-metrics.txt` | Prometheus text body (20856 bytes) |
| `ts6-beta13-metrics.headers` | Observed HTTP response headers |
| `ts6-beta13-metrics.meta.md` | Capture notes (image, Content-Type, VS label) |

Allow-list and VS scoping in `metrics-map.ts` are derived from this dump only. Do not invent additional series (including voice metrics) without a new capture that includes them.

**Main-branch gate:** this fixture lives on the Slice 1 implementation branch until merge — do not claim the `main` fixture gate passed solely because this file exists here.

## Observed (beta13)

- Image: `teamspeaksystems/teamspeak6-server:6.0.0-beta13`
- Path: `GET /metrics`
- HTTP: `200 OK`
- Content-Type: `text/plain; version=0.0.4; charset=utf-8`
- VS scope label: `virtualserver_unique_identifier`
- Numeric SID appears on `teamspeak_virtualserver_info` as `virtualserver_id`
- Identity join: SID → `virtualserver_id` → UID must agree with authenticated WebQuery `virtualserver_unique_identifier`
- `TSSERVER_METRICS_VOICE`: unknown for this capture — voice-only series omitted from allow-list
- Dashboard mapping: online = clients − query (both required); capacity/channels/bandwidth/ping from fixture; **uptime and total packet loss stay WebQuery**

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
curl -sS -D packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.headers \
  -o packages/backend/src/ts-client/__fixtures__/ts6-beta13-metrics.txt \
  http://127.0.0.1:9187/metrics

# 3. Update ts6-beta13-metrics.meta.md with status, Content-Type, SID label notes

# 4. Clean up
docker rm -f -v ts6-metrics-capture
```

## After a new capture

1. Diff metric names / labels against `METRICS_ALLOWLIST` in `metrics-map.ts`.
2. Update fixture-driven tests.
3. Keep fail-closed scoping via `teamspeak_virtualserver_info` + `virtualserver_unique_identifier`, requiring WebQuery UID agreement.
