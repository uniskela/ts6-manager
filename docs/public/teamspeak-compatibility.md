# TeamSpeak compatibility

The compatibility baseline pin is TeamSpeak Server **6.0.0-beta14**, official image:

~~~text
teamspeaksystems/teamspeak6-server:6.0.0-beta14
~~~

The compatibility workflow below starts that image. Older versions are not intentionally blocked, and manually provisioned WebQuery keys remain supported.

The TeamSpeak client 6.0.0-beta5 needs ts6-manager 1.11.2 or newer for viewers; see [Troubleshooting](troubleshooting.md#teamspeak-600-beta5-never-answers-a-stream). That client note is separate from the server pin above.

## Recommended Query settings

Configure these variables on the **TeamSpeak server/container**, not the TS6 Manager container:

~~~env
TSSERVER_QUERY_HTTP_ENABLED=1
TSSERVER_QUERY_HTTP_ALLOW_GUEST=0
TSSERVER_QUERY_SSH_ALLOW_GUEST=0
TSSERVER_QUERY_ADMIN_API_KEY=<secure-stable-key>
~~~

Since beta13, guest HTTP and SSH Query access is enabled by default. TS6 Manager does not need guest access; it requires authenticated WebQuery and uses authenticated SSH when configured.

Restrict Query ports to trusted management networks.

## Deterministic admin API key

On beta13 and later Docker deployments, `TSSERVER_QUERY_ADMIN_API_KEY` provides a deterministic built-in `serveradmin` management key.

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

Since beta13, the server provides optional external Prometheus monitoring. The manager allow-list was captured from a beta13 exposition. The beta14 release notes do not mention a metrics schema change, so that fixture stays as captured.

- Metrics are disabled by default.
- The default metrics port is `9187`.
- The endpoint is unauthenticated.
- `TSSERVER_METRICS_IP` controls the bind address.
- `TSSERVER_METRICS_VOICE` enables per-packet voice diagnostics and adds overhead.

Keep the endpoint on a restricted interface/network — it is unauthenticated, so do **not** expose it on the public internet. When a connection enables metrics scrape, TS6 Manager fetches `/metrics` from the configured host/port (defaulting to the WebQuery host). The listener must be reachable from the **manager backend** (for example on a private Docker network). TeamSpeak’s default bind is often localhost-only; that works only when the manager shares that loopback.

## Log timezone

Server logs default to UTC. `TSSERVER_LOG_TIMEZONE` can select `utc` or `local`.

WebQuery `logview` does not report which zone produced a line. TS6 Manager therefore keeps the source timestamp text and shows a single page-level note that the zone is unknown, rather than repeating a per-row label or converting to browser local or UTC. Browser local / UTC presentation is reserved for timestamps whose source timezone is established. Raw source text remains visible on each row.

## File names on 6.0.0-beta14

TeamSpeak 6.0.0-beta14 treats file and folder names as UTF-8 on Linux and macOS. The official Docker image sets `LANG=C.UTF-8`. Compose files in this repository do not set `LANG` on the TeamSpeak service, so that image default applies. Do not set `LANG` to a locale that is not UTF-8.

TS6 Manager sends file names over ServerQuery as UTF-8. Icon files and bot avatars use ASCII names. Channel files or folders that an older server stored while its process locale was not UTF-8 are no longer listed or transferred until they are renamed on the TeamSpeak server. The file browser cannot rename a file the server no longer returns.

## Unchanged in 6.0.0-beta14

Packet-thread sizing, S3 channel-delete log text, and the bundled default license text stay inside the TeamSpeak server. Beta14 release notes do not add or remove ServerQuery or WebQuery commands, and they do not change permissions. This manager still loads the permission list live with `permissionlist`. Compose files keep `TSSERVER_LICENSE_ACCEPTED=accept`.

## Compatibility CI

The separate TeamSpeak compatibility workflow starts an isolated official 6.0.0-beta14 server with:

- an ephemeral admin key;
- guest Query disabled;
- readiness checks;
- rejection of unauthenticated HTTP access; and
- real WebQuery calls for `version`, `serverinfo`, `clientlist`, `channellist`, and `serverrequestconnectioninfo`.

It also performs a channel create/info/non-forced-delete round trip.

The workflow does not certify voice/video playback, public YouTube availability, SSH/file transfers, production networking, or every possible TeamSpeak configuration.
