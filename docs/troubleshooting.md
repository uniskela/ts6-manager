# Troubleshooting

## `invalid apikey`

TS6 Manager does not clear saved WebQuery keys during a normal container restart or upgrade.

If TeamSpeak returns `invalid apikey`:

1. confirm the saved connection points to the correct server and port;
2. verify the server-side key still exists and has management scope;
3. if you used beta13 `TSSERVER_QUERY_ADMIN_API_KEY`, check whether that value changed; and
4. update the saved connection if the server-side key was replaced.

When manually creating a persistent key, use `lifetime=0` where appropriate.

## Saved credentials stopped working after redeploy

Check `ENCRYPTION_KEY`.

The same key must be retained across restarts and upgrades. A different value cannot decrypt credentials stored with the previous key.

## SSH features do not work

Core WebQuery management can work while SSH-dependent features fail.

Check:

- SSH Query is enabled and reachable;
- the saved SSH credentials are correct;
- host-key trust is valid; and
- network/firewall rules allow the connection.

Transient closes during the initial handshake are retried. Authentication and host-key failures need configuration changes.

## Sidecar or video streaming errors

For a split-stack deployment verify:

- `SIDECAR_URL` points to the sidecar service;
- backend and sidecar use the same `SIDECAR_SECRET`;
- both containers share the same media volume path; and
- sidecar port 9800 is reachable internally without being exposed publicly.

## YouTube/media extraction problems

yt-dlp is bundled into the production backend image and does not self-update at runtime.

If an extractor has changed upstream, pull a newer TS6 Manager image or rebuild the image so a newer bundled yt-dlp can be installed.

For media requiring login, age, or member access, configure an appropriate cookie file and protect it like a credential.

## Database/schema problems after upgrade

Backend startup runs the schema-apply script automatically.

Confirm:

- the persistent database volume is mounted at the expected path;
- the container can write to it; and
- startup logs show the schema apply/seed path completing.

Do not discard the persistent volume as a first troubleshooting step.

## Reverse-proxy login or live-update problems

Check:

- the public frontend origin matches `FRONTEND_URL`;
- WebSocket upgrades are supported by the reverse proxy; and
- the public domain routes to the frontend/nginx service, not directly to the internal sidecar.
