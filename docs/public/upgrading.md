# Upgrading

TS6 Manager is designed so normal container upgrades retain the application database and encrypted TeamSpeak credentials.

Coming from `clusterzx/ts6-manager`? Follow [Switching from clusterzx](migrating-from-clusterzx.md) first; it needs two extra environment variables.

## Before upgrading

Preserve:

- the persistent backend database volume;
- uploaded IPTV playlist source files under that volume (`data/iptv/`);
- bot avatar images under that volume (`data/bot-avatars/`);
- hosted channel banner images under that volume (`data/channel-banners/`);
- the current `ENCRYPTION_KEY`;
- `JWT_SECRET` and `SIDECAR_SECRET`;
- any media/library volume you want to retain; and
- any yt-dlp cookie file you mounted externally.

Changing `ENCRYPTION_KEY` prevents the backend from decrypting previously stored API keys and SSH passwords.

### Upgrading to 1.10.0

**Back up the database before starting the 1.10.0 backend.** Stop the backend first and make a consistent copy of its persistent data volume, including `ts6webui.db`, any SQLite journal/WAL files, uploaded IPTV playlists, bot avatars and hosted channel banners. Keep the backup and the previous image tag until the upgrade is verified. A rollback must restore the matching database backup as well as the old image.

The SQLite schema changes merged for 1.10.0 are:

- **`IptvChannelPick`**: stores per-server favourites and recent channels using `serverConfigId`, `playlistId` and a stable `channelKey`, plus `name`, `favourite` and `lastStreamedAt`. Picks cascade when their server or playlist is deleted.
- **`MusicBot` avatar columns**: `avatarMode`, `avatarFile` and `avatarMd5`. Existing bots default to `none`; new bots created from the UI use the default avatar. The SQL migration reference is `packages/backend/prisma/migrations/20261003000000_bot_avatars/migration.sql`.
- **`IptvChannel` country and language columns**: `tvgCountry` and `tvgLanguage`, read from each channel's `tvg-country` and `tvg-language` tags. Existing playlists fill them on their next refresh; there is no backfill. The SQL migration reference is `packages/backend/prisma/migrations/20261003010000_iptv_country_language/migration.sql`.

Container startup still reconciles the schema with `prisma db push` as described below; operators do not need to run the reference SQL separately.

After upgrading, open **Bot Hub → Open console** for playback. **Media Library** remains at `/media-bots` with five tabs, and custom replies move to **Bot Flows → Chat commands**. Existing music, playlists and saved credentials remain in the database. Playlists are now shared across all bots on their server, so `!playlist` can list more playlists than before. Old page links redirect to their new locations.

