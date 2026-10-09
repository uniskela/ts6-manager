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
