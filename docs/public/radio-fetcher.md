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

By default the overlay **builds** `ts6-media-fetcher:local` from `services/media-fetcher`. Release tags also publish immutable images:

| Registry | Example tag |
|---|---|
| GHCR | `ghcr.io/uniskela/ts6-manager/media-fetcher:vX.Y.Z` (also `:sha-…`, `:X.Y.Z`, `:X.Y`) |
| Docker Hub mirror (when configured) | `uniskela/ts6-manager:media-fetcher-vX.Y.Z` |

To pull a published image instead of building locally:

~~~bash
export MEDIA_FETCHER_IMAGE=ghcr.io/uniskela/ts6-manager/media-fetcher:vX.Y.Z
docker compose -f docker-compose.yml -f docker-compose.media-fetcher.yml pull
docker compose -f docker-compose.yml -f docker-compose.media-fetcher.yml up -d
~~~

Architecture: linux/amd64 (same release builders as the other components). The fetcher still requires Landlock ABI ≥ 4 on the **host kernel** regardless of how the image was obtained.

The backend looks for:

| Variable | Overlay value | Purpose |
|---|---|---|
| `MEDIA_FETCHER_SOCK` | `/jobs/jobs.sock` | Unix job socket from the fetcher |
| `MEDIA_FETCHER_TOKEN_FILE` | `/jobs/.token` | Token copy installed into the jobs volume |

`MEDIA_FETCHER=1` on the overlay is not a safety switch. Radio always uses the fetcher. There is no supported `MEDIA_FETCHER=legacy` override.

Fetcher-only variables (not needed on the backend): `JOBS_SOCK`, `PROXY_CTL`, `PROXY_CTL_TOKEN_FILE` (`/ctl/.ctl-token`), `PROXY_HOST`, `PROXY_PORT`, `FETCHER_MAX_JOBS`, `MEDIA_FETCHER_CA_FILE` (lab CA override; must not live under `/jobs` because sandboxed ffmpeg cannot read that tree). `LL_WRAP=0` and `MEDIA_FETCHER_DISABLE_LANDLOCK=1` refuse to start.

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
- Portainer / Coolify: add the overlay as a second compose file on the same stack. Prefer pulling `MEDIA_FETCHER_IMAGE` from GHCR for a release tag, or build from `services/media-fetcher` when developing. Bind the host token only into the `media-fetcher-token` installer (`/src/token`). Do not paste the token into Portainer environment fields.
- Do not publish fetcher or proxy ports. Do not mount the Docker socket.

## Deployment matrix

| Environment | Radio supported? | Notes |
|---|---|---|
| Linux 6.7+ split Compose + overlay (build or GHCR image) | Yes | Preferred production path |
| Portainer/Coolify on Linux 6.7+ with overlay + token | Yes | Same Landlock requirement |
| Linux 6.1 / 5.x / Landlock ABI below 4 | No | Fetcher refuses to start; radio fails closed |
| All-in-one image alone | No | No fetcher sidecar in that image |
| Windows / macOS native backend | No | Radio fails closed |
| Backend without overlay | No | Fail closed; no insecure in-process fallback |
| `MEDIA_FETCHER=legacy` | No | Not supported; ignored as a safety switch |

## Filesystem ownership and token permissions

- Host token: owner-only (`umask 077` / mode `600`). Keep it that way under rootless Docker. A world-readable token is refused.
- `media-fetcher-token` runs as container uid `0` with only `CAP_DAC_OVERRIDE` and `CAP_CHOWN` (all other capabilities dropped). It writes `/jobs/.token` and a separate `/ctl/.ctl-token` as uid `1000` mode `600`. The Job API token and the proxy control secret are different files. The fetcher (`user: "1000:1000"`) and the stock backend image (runs as root; no `USER` in `Dockerfile.backend`) both read the Job API token; the backend never mounts `/ctl`.
- Rootless and rootful Compose both need those two installer capabilities so container-root can write into the node-owned volume and `chown` the secret. Rootful Docker validation outside this host remains a separate release check.
- Rootless named volumes may be created as root. If the fetcher cannot write `/jobs` or `/ctl`:

~~~bash
docker compose -f docker-compose.yml -f docker-compose.media-fetcher.yml \
  run --rm --user 0 media-fetcher chown -R node:node /jobs /ctl
~~~

- Fetcher and proxy run as uid `1000` with `no-new-privileges` and `cap_drop: ALL` (no CHOWN/DAC_OVERRIDE). After rotating `.media-fetcher-token`, recreate `media-fetcher-token` and restart the proxy and fetcher so both volume secrets refresh.

## If the fetcher cannot start

Radio commands fail closed with:

`Radio playback needs the isolated media fetcher. Saved stations are unchanged.`

The backend does not start local ffmpeg and does not fall back to the old in-process path. Music, YouTube search, and saved station records are unchanged.

Typical causes: overlay not applied, token file missing or world-readable, Landlock ABI below 4, fetcher container restarting, or the job socket volume not shared with the backend.

## Existing stations

No schema change. `RadioStation` rows (`name`, `url`, `genre`, `imageUrl`) stay as they are. After the fetcher is running, Play / `!radio` / `/radio` use the same stored URLs.

HTTP and HTTPS Icecast (ports 80, 443, 8000, 8008, 8080, 8443) and HLS work through the fetcher. HTTPS jobs pass `-tls_verify 1` so later TLS hops from an HTTPS start (HLS playlists, segments, keys) verify the certificate. Debian ffmpeg 5.1’s `httpproxy` protocol rejects those TLS options, so HTTP Icecast still plays as plain HTTP, and the proxy refuses HTTPS `CONNECT` for HTTP-start jobs instead of following unverified TLS. Private, loopback, and link-local station URLs still fail. Stations on other ports do not play.

### HTTP redirects

The media-fetcher proxy does **not** follow redirects. On 301/302/303/307/308 it forwards a validated `Location` (and `Content-Type`) so ffmpeg can issue the next request through the same proxy. Each hop is authenticated and re-checked (host allowlist when set, radio ports, DNS pin, reserved/private denylist).

Supported: absolute `http://` redirects to another allowed host/port, and relative `Location` values ffmpeg resolves against the current URL.

Not supported under the current CONNECT policy: **HTTP→HTTPS** redirects for HTTP-start jobs (Location may be forwarded, but HTTPS `CONNECT` stays refused so TLS cannot bypass `-tls_verify`). Oversized, credential-bearing, protocol-relative (`//…`), or non-http(s) `Location` values are omitted. Forbidden ports and private/metadata destinations still fail on the follow-up hop.

See [Security — Media downloads](security.md#media-downloads) and [Upgrading](upgrading.md#radio-isolated-fetcher).
