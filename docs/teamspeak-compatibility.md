# TeamSpeak compatibility

The v1.6 compatibility baseline is TeamSpeak Server **6.0.0-beta13**, tested with the official image:

~~~text
teamspeaksystems/teamspeak6-server:6.0.0-beta13
~~~

Older versions are not intentionally blocked, and manually provisioned WebQuery keys remain supported.

## Recommended beta13 Query settings

Configure these variables on the **TeamSpeak server/container**, not the TS6 Manager container:

~~~env
TSSERVER_QUERY_HTTP_ENABLED=1
TSSERVER_QUERY_HTTP_ALLOW_GUEST=0
TSSERVER_QUERY_SSH_ALLOW_GUEST=0
TSSERVER_QUERY_ADMIN_API_KEY=<secure-stable-key>
~~~

Beta13 enables guest HTTP and SSH Query access by default. TS6 Manager does not need guest access; it requires authenticated WebQuery and uses authenticated SSH when configured.

Restrict Query ports to trusted management networks.

## Deterministic admin API key

On beta13 Docker deployments, `TSSERVER_QUERY_ADMIN_API_KEY` provides a deterministic built-in `serveradmin` management key.

Generate a strong value and keep it stable.

Changing this environment variable replaces the relevant built-in management API key. If it changes, update the saved TS6 Manager connection because the previously encrypted key will no longer authenticate.

## Manual API-key provisioning

Authenticated SSH Query can create a persistent management key:

~~~text
use 1
apikeyadd scope=manage lifetime=0 ip=0.0.0.0/0
~~~

`lifetime=0` makes the key non-expiring. Narrow the allowed source range where practical.

The environment-variable bootstrap and manual Query method are alternatives, not two required steps.

## Prometheus metrics

Beta13 provides optional external Prometheus monitoring.

- Metrics are disabled by default.
- The default metrics port is `9187`.
- The endpoint is unauthenticated.
- `TSSERVER_METRICS_IP` controls the bind address.
- `TSSERVER_METRICS_VOICE` enables per-packet voice diagnostics and adds overhead.

Keep the endpoint on a restricted interface/network. TS6 Manager does not scrape or proxy these metrics.

## Log timezone

Beta13 server logs default to UTC. `TSSERVER_LOG_TIMEZONE` can select `utc` or `local`.

TS6 Manager displays raw server log text and does not convert its timestamps.

## Compatibility CI

The separate TeamSpeak compatibility workflow starts an isolated official beta13 server with:

- an ephemeral admin key;
- guest Query disabled;
- readiness checks;
- rejection of unauthenticated HTTP access; and
- real WebQuery calls for `version`, `serverinfo`, `clientlist`, `channellist`, and `serverrequestconnectioninfo`.

It also performs a channel create/info/non-forced-delete round trip.

The workflow does not certify voice/video playback, public YouTube availability, SSH/file transfers, production networking, or every possible TeamSpeak configuration.
