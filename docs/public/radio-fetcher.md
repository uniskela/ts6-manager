# Radio fetcher

Remote radio playback (TeamSpeak `!radio`, Discord `/radio`, web Play, Auto-DJ radio, listener requests, and queue next/prev) uses an isolated media-fetcher. The backend never starts local ffmpeg for a remote radio URL.

Saved radio stations stay in the database. This change does not migrate, rename, or delete station rows.

## Enable the isolated fetcher

Split Docker stack:

1. Create a token file (32+ hex). Do not put the token in compose `environment:` or process argv.

~~~bash
umask 077
openssl rand -hex 32 > .media-fetcher-token
~~~

2. Start the stock compose file plus the overlay:

~~~bash
docker compose -f docker-compose.yml -f docker-compose.media-fetcher.yml up -d
~~~

3. Confirm the fetcher is up (`ts6-media-fetcher` and `ts6-media-egress-proxy`) and that radio play returns audio, not *Radio playback needs the isolated media fetcher. Saved stations are unchanged.*

The overlay mounts the token read-only, shares a unix job socket on an internal volume, and keeps the fetcher off the app network. No fetcher or proxy ports are published.

The backend looks for:

| Variable | Default | Purpose |
|---|---|---|
| `MEDIA_FETCHER_SOCK` | `/jobs/jobs.sock` | Unix job socket from the fetcher |
| `MEDIA_FETCHER_TOKEN_FILE` | — | Path to the shared token file (required) |

`MEDIA_FETCHER=1` on the overlay is not a safety switch. Radio always uses the fetcher. There is no supported `MEDIA_FETCHER=legacy` override.

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

- Compose: always pass **both** files (`docker-compose.yml` then `docker-compose.media-fetcher.yml`). The overlay is not a standalone stack.
- Portainer: add the overlay as a second compose file on the same stack. Bind the token file into `/run/media-fetcher-token` read-only for **backend** and **media-fetcher**. Do not paste the token into Portainer environment fields.
- Do not publish fetcher or proxy ports. Do not mount the Docker socket.

## Filesystem ownership and token permissions

- Token file: owner-only read/write on the host (`umask 077` / mode `600`). The overlay mounts it read-only.
- Rootless named volumes may be created as root. If the fetcher cannot write `/jobs` or `/ctl`:

~~~bash
docker compose -f docker-compose.yml -f docker-compose.media-fetcher.yml \
  run --rm --user 0 media-fetcher chown -R node:node /jobs /ctl
~~~

- Backend and fetcher run as uid `1000` with `no-new-privileges` and `cap_drop: ALL`.

## If the fetcher cannot start

Radio commands fail closed with:

`Radio playback needs the isolated media fetcher. Saved stations are unchanged.`

The backend does not start local ffmpeg and does not fall back to the old in-process path. Music, YouTube search, and saved station records are unchanged.

Typical causes: overlay not applied, token file missing, Landlock ABI below 4, fetcher container restarting, or the job socket volume not shared with the backend.

## Existing stations

No schema change. `RadioStation` rows (`name`, `url`, `genre`, `imageUrl`) stay as they are. After the fetcher is running, Play / `!radio` / `/radio` use the same stored URLs.

HTTP and HTTPS Icecast (ports 80, 443, 8000, 8008, 8080, 8443) and HLS work through the fetcher. Private, loopback, and link-local station URLs still fail.

See [Security — Media downloads](security.md#media-downloads) and [Upgrading](upgrading.md#radio-isolated-fetcher).
