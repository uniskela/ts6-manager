# Installation

TS6 Manager publishes four container images for immutable releases:

| Service | Image |
|---|---|
| Backend | `ghcr.io/uniskela/ts6-manager/backend:latest` |
| Frontend | `ghcr.io/uniskela/ts6-manager/frontend:latest` |
| Sidecar | `ghcr.io/uniskela/ts6-manager/sidecar:latest` |
| All-in-one | `ghcr.io/uniskela/ts6-manager/all-in-one:latest` |

Release images are published after a Release Please release is created. Ordinary pushes and pull requests do not publish GHCR images.

## Split stack

The default deployment uses separate frontend, backend, and media-sidecar containers.

1. Download [`docker-compose.yml`](../docker-compose.yml).
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

The backend is exposed on port 3001 by the stock compose file. The media sidecar remains on the internal Docker network and is not published to the host.

## All-in-one

The all-in-one image runs nginx, the backend, and the Go media sidecar in one container.

~~~bash
docker compose -f docker-compose.all-in-one.yml up -d
~~~

Open `http://localhost:3000` unless you changed `HOST_PORT`.

Only nginx is published. Backend and sidecar services remain internal to the container.

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

For a local Docker build:

~~~bash
docker compose -f docker-compose.local.yml up -d --build
~~~

See [Configuration](configuration.md) before using a production deployment.
