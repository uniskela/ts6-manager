# Upgrading

TS6 Manager is designed so normal container upgrades retain the application database and encrypted TeamSpeak credentials.

## Before upgrading

Preserve:

- the persistent backend database volume;
- the current `ENCRYPTION_KEY`;
- `JWT_SECRET` and `SIDECAR_SECRET`;
- any media/library volume you want to retain; and
- any yt-dlp cookie file you mounted externally.

Changing `ENCRYPTION_KEY` prevents the backend from decrypting previously stored API keys and SSH passwords.

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

Release images pin the exact yt-dlp version recorded in `.yt-dlp-version`. The backend reports that bundled version at startup but does not update it at runtime, so restarting the same image cannot silently change media-extractor behaviour.

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
