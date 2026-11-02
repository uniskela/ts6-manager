# Radio fetcher

Remote radio playback (TeamSpeak `!radio`, Discord `/radio`, web Play, Auto-DJ radio, listener requests, and queue next/prev) uses an isolated media-fetcher. The backend never starts local ffmpeg for a remote radio URL.

Saved radio stations stay in the database. This change does not migrate, rename, or delete station rows.

## Enable the isolated fetcher

Split Docker stack:

1. Create a token file (32+ hex). Owner-only on the host. Do not chmod it world-readable, and do not put the token in compose `environment:` or process argv.

~~~bash
umask 077
openssl rand -hex 32 > .media-fetcher-token
~~~

2. Start the stock compose file plus the overlay:

~~~bash
docker compose -f docker-compose.yml -f docker-compose.media-fetcher.yml up -d
~~~

3. Confirm the fetcher is up (`ts6-media-fetcher` and `ts6-media-egress-proxy`) and that radio play returns audio, not *Radio playback needs the isolated media fetcher. Saved stations are unchanged.*

The overlay copies the host token into the jobs volume as uid `1000` mode `600`, shares a unix job socket on that volume, and keeps the fetcher off the app network. No fetcher or proxy ports are published.

The overlay **builds** `ts6-media-fetcher:local` from `services/media-fetcher`. It is not published to GHCR with the backend/frontend/sidecar images. Portainer and Coolify stacks that only pull GHCR cannot start radio until they build this context (or load a local image).

The backend looks for:

| Variable | Overlay value | Purpose |
|---|---|---|
| `MEDIA_FETCHER_SOCK` | `/jobs/jobs.sock` | Unix job socket from the fetcher |
| `MEDIA_FETCHER_TOKEN_FILE` | `/jobs/.token` | Token copy installed into the jobs volume |

`MEDIA_FETCHER=1` on the overlay is not a safety switch. Radio always uses the fetcher. There is no supported `MEDIA_FETCHER=legacy` override.

Fetcher-only variables (not needed on the backend): `JOBS_SOCK`, `PROXY_CTL`, `PROXY_HOST`, `PROXY_PORT`, `FETCHER_MAX_JOBS`, `MEDIA_FETCHER_CA_FILE` (lab CA override). `LL_WRAP=0` and `MEDIA_FETCHER_DISABLE_LANDLOCK=1` refuse to start.

## Linux / Landlock

The fetcher process will not start unless Landlock can enforce TCP `CONNECT` to that job’s loopback shim only.

| Host / config | Result |
|---|---|
| Linux **6.7+** with Landlock LSM (ABI ≥ 4) | Fetcher can start |
| Linux 6.1 LTS, 5.x, or Landlock ABI 1–3 only | Fetcher refuses to start |
| Seccomp/AppArmor denying landlock syscalls | Fetcher refuses to start |
| `LL_WRAP=0` or `MEDIA_FETCHER_DISABLE_LANDLOCK=1` | Fetcher refuses to start |
| Windows / macOS native backend, or all-in-one without this overlay | Radio fails closed |

`unshare(CLONE_NEWNET)` is not used. Default Docker still returns `EPERM` for it.

## Docker Compose and Portainer

- Compose: always pass **both** files (`docker-compose.yml` then `docker-compose.media-fetcher.yml`). The overlay is not a standalone stack. Compose v2 is required (`depends_on` with `service_completed_successfully`).
- Portainer: add the overlay as a second compose file on the same stack and **build** the fetcher image from this repository. Bind the host token only into the `media-fetcher-token` installer (`/src/token`). Do not paste the token into Portainer environment fields.
- Do not publish fetcher or proxy ports. Do not mount the Docker socket.

## Filesystem ownership and token permissions

- Host token: owner-only (`umask 077` / mode `600`). Keep it that way under rootless Docker. A world-readable token is refused.
- `media-fetcher-token` runs as container uid `0` (the rootless host user) and writes `/jobs/.token` as uid `1000` mode `600`. The fetcher (`user: "1000:1000"`) and the stock backend image (runs as root; no `USER` in `Dockerfile.backend`) both read that copy.
- Rootless named volumes may be created as root. If the fetcher cannot write `/jobs` or `/ctl`:

~~~bash
docker compose -f docker-compose.yml -f docker-compose.media-fetcher.yml \
  run --rm --user 0 media-fetcher chown -R node:node /jobs /ctl
~~~

- Fetcher and proxy run as uid `1000` with `no-new-privileges` and `cap_drop: ALL`. After rotating `.media-fetcher-token`, recreate `media-fetcher-token` so the volume copy is refreshed.

## If the fetcher cannot start

Radio commands fail closed with:

`Radio playback needs the isolated media fetcher. Saved stations are unchanged.`

The backend does not start local ffmpeg and does not fall back to the old in-process path. Music, YouTube search, and saved station records are unchanged.

Typical causes: overlay not applied, token file missing or world-readable, Landlock ABI below 4, fetcher container restarting, or the job socket volume not shared with the backend.

## Existing stations

No schema change. `RadioStation` rows (`name`, `url`, `genre`, `imageUrl`) stay as they are. After the fetcher is running, Play / `!radio` / `/radio` use the same stored URLs.

HTTP and HTTPS Icecast (ports 80, 443, 8000, 8008, 8080, 8443) and HLS work through the fetcher. HTTPS jobs pass `-tls_verify 1` so later TLS hops from an HTTPS start (HLS playlists, segments, keys) verify the certificate. Debian ffmpeg 5.1’s `httpproxy` protocol rejects those TLS options, so HTTP Icecast still plays as plain HTTP, and the proxy refuses HTTPS `CONNECT` for HTTP-start jobs instead of following unverified TLS. Private, loopback, and link-local station URLs still fail. Stations on other ports do not play.

See [Security — Media downloads](security.md#media-downloads) and [Upgrading](upgrading.md#radio-isolated-fetcher).
