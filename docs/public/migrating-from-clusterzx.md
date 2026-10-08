# Switching from clusterzx/ts6-manager

An existing `clusterzx/ts6-manager` install can switch to these images in place. You keep the same containers, volumes and database; only the images and a few environment variables change.

This works because both projects use the same database path (`/app/packages/backend/data/ts6webui.db`), the same volume mounts and the same service names. On first start the backend detects the older database, applies the newer schema with `prisma db push` and records a schema version. The schema changes only add tables and columns, so no existing data is dropped.

The switch has been tested from clusterzx's Docker Hub images (`clusterzx/ts6-manager:backend`, `:sidecar`, `:frontend`) to the current release images, including restoring a backup onto the old images.

## Before you start

**Back up the backend data volume.** Find its name, stop the stack, then copy it into a tarball in the current folder:

~~~bash
docker volume ls
docker compose stop
docker run --rm -v <your-project>_backend-data:/data -v "${PWD}:/backup" alpine tar czf /backup/ts6-data-backup.tgz -C /data .
~~~

The `docker run` command is a single line so it works in both bash and PowerShell.

**Note your current `JWT_SECRET`, and `ENCRYPTION_KEY` if you set one.** You need them in the next step.

## Required environment variables

This fork requires two variables that clusterzx treated as optional or did not have.

### ENCRYPTION_KEY

Saved TeamSpeak WebQuery API keys, SSH passwords and music bot identities are encrypted in the database.

- **You already set `ENCRYPTION_KEY` on clusterzx:** keep exactly the same value.
- **You never set it:** clusterzx encrypted everything with your `JWT_SECRET` instead. Set `ENCRYPTION_KEY` to **the exact same string as your `JWT_SECRET`**.

Do not choose a new value. The backend decrypts every saved connection and bot identity at startup, and stops with `Failed to start server: Error: Unsupported state or unable to authenticate data` if it cannot. The startup message suggests a key distinct from `JWT_SECRET`; for an existing clusterzx database, reusing it is what keeps your saved credentials readable.

### SIDECAR_SECRET

A new shared secret between the backend and the media sidecar. Use any random string, for example `openssl rand -hex 32`, and set the same value on both services. The backend refuses to start in production when `SIDECAR_URL` is set without it.

## Switch the images

Edit your **existing** `docker-compose.yml`, in the same folder. Docker Compose names volumes after the project folder, so a compose file in a different folder creates new, empty volumes.

1. Change the images (GHCR is the default; Docker Hub is an optional mirror of the same releases when Hub publish secrets are set):

   | Service | From | To (GHCR, default) | To (Docker Hub mirror, when secrets set) |
   |---|---|---|---|
   | backend | `clusterzx/ts6-manager:backend` | `ghcr.io/uniskela/ts6-manager/backend:latest` | `uniskela/ts6-manager:backend` |
   | sidecar | `clusterzx/ts6-manager:sidecar` | `ghcr.io/uniskela/ts6-manager/sidecar:latest` | `uniskela/ts6-manager:sidecar` |
   | frontend | `clusterzx/ts6-manager:frontend` | `ghcr.io/uniskela/ts6-manager/frontend:latest` | `uniskela/ts6-manager:frontend` |

2. Add to the **backend** environment:

   ~~~yaml
   - ENCRYPTION_KEY=${ENCRYPTION_KEY}
   - SIDECAR_SECRET=${SIDECAR_SECRET}
   ~~~

3. Add to the **sidecar** environment and volumes. Video playback reads files the backend pre-downloads into the shared music volume:

   ~~~yaml
   environment:
     - SIDECAR_PORT=9800
     - SIDECAR_SECRET=${SIDECAR_SECRET}
     - MUSIC_DIR=/data/music
   volumes:
     - music-data:/data/music
   ~~~

4. Optional: remove the sidecar's published `9800:9800` port. The backend reaches the sidecar over the Docker network, and this fork does not publish it.

Alternatively, start from this repository's [`docker-compose.yml`](../../docker-compose.yml) and copy your values into it, keeping it in the same folder as your old one.

## Start and check

~~~bash
docker compose pull
docker compose up -d
docker compose logs backend
~~~

In the backend log, look for:

- `[schema] Existing database found without a schema version marker — treating as upgrade from an older image`
- `[schema] Recorded schema version …`
- no `[FATAL]` lines and no `Failed to start server`.

To filter the log in PowerShell, use `docker compose logs backend | Select-String "schema|FATAL|ERROR"`.

Then log in with your existing admin account and confirm that your connections load channels and clients, and that your bots, playlists, radio stations and flows are still there. Playlists from clusterzx are shared across all bots on their server.

## Rolling back

Stop the stack, restore the backup into the volume, and put the clusterzx image lines back:

~~~bash
docker compose down
docker volume rm <your-project>_backend-data
docker volume create <your-project>_backend-data
docker run --rm -v <your-project>_backend-data:/data -v "${PWD}:/backup" alpine tar xzf /backup/ts6-data-backup.tgz -C /data
docker compose up -d
~~~

After that, keep upgrading as described in [Upgrading](upgrading.md).
