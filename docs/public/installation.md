# Installation

TS6 Manager publishes four container images for immutable releases. **GitHub Container Registry is the default** (compose files in this repo). Docker Hub mirrors the same release digests when both `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are configured; if either secret is unset, GHCR still publishes and Hub tags may be missing or stale.

| Service | GHCR (default) | Docker Hub (mirror, when secrets set) |
|---|---|---|
| Backend | `ghcr.io/uniskela/ts6-manager/backend:latest` | `uniskela/ts6-manager:backend` |
| Frontend | `ghcr.io/uniskela/ts6-manager/frontend:latest` | `uniskela/ts6-manager:frontend` |
| Sidecar | `ghcr.io/uniskela/ts6-manager/sidecar:latest` | `uniskela/ts6-manager:sidecar` |
| All-in-one | `ghcr.io/uniskela/ts6-manager/all-in-one:latest` | `uniskela/ts6-manager:all-in-one` |

See [Docker Hub](https://hub.docker.com/r/uniskela/ts6-manager). When Hub publish is enabled, versioned Hub tags use the form `uniskela/ts6-manager:backend-1.10.1`.

Release images are published after a Release Please release is created. Ordinary pushes and pull requests do not publish images.

## Split stack

The default deployment uses separate frontend, backend, and media-sidecar containers.

1. Download [`docker-compose.yml`](../../docker-compose.yml).
2. Create a `.env` file with at least:

~~~env
JWT_SECRET=generate-a-random-secret
ENCRYPTION_KEY=generate-a-second-stable-secret
SIDECAR_SECRET=generate-a-third-shared-secret
~~~

Generate strong values with OpenSSL if available:

~~~bash
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "SIDECAR_SECRET=$(openssl rand -base64 32)" >> .env
~~~

3. Start the stack:

~~~bash
docker compose up -d
~~~

4. Open `http://localhost:3000/setup`.
5. Create the initial administrator.
6. Add a TeamSpeak connection under **Settings → Connections**.

The backend is exposed on port 3001 by the stock compose file. The media sidecar HTTP API remains on the internal Docker network and is not published to the host. Browser WebRTC preview needs a published UDP mux (`WEBRTC_UDP_PORT`) and advertise IP (`WEBRTC_NAT1TO1_IP`) — see [Video streaming](video-streaming.md) and the commented mappings in `docker-compose.yml`. `docker-compose.pr-test.yml` enables UDP `10000` by default.

## All-in-one

The all-in-one image runs nginx, the backend, and the Go media sidecar in one container.

~~~bash
docker compose -f docker-compose.all-in-one.yml up -d
~~~

Open `http://localhost:3000` unless you changed `HOST_PORT`.

Only nginx is published by default. Backend and sidecar HTTP remain internal to the container. Optional WebRTC UDP publish is documented in `docker-compose.all-in-one.yml`.

## Optional native media sidecar

Docker is the supported way to run TS6 Manager. When the sidecar needs a host GPU encoder that a container cannot use, such as AMD AMF on Windows, each release also provides native sidecar binaries. See [Native media sidecar](native-sidecar.md).

## Build from source

For Home Screen or desktop app installation after deployment, see [Install TS6 Manager as an app](pwa.md). PWA installation requires HTTPS (except on localhost).

Development and local image builds use Node.js 20+ and pnpm 9.x.

~~~bash
git clone https://github.com/uniskela/ts6-manager.git
cd ts6-manager
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev
~~~

For a local Docker build **with TeamSpeak 6 (beta13)**:

~~~bash
cp .env.pr-test.example .env
docker compose -f docker-compose.pr-test.yml up --build
~~~

Manager-only (no TeamSpeak container):

~~~bash
docker compose -f docker-compose.local.yml up -d --build
~~~

See [Configuration](configuration.md) before using a production deployment.
