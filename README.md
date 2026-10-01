#### DISCLAIMER: 
![AI Assisted](https://img.shields.io/badge/AI%20Assisted-Project-00ADD8?style=for-the-badge&logo=dependabot&logoColor=white)

# TS6 Manager

> [!IMPORTANT]
> **This is an opinionated continuation of [`clusterzx/ts6-manager`](https://github.com/clusterzx/ts6-manager), not a mirror or drop-in republish of upstream.**
> Expect security/reliability-focused changes, selective QoL, and different container images (`ghcr.io/uniskela/ts6-manager/...`).
> Community issue/PR credits: [`CREDITS.md`](CREDITS.md) (including [fork contributions](CREDITS.md#fork-contributions)).

Web-based management interface for TeamSpeak servers. Control virtual servers, channels, clients, permissions, music bots, automated workflows, and embeddable server widgets - all from your browser.

Built on the **WebQuery HTTP API** (the ServerQuery replacement in modern TeamSpeak builds). Telnet is not used or supported.

![License](https://img.shields.io/badge/license-MIT-blue)

**Contents:** [Documentation](#documentation) · [Screenshots](#screenshots) · [Features](#features) · [Architecture](#architecture) · [Tech Stack](#tech-stack) · [Quick Start (Docker)](#quick-start-docker) · [Development](#development) · [Environment Variables](#environment-variables) · [Sidecar / Video Streaming env](#environment-variables-sidecar--video-streaming) · [Music Bot Text Commands](#music-bot-text-commands) · [Requirements](#requirements) · [TeamSpeak compatibility](#teamspeak-compatibility-and-beta13-setup) · [Download progress](#download-progress) · [License](#license)

## Documentation

The maintained public documentation is available at **[uniskela.com/docs/ts6-manager](https://uniskela.com/docs/ts6-manager/)** and is sourced from the reviewed Markdown files in [`docs/`](docs/index.md).

Start with:

- [Installation](https://uniskela.com/docs/ts6-manager/installation/)
- [Configuration](https://uniskela.com/docs/ts6-manager/configuration/)
- [Upgrading](https://uniskela.com/docs/ts6-manager/upgrading/)
- [TeamSpeak compatibility](https://uniskela.com/docs/ts6-manager/teamspeak-compatibility/)
- [Music bots](https://uniskela.com/docs/ts6-manager/music-bots/)
- [Bot flows](https://uniskela.com/docs/ts6-manager/bot-flows/)
- [Security](https://uniskela.com/docs/ts6-manager/security/)
- [Troubleshooting](https://uniskela.com/docs/ts6-manager/troubleshooting/)
- [Video streaming](https://uniskela.com/docs/ts6-manager/video-streaming/)
- [Architecture](https://uniskela.com/docs/ts6-manager/architecture/)
- [Environment variables](https://uniskela.com/docs/ts6-manager/environment-variables/)

## Screenshots

### Dashboard
Live overview of your selected server, organized into Server Status, Traffic, and Runtime & Capacity with current refresh state.

![Dashboard](docs/dashboard.png)

### Channels and Clients
Browse the channel tree with connected clients, mute/away status, and password indicators, then review the sortable client list with search and per-client actions.

![Channel Tree](docs/channels.png)

![Clients](docs/clients.png)

### Server Groups and Permissions
Manage group membership and edit permissions with readable Simple labels or raw Technical names.

![Server Groups](docs/server-groups.png)

![Permission Editor](docs/permissions-editor.png)

### Server Logs
Bounded, paged `logview` output with level badges and page-local search and level filters.

![Server Logs](docs/server-logs.png)

### Bot Hub
One place for what every bot is doing right now: the current track or stream, channel, video quality, viewers, and last stop reason, with shortcuts to Bot Flows, Media Bots, video streaming and IPTV.

![Bot Hub](docs/bot-hub.png)

### Music Bots
Run multiple music bots per server. Each bot has its own queue, volume control, and playback state. Supports radio streams, YouTube, and a local music library. Users in the bot's channel can control it via text commands (`!radio`, `!play`, `!vol`, etc.).

![Music Bots](docs/musicbots.png)

### Video Streaming / IPTV
Browse channels from configured M3U/M3U8 playlist URLs and stream a selected channel through a running music bot and the video sidecar.

![Video Streaming and IPTV](docs/iptv.png)

### Bot Flow Engine
Visual node-based editor for building automated server workflows. Readable orthogonal routes, labelled condition branches, and a canvas sized from the real flow keep larger automations navigable. Unsaved drafts are protected from normal in-app navigation and query refreshes.

![Flow Editor](docs/flow-editor.png)

### Flow Templates
Get started quickly with pre-built flow templates. Covers common use cases like temporary channel creation, AFK movers, idle kickers, online counters, and group protection. One click to import, then customize to your needs.

![Flow Templates](docs/flow-templates.png)

### Try it without TeamSpeak
The Demo TeamSpeak Server connection provides synthetic channels, clients, groups, permissions, bans, and logs so you can explore the UI without a real server. The Channels, Clients, Groups, Permission Editor, and Logs screenshots above were captured from it. See [Configuration](docs/configuration.md#demo-server-for-ui-testing).

![Demo connection](docs/demo-connection.png)

### Permissions Compare
Compare two to four entities from the same permission layer in a read-only table. Simple or technical labels and Set on any / Differences only filters make raw values, unset states, Skip, and Negate flags easier to review.

![Permissions Compare](docs/permissions-compare.png)

## Features

### Server Management
- Dashboard with Server Status, Traffic, and Runtime & Capacity hierarchy
- Virtual server list with start/stop controls
- Channel tree with drag-and-drop ordering plus touch/keyboard move controls
- Client list with confirmed, pending-safe kick and ban actions plus move and poke
- Server & channel group management
- Permission editor (server, channel, client, group-level) with context-safe drafts, Simple/Technical labels, and read-only same-layer Compare for up to four entities
- Ban list management
- Token / privilege key management
- Complaint viewer
- Offline message system
- Server log viewer with filtering
- Channel file browser with upload/download
- Instance-level settings

### Music Bots
- Multiple bots per server, each with independent queue and playback
- Radio station streaming with ICY metadata and live title updates
- YouTube playback via yt-dlp (search, stream/on-demand playback with download fallback, queue and library downloads)
- Music library management (upload, organize, playlists)
- Local/downloaded tracks are decoded incrementally at media speed so memory use stays bounded on long tracks
- TeamSpeak voice hostnames are resolved once per connection rather than once per UDP packet
- Volume control, pause, skip, previous, shuffle, repeat
- Stereo audio support with stable 20ms pacing
- Auto-reconnect with exponential backoff and overlap protection
- In-channel text commands for hands-free control
- Music request history tracking

### Video Streaming
- Live video streaming from YouTube, Twitch, or direct URLs to TeamSpeak channels
- WebRTC-based with Go sidecar relay (Pion) for low-latency delivery
- Quality presets (480p, 720p, 1080p)
- M3U/M3U8 playlist URL management; administrators can also upload `.m3u`, `.m3u8`, or `.txt` playlist files (see [Video streaming](https://uniskela.com/docs/ts6-manager/video-streaming/)); channel browsing, filtering, and music-bot streaming
- In-browser preview with WebRTC playback
- A/V synchronization via RTCP Sender Reports
- Runs as a Docker sidecar container alongside the backend

### Bot Flow Engine
- Visual flow editor with drag-and-drop nodes, dynamic canvas extents, rounded orthogonal routes, and labelled True/False branches
- Triggers: TS3 events, cron schedules, webhooks (with mandatory secrets), chat commands (global or channel-specific)
- Actions: kick, ban, move, message, poke, channel create/edit/delete, HTTP requests, WebQuery commands, music-bot controls, and utility actions
- Conditions, persistent flow variables, execution-local temporary values, delays, and logging
- Animated channel names (rotating text on a timer)
- Placeholder system with filters and expressions
- Pre-built templates for common automation tasks

### Server Widgets
- Embeddable server status banner for websites and forums
- Token-based public access (no authentication required)
- Available as live page, SVG, or PNG image
- Dark and light themes
- Configurable: show/hide channel tree and client list

### Security
- Setup wizard for initial admin account (no default credentials)
- AES-256-GCM encryption for stored credentials (API keys, SSH passwords)
- SSRF protection on all outbound HTTP requests and FFmpeg URLs
- Rate limiting on authentication endpoints
- JWT access + refresh token rotation with reuse detection
- Role-based access control (admin / viewer)
- Per-server access control for multi-tenant setups
- WebQuery command whitelist in bot flows (blocks destructive commands)
- Authenticated WebSocket connections
- Password complexity requirements
- Production Node images omit npm/npx/pnpm/Corepack and esbuild build tooling; CI rebuilds and Trivy-scans all release images, failing on fixable HIGH/CRITICAL findings

### Settings & Administration
- Browser-local appearance controls with Light, Dark, or Black base themes and Cyan, Violet, Red, Blue, Emerald, or Amber accents
- yt-dlp cookie file management for accessing age-restricted or member-only YouTube content
- Upload cookies via file or paste directly in the UI
- Admin-only settings panel

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Frontend   │────▶│   Backend    │────▶│  TS Server      │
│  React SPA   │     │  Express API │     │  WebQuery HTTP  │
│  nginx :80   │     │  Node :3001  │     │  SSH (events)   │
└──────────────┘     └──────┬───────┘     └─────────────────┘
                            │
                     ┌──────┴───────┐
                     │   SQLite     │
                     │   (Prisma)   │
                     └──────────────┘
                            │
                     ┌──────┴───────┐
                     │   Sidecar    │
                     │  Go/Pion     │
                     │  WebRTC :9800│
                     └──────────────┘

Public:  /widget/:token  ──▶  SVG / PNG / JSON (no auth)
```

**Four packages** in a pnpm monorepo:

| Package | Description |
|---------|-------------|
| `@ts6/common` | Shared types, constants, utilities |
| `@ts6/backend` | Express API, WebQuery client, bot engine, voice bots, widgets |
| `@ts6/frontend` | React SPA with Vite, TailwindCSS, shadcn/ui |
| `sidecar` | Go WebRTC media relay (Pion) for video streaming |

The backend proxies all TeamSpeak API calls. The frontend never has direct access to API keys or server credentials.

## Tech Stack

**Frontend:** React 18, Vite, TailwindCSS, shadcn/ui, TanStack Query + Table, React Flow, Recharts, Zustand

**Backend:** Node.js, Express, Prisma (SQLite), JWT authentication, WebQuery HTTP client, SSH event listener

**Voice/Audio:** Custom TS3 voice protocol client (UDP), Opus encoding, FFmpeg, yt-dlp

**Video Streaming:** Go sidecar with Pion WebRTC v4, RTCP Sender Reports for A/V sync

## Quick Start (Docker)

Prebuilt images are published to **GitHub Container Registry** only for immutable `vX.Y.Z` releases created by Release Please. Ordinary pushes and PR merges to `main` do **not** publish images. [`.github/workflows/publish-images.yml`](.github/workflows/publish-images.yml) is invoked after a release is created and also has a manual recovery path for republishing an existing release tag.

| Service  | Image |
|----------|--------|
| Backend  | `ghcr.io/uniskela/ts6-manager/backend:latest` |
| Frontend | `ghcr.io/uniskela/ts6-manager/frontend:latest` |
| Sidecar  | `ghcr.io/uniskela/ts6-manager/sidecar:latest` |
| All-in-one | `ghcr.io/uniskela/ts6-manager/all-in-one:latest` |

Pull without logging in once the packages are **Public** (Packages → each image → Package settings). The workflow tries to set that automatically after the first publish.

### Split stack (default)

1. Download the [`docker-compose.yml`](docker-compose.yml)
2. Create a `.env` file next to it:

```env
JWT_SECRET=your-random-secret-at-least-32-characters
ENCRYPTION_KEY=another-random-secret-for-credential-encryption
SIDECAR_SECRET=shared-secret-between-backend-and-sidecar
```

Generate secure values:

```bash
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "SIDECAR_SECRET=$(openssl rand -base64 32)" >> .env
```

3. Start the stack:

```bash
docker compose up -d
```

4. Open `http://localhost:3000/setup` and create your admin account
5. Log in, then add your TeamSpeak server connection under **Settings → Connections** (host, WebQuery port, API key)

> `JWT_SECRET`, `ENCRYPTION_KEY`, and `SIDECAR_SECRET` are **required** in production. The backend refuses to start without them when `NODE_ENV=production`.
> The sidecar HTTP API is authenticated with `SIDECAR_SECRET` and is not published to the host by default.
> Browser WebRTC preview needs a published UDP mux (`WEBRTC_UDP_PORT`, often `10000`) and `WEBRTC_NAT1TO1_IP` - see `docker-compose.pr-test.yml` and [Video streaming](docs/video-streaming.md).

### Connection credentials and upgrades

WebQuery API keys and SSH passwords are encrypted before they are stored in the persistent SQLite database. Normal container restarts and image upgrades therefore do **not** require you to re-enter connection credentials, provided the database volume and encryption key are preserved.

- Generate `ENCRYPTION_KEY` once and keep the same value across restarts, upgrades, and redeployments. Changing it prevents TS6 Manager from decrypting credentials that were stored with the previous key.
- When creating a WebQuery API key manually, include `lifetime=0` if you want a persistent key (for example, `apikeyadd scope=manage lifetime=0 ip=0.0.0.0/0`). Omitting `lifetime` can create a time-limited key that later starts returning `invalid apikey`.
- When editing an existing connection, secret inputs such as the WebQuery API key or SSH password are intentionally not populated back into the browser. Leaving one of those fields blank keeps the saved encrypted value unchanged.
- On startup, TS6 Manager validates restored WebQuery credentials in the background without delaying the WebUI. A log message such as `invalid apikey` means the TeamSpeak server rejected the saved key; it does not mean TS6 Manager forgot or cleared it.
- Transient SSH closes during the initial handshake are retried automatically. Authentication and host-key failures remain fatal and require the connection settings or server trust configuration to be corrected.

### All-in-one (single container)

Runs nginx + backend + sidecar in one image (adapted from upstream [PR #64](https://github.com/clusterzx/ts6-manager/pull/64) by [@joaobosconff](https://github.com/joaobosconff)):

```bash
# Same .env secrets as above
docker compose -f docker-compose.all-in-one.yml up -d
# or: docker pull ghcr.io/uniskela/ts6-manager/all-in-one:latest
```

Open `http://localhost:3000` (override with `HOST_PORT`). Only port 80 is published; backend and sidecar stay on loopback inside the container.

### Building from Source

**Full local stack with TeamSpeak 6 (beta13)** - preferred happy path:

```bash
git clone https://github.com/uniskela/ts6-manager.git
cd ts6-manager
cp .env.pr-test.example .env
docker compose -f docker-compose.pr-test.yml up --build
```

Then open `http://localhost:3000/setup`, create the first admin, and log in. The bundled TeamSpeak connection is already present (WebQuery + SSH Query). Demo mode remains available separately.

**Manager only (no TeamSpeak):** use `docker compose -f docker-compose.local.yml up -d --build` after writing `JWT_SECRET`, `ENCRYPTION_KEY`, and `SIDECAR_SECRET` into `.env`.

> This repository is an opinionated continuation of the original [`clusterzx/ts6-manager`](https://github.com/clusterzx/ts6-manager) project.

### Coolify / Reverse Proxy

Use [`docker-compose.coolify.yml`](docker-compose.coolify.yml) as a starting point. Key differences from the standard compose:

- No `ports` section - the reverse proxy handles routing
- Set the domain on the **frontend** service in Coolify (port 80)
- If your TS server runs in a separate Docker network, add it as an external network on the backend service:

```yaml
services:
  backend:
    networks:
      - ts6-network
      - ts-server-net

networks:
  ts-server-net:
    external: true
    name: your-ts-server-network-id
```

## Development

Requires: Node.js 20+ and **pnpm 9.x**. CI deliberately uses pnpm 9; newer pnpm majors change dependency build-script/override handling and are not the supported local baseline yet.

For a reproducible local setup with Corepack:

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev          # starts backend + frontend in parallel
```

Backend runs on `:3001`, frontend on `:5173` (Vite dev server).

### Database

Prisma with SQLite. On first run (local development):

```bash
cd packages/backend
npx prisma db push
npx prisma db seed
```

**Docker Compose upgrades:** every backend start runs [`docker-commands/apply-schema.sh`](docker-commands/apply-schema.sh). If the persistent `backend-data` volume already has a database (including installs from older images with no version marker), the script logs an upgrade, runs `prisma db push` to bring the schema current, seeds if needed, and records `packages/backend/prisma/SCHEMA_VERSION` under `data/.schema-version`. No manual migrate step is required for `docker compose up` after pulling a new image - bump `SCHEMA_VERSION` whenever the Prisma schema changes so upgrade logs stay accurate.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | - | **Required.** Secret for JWT signing. Must be set in production. |
| `ENCRYPTION_KEY` | - | **Required in production.** Dedicated AES-256-GCM key for stored credentials. Generate it once and keep the same value across restarts/upgrades; dev may fall back to `JWT_SECRET`. |
| `PORT` | `3001` | Backend port |
| `DATABASE_URL` | `file:./data/ts6webui.db` | SQLite database path |
| `JWT_ACCESS_EXPIRY` | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRY` | `7d` | Refresh token lifetime |
| `FRONTEND_URL` | `http://localhost:3000` | CORS origin |
| `MUSIC_DIR` | `/data/music` | Directory for downloaded music files |
| `SIDECAR_URL` | - | Optional. Full URL of the WebRTC sidecar service (e.g. `http://ts6-sidecar:9800`). Set in Docker when sidecar runs as a separate container. |
| `SIDECAR_SECRET` | - | **Required when `SIDECAR_URL` is set in production.** Shared bearer token for sidecar mutating APIs. |
| `YT_COOKIE_FILE` | - | Optional. Path to a Netscape-format cookies.txt file for yt-dlp. Can also be managed via **Settings → YouTube** in the UI. |

## Environment Variables: Sidecar / Video Streaming

Defaults below are the **sidecar code defaults**. Compose files may intentionally override them (for example, the standard split-stack compose raises the RTP queue sizes).

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBRTC_UDP_PORT` | unset | Shared IPv4 ICE UDP mux port for browser WebRTC preview (publish this UDP port from Docker) |
| `WEBRTC_NAT1TO1_IP` | unset | Host/LAN/Tailscale **IPv4** IP(s) advertised as ICE host candidates |
| `WEBRTC_BIND_IP` | `127.0.0.1` (compose) | Host bind address for the published WebRTC UDP mapping |
| `VIDEO_QUEUE_SIZE` | `1024` | Size of the video RTP queue |
| `AUDIO_QUEUE_SIZE` | `2048` | Size of the audio RTP queue |
| `SYNC_PLAYOUT_BUFFER_MS` | `50` | Small playout buffer used by the adaptive pacing logic |
| `SYNC_VIDEO_BIAS_MS` | `0` | Optional extra holdback for video to fine-tune sync |
| `SYNC_MAX_DELAY_MS` | `500` | Maximum pacing delay / latency sample used by the sync clamp |
| `AUDIO_DELAY_MS` | `0` | Optional manual audio delay; normally leave at `0` with adaptive pacing |
| `SIDECAR_DEBUG_LOGS` | `0` | Set to `1` to enable verbose high-frequency runtime logs |
| `VIDEO_RTP_READ_BUFFER` | `4194304` | Requested UDP socket read buffer for video RTP |
| `AUDIO_RTP_READ_BUFFER` | `1048576` | Requested UDP socket read buffer for audio RTP |
| `VIDEO_WIDTH` | `1280` | Default output width when not supplied by the API |
| `VIDEO_HEIGHT` | `720` | Default output height when not supplied by the API |
| `VIDEO_FRAMERATE` | `30` | Default output frame rate when not supplied by the API |
| `VIDEO_BITRATE` | `1500k` | Default VP8 target bitrate |
| `AUDIO_BITRATE` | `128k` | Default Opus target bitrate |
| `VIDEO_CPU_USED` | `4` | libvpx realtime speed/quality trade-off |
| `VIDEO_ENCODE_THREADS` | CPU count | libvpx encode thread count |
| `VIDEO_BUFSIZE` | auto | Optional override; otherwise approximately `2 × VIDEO_BITRATE` |

## Music Bot Text Commands

When a music bot is connected to a configured command channel, users there can control it via chat. These are the built-in commands; custom commands (and recommended presets like `!rules` / `!links`) can also be configured under Music Bots → Commands.

- **`!help`** - Show built-in and custom commands
- **`!here [id]`** / **`!come [id]`** - Summon an idle music bot to your channel (or target a bot by ID)
- **`!commands`** - List enabled custom chat commands
- **`!play <url>`** - Play YouTube, Spotify, or Apple Music media
- **`!play`** - Resume paused playback
- **`!queue [show|clear|remove <n>|play <n>|<url>]`** - Show or manage the queue using one-based positions
- **`!add <url>`** - Alias for `!queue <url>`
- **`!playlist [name-or-id]` / `!pl <name-or-id>`** - List or append a saved playlist; an idle connected bot resumes queue order
- **`!repeat [off|track|queue]`** - Show or set repeat mode
- **`!seek <seconds|+seconds|-seconds>`** - Seek within a local/downloaded track
- **`!remove <text>`** - Remove one unambiguous upcoming title/artist match
- **`!shuffle [on|off]`** - Toggle or set shuffle
- **`!stop`** - Stop playback
- **`!pause`** - Toggle pause/resume
- **`!skip` / `!next`** - Next track in queue
- **`!prev`** - Previous track
- **`!vol [0-100]` / `!volume [0-100]`** - Show or set volume
- **`!np` / `!nowplaying`** - Show the current track
- **`!radio [id]`** - List or play radio stations
- **`!stream <url> [preset]`** - Start a video stream (YouTube and Twitch links at Auto quality by default; or `auto`, `480p` … `2160p`)
- **`!stopstream`** - Stop the active video stream
- **`!viewers`** - List stream viewers
- **`!channels [search]`** - List/search IPTV channels
- **`!tv <name>` / `!iptv <name>`** - Stream an IPTV channel
- **`!lyrics [artist - title]`** - Show lyrics for the current track or search

## Requirements

- TeamSpeak server with **WebQuery HTTP** enabled (not raw/telnet)
- WebQuery API key (generated via `apikeyadd` or server admin tools)
- SSH ServerQuery access to the TS server when using the file browser, bot flow event triggers, or music-bot channel chat commands
- `yt-dlp` and `ffmpeg` installed on the backend (included in the Docker image)

## TeamSpeak compatibility and beta13 setup

Tested TeamSpeak Server: **6.0.0-beta13** (official image
`teamspeaksystems/teamspeak6-server:6.0.0-beta13`). Older versions are not
intentionally excluded; the manual key method below remains available.

Configure these on the **TeamSpeak server/container**, not the TS6 Manager container:

```env
TSSERVER_QUERY_HTTP_ENABLED=1
TSSERVER_QUERY_HTTP_ALLOW_GUEST=0
TSSERVER_QUERY_SSH_ALLOW_GUEST=0
TSSERVER_QUERY_ADMIN_API_KEY=<secure-stable-key>
```

Beta13 enables guest HTTP/SSH Query access by default. For administrative deployments,
we recommend explicitly disabling it: TS6 Manager requires authenticated WebQuery
and uses optional authenticated SSH. Guest access can remain enabled when you
intentionally want to expose the Guest Server Query permissions; it is not needed
by this application. Restrict Query ports to trusted management networks.

On beta13+ Docker, `TSSERVER_QUERY_ADMIN_API_KEY` is the simplest deterministic way
to provision the built-in `serveradmin` management key. Generate a strong key and
keep it stable. **Changing it replaces the relevant built-in serveradmin management
API key.** The previously encrypted key in TS6 Manager then stops authenticating;
update the API key in the saved connection. Do not log or share the value. TS6
Manager continues to store connection secrets encrypted; keys remain mandatory.

Alternatively, including on older servers, connect using authenticated SSH Query:

```text
use 1
apikeyadd scope=manage lifetime=0 ip=0.0.0.0/0
```

`lifetime=0` makes the key non-expiring. Narrow the allowed source IP range where
practical. The bootstrap and manual methods are alternatives, not two required steps.

Beta13 also offers **optional external Prometheus monitoring**. Metrics are disabled
by default (`TSSERVER_METRICS_ENABLED=0`); the default port is `9187`. The endpoint
is unauthenticated. Bind it to a restricted interface (`TSSERVER_METRICS_IP`) and
apply firewall/network restrictions rather than exposing it publicly. Per-packet
voice diagnostics (`TSSERVER_METRICS_VOICE`) add overhead: benchmark before enabling
on busy production servers. When a connection enables **metrics scrape**, TS6 Manager
fetches `/metrics` from the configured host/port (defaulting to the WebQuery host)
to augment the dashboard; keep that listener private and reachable from the backend
(not localhost-only when the manager is remote).

Server logs default to UTC in beta13. Administrators can select `utc` or `local`
using `TSSERVER_LOG_TIMEZONE`. TS6 Manager displays raw log text without converting
its timestamps.

The separate [compatibility workflow](.github/workflows/ts6-compat.yml) runs manually, weekly, and on PRs changing the smoke test or WebQuery client, with an image-tag input for future betas. It starts an isolated official
server with an ephemeral admin key and guest Query disabled, waits for an online
virtual server, rejects unauthenticated HTTP access, and exercises the real
`WebQueryClient`: `version`, `serverinfo`, `clientlist`, `channellist` and
`serverrequestconnectioninfo`, plus a channel create/info/non-forced delete round-trip.
It does not certify voice/video playback, public YouTube availability, SSH/file
transfers, production networking, or every server configuration. It is separate
from fast PR validation.

## Download progress

Explicit library downloads (single, selected batch, and playlist “download selected”)
show current/total items, real yt-dlp percentage, speed, ETA and processing state.
Jobs run in the background; polling stops on completion/failure or component unmount.
Progress endpoints require application authentication, admin permissions, and matching
server and requesting user. Jobs are in memory, capped at 100 retained / four active,
and expire after ten minutes without updates or thirty minutes total. A backend
restart loses progress history. Stream-playlist registration retains its existing
semantics and does not download media eagerly.

### Bundled yt-dlp lifecycle

Production containers do not self-update packages. yt-dlp is installed at image
build time using pip’s required PEP-668 option; builds check `yt-dlp --version`,
`ffmpeg -version`, `node --version`, and `deno --version`. A pinned Deno binary
(see `.deno-version`) is the yt-dlp JavaScript runtime for YouTube EJS / `n`
challenges (`--js-runtimes deno` only). Image Node stays at 20 for the Nest
backend and is not configured as an EJS fallback (yt-dlp requires Node 22+).
Pull a newly built TS6 Manager image and recreate the container to refresh
bundled yt-dlp and Deno.
Rebuilding with a fresh image build also refreshes them. No in-app package
updater is provided. Extractor tests use structured fixtures; a public-video
smoke test is deliberately not a release gate because availability, rate limits
and regional restrictions are outside our control.

## Contributors

TS6 Manager is maintained by [@uniskela](https://github.com/uniskela) and builds on [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager) by [@clusterzx](https://github.com/clusterzx).

Thanks go to these people ([emoji key](https://allcontributors.org/en/reference/emoji-key/)):

<!--
  Contributor avatar table: All Contributors emoji types
  (https://allcontributors.org/en/reference/emoji-key/).
  Layout approach inspired by Soju06/codex-lb README
  (https://github.com/Soju06/codex-lb) - not a copy of that list.
  Detailed provenance stays in CREDITS.md.
-->
<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/uniskela"><img src="https://avatars.githubusercontent.com/u/104075208?v=4&s=100" width="100px;" alt="Uniskela"/><br /><sub><b>Uniskela</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=uniskela" title="Code">💻</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=uniskela" title="Documentation">📖</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=uniskela" title="Maintenance">🚧</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=uniskela" title="Infrastructure">🚇</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/clusterzx"><img src="https://avatars.githubusercontent.com/u/32274973?v=4&s=100" width="100px;" alt="clusterzx"/><br /><sub><b>clusterzx</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=clusterzx" title="Code">💻</a> <a href="#ideas-clusterzx" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Albirew"><img src="https://avatars.githubusercontent.com/u/2805161?v=4&s=100" width="100px;" alt="Albirew"/><br /><sub><b>Albirew</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3AAlbirew" title="Bug reports">🐛</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=Albirew" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/BalconyJH"><img src="https://avatars.githubusercontent.com/u/73932916?v=4&s=100" width="100px;" alt="BalconyJH"/><br /><sub><b>BalconyJH</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3ABalconyJH" title="Bug reports">🐛</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=BalconyJH" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/BehaveDude"><img src="https://avatars.githubusercontent.com/u/255583987?v=4&s=100" width="100px;" alt="BehaveDude"/><br /><sub><b>BehaveDude</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3ABehaveDude" title="Bug reports">🐛</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=BehaveDude" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/bro-network"><img src="https://avatars.githubusercontent.com/u/174516032?v=4&s=100" width="100px;" alt="bro-network"/><br /><sub><b>bro-network</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=bro-network" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/bufanda"><img src="https://avatars.githubusercontent.com/u/30717829?v=4&s=100" width="100px;" alt="bufanda"/><br /><sub><b>bufanda</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3Abufanda" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/coom"><img src="https://avatars.githubusercontent.com/u/10179617?v=4&s=100" width="100px;" alt="coom"/><br /><sub><b>coom</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=coom" title="Code">💻</a> <a href="#ideas-coom" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/crtnbr"><img src="https://avatars.githubusercontent.com/u/45666738?v=4&s=100" width="100px;" alt="crtnbr"/><br /><sub><b>crtnbr</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3Acrtnbr" title="Bug reports">🐛</a> <a href="#ideas-crtnbr" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/D3nnis3n"><img src="https://avatars.githubusercontent.com/u/25908592?v=4&s=100" width="100px;" alt="Dennis Scholz"/><br /><sub><b>Dennis Scholz</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3AD3nnis3n" title="Bug reports">🐛</a> <a href="#ideas-D3nnis3n" title="Ideas, Planning, & Feedback">🤔</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=D3nnis3n" title="Tests">⚠️</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/dbillai"><img src="https://avatars.githubusercontent.com/u/158840331?v=4&s=100" width="100px;" alt="dbillai"/><br /><sub><b>dbillai</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3Adbillai" title="Bug reports">🐛</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=dbillai" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/DomeNinchen"><img src="https://avatars.githubusercontent.com/u/217283391?v=4&s=100" width="100px;" alt="DomeNinchen"/><br /><sub><b>DomeNinchen</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=DomeNinchen" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/GingerFury6"><img src="https://avatars.githubusercontent.com/u/168943721?v=4&s=100" width="100px;" alt="Philipp"/><br /><sub><b>Philipp</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=GingerFury6" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/joaobosconff"><img src="https://avatars.githubusercontent.com/u/31070155?v=4&s=100" width="100px;" alt="João Bosco"/><br /><sub><b>João Bosco</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=joaobosconff" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/KorppuJauho"><img src="https://avatars.githubusercontent.com/u/130571566?v=4&s=100" width="100px;" alt="KorppuJauho"/><br /><sub><b>KorppuJauho</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=KorppuJauho" title="Code">💻</a> <a href="https://github.com/uniskela/ts6-manager/issues?q=author%3AKorppuJauho" title="Bug reports">🐛</a> <a href="#ideas-KorppuJauho" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/kytos22"><img src="https://avatars.githubusercontent.com/u/13838233?v=4&s=100" width="100px;" alt="Marcos Vidal Martinez"/><br /><sub><b>Marcos Vidal Martinez</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=kytos22" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/LemDog"><img src="https://avatars.githubusercontent.com/u/19418647?v=4&s=100" width="100px;" alt="Maxwell D."/><br /><sub><b>Maxwell D.</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=LemDog" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/LennBoedd"><img src="https://avatars.githubusercontent.com/u/87300236?v=4&s=100" width="100px;" alt="Lennart B."/><br /><sub><b>Lennart B.</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3ALennBoedd" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/LgnRorooo"><img src="https://avatars.githubusercontent.com/u/115776545?v=4&s=100" width="100px;" alt="Rodrigo De Almeida Pina"/><br /><sub><b>Rodrigo De Almeida Pina</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=LgnRorooo" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/liqinghan2000"><img src="https://avatars.githubusercontent.com/u/104827187?v=4&s=100" width="100px;" alt="liqinghan2000"/><br /><sub><b>liqinghan2000</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3Aliqinghan2000" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Lordeisenhelm"><img src="https://avatars.githubusercontent.com/u/134092155?v=4&s=100" width="100px;" alt="Lord"/><br /><sub><b>Lord</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3ALordeisenhelm" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/meauxh"><img src="https://avatars.githubusercontent.com/u/127511054?v=4&s=100" width="100px;" alt="meauxh"/><br /><sub><b>meauxh</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3Ameauxh" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mqh9007"><img src="https://avatars.githubusercontent.com/u/45141834?v=4&s=100" width="100px;" alt="mqh9007"/><br /><sub><b>mqh9007</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=mqh9007" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/pimushkin"><img src="https://avatars.githubusercontent.com/u/30329479?v=4&s=100" width="100px;" alt="pimushkin"/><br /><sub><b>pimushkin</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3Apimushkin" title="Bug reports">🐛</a> <a href="#ideas-pimushkin" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/prankroker"><img src="https://avatars.githubusercontent.com/u/76559527?v=4&s=100" width="100px;" alt="Danylo"/><br /><sub><b>Danylo</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=prankroker" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/s3bul"><img src="https://avatars.githubusercontent.com/u/6891296?v=4&s=100" width="100px;" alt="Sebastian K"/><br /><sub><b>Sebastian K</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3As3bul" title="Bug reports">🐛</a> <a href="https://github.com/uniskela/ts6-manager/commits?author=s3bul" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/simardwtf"><img src="https://avatars.githubusercontent.com/u/67881020?v=4&s=100" width="100px;" alt="Julien Simard"/><br /><sub><b>Julien Simard</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=simardwtf" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Slipi089"><img src="https://avatars.githubusercontent.com/u/59597268?v=4&s=100" width="100px;" alt="Martin"/><br /><sub><b>Martin</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3ASlipi089" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/StEnDi78"><img src="https://avatars.githubusercontent.com/u/202441998?v=4&s=100" width="100px;" alt="StEnDi78"/><br /><sub><b>StEnDi78</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3AStEnDi78" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/TheMaxik"><img src="https://avatars.githubusercontent.com/u/9915167?v=4&s=100" width="100px;" alt="TheMaxik"/><br /><sub><b>TheMaxik</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3ATheMaxik" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/UIP88"><img src="https://avatars.githubusercontent.com/u/127998909?v=4&s=100" width="100px;" alt="UIP88"/><br /><sub><b>UIP88</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3AUIP88" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/uniplayer1"><img src="https://avatars.githubusercontent.com/u/83558178?v=4&s=100" width="100px;" alt="uniplayer1"/><br /><sub><b>uniplayer1</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=uniplayer1" title="Code">💻</a> <a href="#ideas-uniplayer1" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ValiOff8"><img src="https://avatars.githubusercontent.com/u/241494336?v=4&s=100" width="100px;" alt="Vali"/><br /><sub><b>Vali</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/commits?author=ValiOff8" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/vinookie"><img src="https://avatars.githubusercontent.com/u/110264086?v=4&s=100" width="100px;" alt="vinookie"/><br /><sub><b>vinookie</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3Avinookie" title="Bug reports">🐛</a> <a href="#ideas-vinookie" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Vman1194"><img src="https://avatars.githubusercontent.com/u/270235106?v=4&s=100" width="100px;" alt="Vman1194"/><br /><sub><b>Vman1194</b></sub></a><br /><a href="https://github.com/uniskela/ts6-manager/issues?q=author%3AVman1194" title="Bug reports">🐛</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome.

[CREDITS.md](CREDITS.md) records what each person contributed, with links to the issues, pull requests and forks involved.


## License

MIT
