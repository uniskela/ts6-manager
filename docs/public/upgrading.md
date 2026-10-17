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

### Upgrading to 1.11.2

#### Media downloads go through a checking proxy

**Breaking change for some setups** (an outbound proxy set through `HTTP_PROXY`/`HTTPS_PROXY`, or media on your local network). Every media download (yt-dlp for music and video, and ffmpeg playing a track URL yt-dlp resolved) now connects through a checking proxy inside the backend; see [Security — Media downloads](security.md#media-downloads). There is no schema change and no Compose change. Most links work as before. These changes may affect you:

- **Outbound proxy settings.** Media downloads no longer use `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` from the backend's environment. If the backend can only reach the internet through an outbound proxy, set `MEDIA_UPSTREAM_PROXY=http://host:port`. The backend logs a startup warning when one of the old variables is set and `MEDIA_UPSTREAM_PROXY` is not. The outbound proxy is asked for `CONNECT` tunnels to IP addresses on ports 80 and 443, not host names. A proxy that only allows named domains, or refuses `CONNECT` to port 80, will refuse these requests, and the backend must be able to resolve public DNS names itself.
- **Links to your local network.** Pasted links, `!play` links and Media Library downloads that point at a NAS, home server or any other private, Tailscale or link-local address now fail with "This media link could not be loaded." There is no exception for them, including for administrators. Upload the file in the Media Library, or copy it into the music folder and run **Scan**. IPTV playlists and channels keep their **IPTV → Local hosts** allowance; radio is unchanged.
- **Ports other than 80 and 443.** Media hosted on another port, such as `https://media.example.com:8443/track.mp3`, is refused.
- **Formats that are not HTTP.** Sources that offer only RTMP, RTSP, MMS or similar streams are refused. HTTP(S), HLS and DASH work. The few HTTPS streams that yt-dlp can only download by handing them to ffmpeg are refused too.
- **yt-dlp configuration files.** Media downloads ignore yt-dlp configuration files and plugin folders on the host. On a native install, options you set in a yt-dlp config file no longer apply; cookies still come from **Settings → YouTube** or `YT_COOKIE_FILE`. A native install needs a yt-dlp at least as new as the version pinned in `.yt-dlp-version`; older releases lack options the backend now passes, and every download then fails.
- **Host-file overrides.** Media downloads resolve host names through DNS (`/etc/resolv.conf`), not `/etc/hosts`. Docker's DNS, systemd-resolved and Tailscale MagicDNS work as before.
- **Emergency switch.** If downloads break because of the proxy, `MEDIA_EGRESS_PROXY=off` restores direct connections while you report the problem. It is not a supported way to run: only YouTube links and searches are accepted while it is off, and the Runtime / media check (Settings → YouTube, Media Library → Library) reports it as a failure.

#### Downloads go into a separate cache folder

Songs downloaded from links (YouTube, other sites, Spotify and Apple Music matches) are now stored in an app-owned folder, `.ts6-media-cache`, inside the music folder (`MUSIC_DIR`). Each download is checked before it is kept: it must be the one item that was requested, and audio whose length `ffprobe` can read (and that matches the announced length, when the site gives one). Downloads that fail the check are not kept, and the request fails with a message. There is no schema change and no Compose change.

What changes, and what does not:

- **Existing songs, playlists and queues keep working.** Their files stay where they are and are played as before. Nothing in the music folder outside `.ts6-media-cache` is renamed, moved, overwritten or deleted by the upgrade, the cache or its clean-up.
- **Files from older downloads are not reused for new requests, and are not migrated.** They stay where they are and keep playing for the songs that use them. Asking again for something downloaded before 1.11.2 downloads it once more into the cache.

  **Disk space.** Each such repeat keeps two copies until you archive the old one yourself. The worst case is about as much extra space as all your existing downloads. On top of that, the cache grows with every new source played or downloaded, because nothing in it is removed automatically.
- **A link to a site other than YouTube is cached per exact link.** The same track pasted with a different link is downloaded separately.
- **ffprobe is required for new downloads.** It ships with ffmpeg in the Docker images. On a native install without `ffprobe` on the backend's `PATH`, new downloads fail with *New downloads need ffprobe, which was not found…*; songs already in the library keep playing. The Runtime / media check shows whether ffprobe is available.
- **A folder named `.ts6-media-cache` that TS6 Manager did not create** is left alone, and downloads fail with a message asking you to rename or move it. If the backend is stopped at the moment it creates the cache, an empty `.ts6-media-cache.<random>.tmp` folder can be left next to it; you can delete it.
- **The cache holds the files of songs downloaded from now on.** Library songs, playlists and queues point into it, so do not delete or move `.ts6-media-cache`. Tracks that are played without being added to the library are kept there too, and the Library's **Scan** does not list them.
- **The cache is not cleaned up automatically.** It grows with every new source played or downloaded; only leftovers of interrupted downloads are removed.
- **Removing a song keeps files that are still in use.** A song's file is deleted with it only when no other song on any server uses the same file and no bot has it queued. Files in the download cache are never deleted when a song is removed; they stay for other songs and requests that share them. Files outside the music folder are never deleted.
- **Rolling back** to 1.11.1 is safe: older versions ignore the cache folder.

**Back up before upgrading.** Stop the backend and copy both the database volume (`ts6webui.db` and any journal or WAL files) and the music folder.

- Docker (split stack and all-in-one): the `backend-data` and `music-data` volumes.
- Native install: the `data/` folder and `MUSIC_DIR`.

Keep the backup until you have checked the upgrade.

**Refreshing older downloads (optional, manual).** You do not need to do anything. If you want an older song re-downloaded and checked, the safe procedure is:

1. Make the backup above.
2. On the **Media Library → Library** page, download the song again from its original link. The page updates the existing entry in place to use the new, checked copy in the cache; do not remove it.
3. Check that the entry plays.
4. The old file stays in the music folder, now unused by that entry. Do not use **Remove** on the song to get rid of it: that removes the song. Before moving an old file away, make sure no other entry uses it; the same file can be shared by songs on several servers.
5. Files in the music folder that no song uses are never touched by TS6 Manager. You can move them to an archive folder yourself.

A tool that lists older downloads and refreshes them in bulk is planned for a later release.

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

Release images pin the exact yt-dlp version recorded in `.yt-dlp-version`. The backend reports that bundled version at startup but does not update it at runtime, so restarting the same image cannot silently change media-extractor behaviour. The same images pin Deno (`.deno-version`), which yt-dlp uses for YouTube EJS solvers by default, so operators do not need to install a JS runtime by hand. Media downloads run yt-dlp without configuration files (`--ignore-config`). Image Node stays at 20 for the Nest app and is not used as an EJS fallback.

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