Before merging the release PR, run the [1.10.0 smoke checklist](https://github.com/uniskela/ts6-manager/blob/main/docs/internal/plans/164-1-10-0-rc-smoke.md) against the release candidate, including the AMD/VAAPI homelab checks.

### Upgrading to 1.11.0

This section covers upgrading from 1.10.2. Skip it if you are installing fresh.

**Back up the database before starting the 1.11.0 backend.** Stop the backend, then copy its persistent data volume: `ts6webui.db`, any SQLite journal or WAL files next to it, uploaded IPTV playlists, bot avatars and hosted channel banners. Keep the backup and the previous image tag until you have checked the upgrade.

**Rolling back needs both the old image tag and the matching database backup.** The 1.11.0 schema adds tables and columns that a 1.10.x image does not know about. On start, the 1.10.x image would have to drop them to make the database match its own schema, and Prisma refuses to drop columns or tables that hold data unless data loss is accepted. The startup script does not accept it. Restore the backup instead of pointing an old image at a 1.11.0 database.

The SQLite schema changes since 1.10.2 are:

- **`VideoQueueEntry`** (new table): each bot's queued videos, kept in order so the queue survives a restart. The SQL reference is `packages/backend/prisma/migrations/20261010000000_video_queue/migration.sql`.
- **`MusicBot` automation columns**: `automationSettings` and `automationState`, which hold the Auto-DJ and 24/7 settings and their saved timers. A missing value means disabled, so existing bots start with automation off. The SQL reference is `packages/backend/prisma/migrations/20261010010000_bot_automation/migration.sql`.
- **`MusicRequest` history columns**: `artist`, `duration`, `source` (default `url`), `status` (default `available`) and `musicBotId`. Rows recorded before history was kept per bot get `musicBotId` 0, and bots on that server connection still show them. The uniqueness rule changes from (server connection, URL) to (server connection, bot, URL), and an index on (server connection, request time) is added. No reference SQL file exists for this change; it is applied from the Prisma schema only.

Container startup applies these automatically with `prisma db push`, as described under [Database schema](#database-schema), and records schema version `2026.10.10-music-request-history`. No manual migration step is needed. The maintainers tried the upgrade once on a scratch copy of a 1.10.2 SQLite database that held server, bot and request rows: it finished without error, kept every row and filled the new columns with their defaults. That is one test database, not a guarantee for yours, which is why the backup comes first.

The startup script stops on the first error (`set -e`). If the schema step fails, the backend never starts. The container exits, and with `restart: unless-stopped` it restarts and fails again, so the symptom is a restart loop with the last `[schema]` log line being `Running: prisma db push`. Read the lines above it, restore your backup if the database was changed by hand, and see [Troubleshooting](troubleshooting.md#databaseschema-problems-after-upgrade).

#### Reverse proxy: set `TRUST_PROXY`

**Breaking change for some reverse-proxy setups** (an all-in-one install behind an outer proxy, or a backend run outside the stock images). Before 1.11.0 the backend always trusted "one hop" in front of it. That setting is gone. The backend now trusts only the proxies named in `TRUST_PROXY`, and the bundled images set a default for it:

- the **all-in-one** image trusts `loopback`, which is its own bundled nginx;
- the **split** backend image uses `private-peer`: it trusts one hop, and only when the peer connecting to the backend has a private address (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or fc00::/7). That is the frontend container on the compose network, and it is the same single hop 1.10.2 trusted; and
- a backend run **outside these images** (plain `node`, a development setup) trusts nothing.

**Stock all-in-one and split Docker installs with no other proxy in front need no action.** Set `TRUST_PROXY` yourself only if:

- you run the all-in-one image behind an outer reverse proxy: use `TRUST_PROXY=loopback,<outer proxy IP or CIDR>`;
- you run the split images behind an outer reverse proxy and want a limit per visitor: use `TRUST_PROXY=<frontend container IP or compose subnet>,<outer proxy IP or CIDR>`. Left unset, visitors share the outer proxy's limit, as they did in 1.10.2; or
- you run the backend outside the stock images behind a proxy.

Without the right value, the backend sees every visitor as the proxy's address, so the login rate limit (15 attempts per 15 minutes) and the listener remote limits are shared by everyone: one person mistyping a password can lock everyone else out of signing in for a while. The backend logs the setting it uses at startup (`Trusted proxies: …`) and warns once if an `X-Forwarded-For` header arrives while nothing is trusted.

For the split image, a peer with a private address that connects straight to the backend is taken for the proxy and can choose its own rate-limit bucket. **Breaking change if you adopt the new stock compose file and another machine calls the backend API directly:** the stock `docker-compose.yml` now publishes port 3001 on `127.0.0.1` only. Set `BACKEND_BIND_IP` to keep it reachable, or send those requests through the frontend port. Your existing compose file is not changed by an upgrade: if it has `"3001:3001"`, change it to `"127.0.0.1:3001:3001"` or remove the mapping unless another machine calls the API directly (a reverse proxy on a different host, for example). A value you set always replaces the image default; `none` trusts nothing, and `true` or a number of hops is refused at startup. Recommended values and the accepted syntax are in [Reverse proxy — Listener remote and client IP limits](reverse-proxy.md#listener-remote-and-client-ip-limits), and the variable is listed in [Environment variables](environment-variables.md).

#### Defaults after upgrading

- **Media command permissions** for playback, queue and video commands default to **Everyone**, as before. Restrict them under **Bot Flows → Chat commands** if you want to. See [Bot flows](bot-flows.md#chat-commands).
- **Auto-DJ and 24/7 presence are off** for existing bots. Turn them on per bot under **Bot settings → Auto-DJ & 24/7**. See [Media bots](music-bots.md#auto-dj-and-247-presence).
- **Video and TeamSpeak disconnects**: a bot that loses its TeamSpeak connection while streaming video now stops the stream and keeps the video queue. Press **Play queue** after it reconnects. See [Video streaming](video-streaming.md#queue-videos-and-playlists).
- **Listener remote** (`!remote`) needs an HTTPS **Public URL** before it works. Set `PUBLIC_URL` (or save the address in the **Public URL of this manager** field under the hosted banner upload in a channel's edit dialog). See [Listener remote](music-bots.md#listener-remote).
- **Native sidecar**: archives for Windows, Linux and macOS are attached to each release. A native sidecar from 1.10.x reports no version and shows as `unversioned`, which is not supported alongside a 1.11.0 backend. Replace it with the 1.11.0 archive; see [Native media sidecar](native-sidecar.md#version-compatibility). Docker sidecars update with the image tag.

#### Media sources on Tailscale and other shared addresses

**Breaking change if a media source lives on a `100.64.0.0/10` address**, which includes Tailscale hosts and carrier-grade NAT. 1.10.x reached those addresses without asking. 1.11.0 treats them like private addresses and refuses them until an admin allows the host.

- **IPTV playlists and channels**: add the hostname, IP or a narrow range under **IPTV → Local hosts**, then refresh the playlist. See [Playlists and channels on your local network](video-streaming.md#playlists-and-channels-on-your-local-network).
- **Pasted links, `!play` and `!stream` links, radio station URLs and Bot Flow HTTP requests** to those addresses cannot be allowed. Serve the media through an allowed IPTV playlist or from a publicly reachable address instead.

Cloud metadata addresses stay blocked even when listed.

## Pull and recreate

For the split stack:

~~~bash
docker compose pull
docker compose up -d
~~~

For the all-in-one deployment:

~~~bash
docker compose -f docker-compose.all-in-one.yml pull
docker compose -f docker-compose.all-in-one.yml up -d
~~~

Release images are produced from immutable Release Please tags. Pulling a newly published release also refreshes bundled runtime tools such as yt-dlp.

### yt-dlp lifecycle

Release images pin the exact yt-dlp version recorded in `.yt-dlp-version`. The backend reports that bundled version at startup but does not update it at runtime, so restarting the same image cannot silently change media-extractor behaviour. The same images pin Deno (`.deno-version`) and configure yt-dlp with `--js-runtimes deno` only, so YouTube EJS solvers run without operators installing a JS runtime by hand. Image Node stays at 20 for the Nest app and is not used as an EJS fallback.

A scheduled GitHub Actions check compares the pin with yt-dlp's latest stable release once a week. When a newer stable version is available, it opens a normal `fix(deps)` pull request instead of changing production automatically. The update PR is expected to pass the application validation and container build/security gates before it is merged. Release Please can then include the dependency refresh in a patch release.

If YouTube changes before the next scheduled check, maintainers can manually run the **Check yt-dlp updates** workflow. Runtime self-updating should remain disabled.

## Database schema

Every backend container start runs `docker-commands/apply-schema.sh`.

For an existing persistent database the startup path:

1. checks the schema-version marker;
2. applies the current Prisma schema with `prisma db push`;
3. seeds required data when needed; and
4. records the current schema version.

A normal Docker upgrade does not require a separate manual migration command.

## TeamSpeak credentials after upgrade

Saved WebQuery API keys and SSH passwords remain encrypted in the database and should continue working after a normal restart or image upgrade.

If TeamSpeak reports `invalid apikey`, verify that the server-side API key is still valid. On beta13, changing `TSSERVER_QUERY_ADMIN_API_KEY` replaces the relevant built-in management key, so the saved connection must then be updated.

See [Troubleshooting](troubleshooting.md) if the new containers do not become healthy.
