# Discord Commands & Radio

Self-hosted Discord **slash commands** that drive TS6 Manager TeamSpeak status and music/radio bots. This is an advanced operator feature: you create and host your own Discord application, expose a verified HTTPS interactions endpoint, bind one Discord guild to one manager instance and music bot, then register guild-scoped commands.

> **Status.** The implementation lives on draft PR work and is **not** a published stable product promise. Treat this guide as operator documentation for that draft capability. Keep `DISCORD_INTERACTIONS_ENABLED` off until every step below is complete.

This page is **not** the Discord ↔ TeamSpeak voice bridge. Voice bridging (D1–D6) is separate laboratory work and remains unreleased — see [Discord bridge](discord-bridge.md).

## What this is

- Guild-only Discord slash commands for TeamSpeak overview (`/ts …`) and media control (`/play`, `/queue`, `/radio`, …).
- Per-guild binding in the TS6 database: Discord guild → manager `DISCORD_INSTANCE_ID` → TeamSpeak server config → music bot.
- Role gates via `DISCORD_VIEWER_ROLE_IDS` / `DISCORD_ADMIN_ROLE_IDS` (Discord role snowflakes). Discord **Administrator** does **not** automatically grant TS6 admin powers in production.
- HTTP Interactions at `POST /api/discord/interactions` with Ed25519 signature verification (`DISCORD_PUBLIC_KEY`).
- Operator-driven guild command registration (never at backend startup; never global registration).

## What this is not

- One-click “Connect Discord” onboarding in the web UI.
- A shared hosted Uniskela command hub (you run your own Discord application).
- Discord ↔ TeamSpeak **voice** bridging, or Discord users appearing as TeamSpeak voice clients.
- Automatic elevation of Discord guild admins to TS6 administrators.

Radio from Discord still needs the [isolated radio fetcher](radio-fetcher.md), same as TeamSpeak `!radio`.

## Prerequisites

- A working TS6 Manager install ([Installation](installation.md)): split stack (`backend` / `frontend` / `sidecar`) or [all-in-one](installation.md#all-in-one).
- A reachable public **HTTPS** origin that already fronts the manager UI/API ([Reverse proxy](reverse-proxy.md)).
- At least one configured TeamSpeak server and music bot in the manager UI.
- For `/radio`: media-fetcher overlay enabled ([Radio fetcher](radio-fetcher.md)).

## Security model (short)

| Control | Behaviour |
|--------|-----------|
| Signatures | Discord signs each interaction; the backend verifies with `DISCORD_PUBLIC_KEY` before any command runs. |
| Roles | Commands require configured Discord role IDs. Empty role lists fail closed. |
| Guild binding | Unbound guilds are refused even with a valid signature. |
| Rate limits | Separate unauthenticated vs authenticated budgets after verification; edge limiting is still recommended. |
| Registration | Guild path only; no global commands; no bulk overwrite; same-name updates need explicit confirmation in the library API. |
| Secrets | `DISCORD_BOT_TOKEN` is secret. Prefer not to put it in long-lived process env if you only need it for registration — inject for the CLI run. |

## Setup walkthrough

Placeholder values below (`YOUR_*`) are examples. Never commit real tokens, snowflakes, or production URLs.

### 1. Create a dedicated Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application used **only** for this manager (do not reuse lab/INT apps on production).
2. Note the **Application ID**.
3. Under **General Information**, copy the **Public Key** (Ed25519 hex used to verify interactions).
4. Under **Bot**, create a bot user and copy the **Bot token** once. Store it like any other secret.

### 2. Invite the application into one guild

Install the app into the target Discord server with permission to use application commands. Prefer the portal’s OAuth2 URL Generator with scopes:

- `applications.commands`
- `bot` (required for the Bot token registration API)

Avoid privileged intents you do not need. Slash command handling for this feature does not require Message Content Intent.

### 3. Configure TS6 Manager environment

Set on the **backend** (split stack: `backend` service; all-in-one: `ts6` service). Restart after changes.

| Variable | Role |
|----------|------|
| `DISCORD_APPLICATION_ID` | Application snowflake (runtime + registration identity). |
| `DISCORD_PUBLIC_KEY` | Ed25519 public key hex (runtime verification). |
| `DISCORD_INSTANCE_ID` | Must match the guild binding’s instance id (default `local`). |
| `DISCORD_VIEWER_ROLE_IDS` | Comma-separated Discord role IDs allowed to run viewer commands. |
| `DISCORD_ADMIN_ROLE_IDS` | Comma-separated Discord role IDs allowed to run admin commands. |
| `DISCORD_BOT_TOKEN` | Bot token — needed for Discord **API** registration calls; not required for verifying inbound interactions. |
| `DISCORD_INTERACTIONS_ENABLED` | Keep `false` until binding, HTTPS, and registration are ready. |
| `LISTEN_HOST` | Optional bind address; leave unset in normal Docker images. |

Full descriptions: [Environment variables](environment-variables.md#discord-commands--radio). Also configure [TRUST_PROXY](environment-variables.md) correctly behind your reverse proxy so rate limits see real client addresses where intended.

### 4. Expose the interactions endpoint over HTTPS

Discord must reach:

`POST https://YOUR_PUBLIC_HOST/api/discord/interactions`

On the published images, `/api` is already proxied to the backend by the frontend/all-in-one nginx. Terminate TLS at your outer reverse proxy and forward to the published UI port (typically frontend `:3000` or all-in-one `:80`). Do **not** publish the backend API port to the internet just for Discord.

Leave the Discord **Interactions Endpoint URL** empty until `DISCORD_INTERACTIONS_ENABLED=true` and the backend has been restarted with a valid `DISCORD_PUBLIC_KEY`. When the feature is disabled, the manager does not mount the interactions route, so Discord’s URL verification PING would fail.

Details: [HTTPS for Discord interactions](#https-for-discord-interactions).

### 5. Bind the Discord guild to a music bot

Production writes use `prod-guild-bind-cli` against an **existing** `ts6webui.db` only. Working directory inside images is `/app/packages/backend`.

**Split stack** (service `backend`, container often `ts6-backend`):

```bash
# Preview (no write). --operator is audit attribution, not authentication.
docker compose exec backend node dist/discord-command/prod-guild-bind-cli.js preview-bind \
  --database-url "file:/app/packages/backend/data/ts6webui.db" \
  --operator "YOUR_OPERATOR_LABEL" \
  --application-id "YOUR_APPLICATION_ID" \
  --guild-id "YOUR_GUILD_ID" \
  --instance-id "YOUR_INSTANCE_ID" \
  --server-config-id YOUR_SERVER_CONFIG_ID \
  --music-bot-id YOUR_MUSIC_BOT_ID
```

Copy the printed **canonical database realpath**, then write:

```bash
docker compose exec backend node dist/discord-command/prod-guild-bind-cli.js bind \
  --database-url "file:/app/packages/backend/data/ts6webui.db" \
  --confirm-database-realpath "/app/packages/backend/data/ts6webui.db" \
  --audit-log "/app/packages/backend/data/discord-guild-bind-audit.jsonl" \
  --operator "YOUR_OPERATOR_LABEL" \
  --application-id "YOUR_APPLICATION_ID" \
  --guild-id "YOUR_GUILD_ID" \
  --instance-id "YOUR_INSTANCE_ID" \
  --server-config-id YOUR_SERVER_CONFIG_ID \
  --music-bot-id YOUR_MUSIC_BOT_ID \
  --confirm-write
```

**All-in-one** (service `ts6`, container `ts6-all-in-one`): same commands with `docker compose -f docker-compose.all-in-one.yml exec ts6 …` and the same in-container DB path.

Notes:

- `--operator` is self-declared for the audit log. Authorisation is filesystem access to the DB volume.
- Writes require `--confirm-write`, `--confirm-database-realpath` equal to `realpath` of that file, and `--audit-log` (append-only JSONL, preflighted before mutation).
- There is no `--allow-any-database` on this production path.
- Status / revoke: `status` and `revoke` subcommands on the same CLI (revoke also needs the write confirms).

Do **not** use `guild-bind-cli.js` against production `ts6webui.db` — that CLI targets disposable integration databases unless `--allow-any-database` is forced (lab only).

### 6. Preview guild slash-command registration

Registration is **guild-scoped** only (`/applications/{application.id}/guilds/{guild.id}/commands`). The preview CLI never registers globally and never deletes unrelated remote commands.

```bash
# Offline plan (no Discord HTTP)
docker compose exec backend node dist/discord-command/slash-register-cli.js \
  --application-id "YOUR_APPLICATION_ID" \
  --guild-id "YOUR_GUILD_ID"

# Compare against live guild commands (reads Discord API; needs DISCORD_BOT_TOKEN in the container env)
docker compose exec -e DISCORD_BOT_TOKEN backend node dist/discord-command/slash-register-cli.js \
  --application-id "YOUR_APPLICATION_ID" \
  --guild-id "YOUR_GUILD_ID" \
  --fetch-remote
```

Inspect create / update / unchanged / collisions. Resolve collisions before any apply. Empty name lists mean no writes.

### 7. Apply registration (current capability gap)

The library supports an explicit `apply` with `confirmApply` and `confirmSameNameOverwrite` for same-name schema updates. The published **`slash-register-cli` is dry-run only** — it does **not** perform live apply.

Until a production apply subcommand ships, treat live registration as an **operator gap**: do not invent ad-hoc scripts in production docs, and do not use global or bulk-PUT registration from the Discord portal in a way that bypasses collision checks. Prefer waiting for a reviewed apply CLI, or perform apply only through a maintained internal procedure that calls the same library guards.

Protections that must remain true whenever apply is used:

- No global registration.
- No bulk overwrite of the entire guild command set.
- No DELETE of unrelated remote commands.
- Same-name updates require explicit overwrite confirmation.

### 8. Enable interactions

1. Confirm public HTTPS already reaches `/api` on the manager.
2. Set `DISCORD_INTERACTIONS_ENABLED=true` on the backend / all-in-one service (public key and application id must already be set).
3. Restart the service.
4. In the Discord portal, set **Interactions Endpoint URL** to `https://YOUR_PUBLIC_HOST/api/discord/interactions` and save (Discord sends a signed PING).
5. In Discord, run `/ts help` and a harmless read-only command such as `/ts online` (requires a viewer role).

If enablement fails closed (missing/invalid public key), the endpoint refuses traffic rather than accepting unsigned bodies.

### 9. Disable or revoke safely

1. Set `DISCORD_INTERACTIONS_ENABLED=false` (or unset) and restart — inbound interactions stop being served as an enabled feature.
2. Optionally clear the Interactions Endpoint URL in the Discord portal.
3. Revoke the guild binding with `prod-guild-bind-cli.js revoke` (same realpath + audit + `--confirm-write` requirements).
4. Rotate or delete the bot token if the integration is retired.
5. Remove the bot from the guild if it should no longer appear there.

## HTTPS for Discord interactions

Discord requires a publicly reachable HTTPS endpoint. Recommended shape:

1. Outer reverse proxy terminates TLS for `YOUR_PUBLIC_HOST`.
2. Proxy `/` (and `/api`, `/ws` as already documented) to the **frontend** or **all-in-one** published port — not to a raw backend publish on the internet.
3. Bundled nginx already forwards `/api` to the backend, so `/api/discord/interactions` reaches Node without a special Discord-only location.
4. Set `TRUST_PROXY` so the backend trusts your reverse proxy hop(s); see [Reverse proxy — Listener remote and client IP limits](reverse-proxy.md#listener-remote-and-client-ip-limits). Discord interaction rate limits use the same client-address helpers.
5. Prefer edge request limiting / WAF rules on `POST /api/discord/interactions` in addition to in-app budgets.

Lab-only path filters used during isolated staging are **not** part of the published deployment and must not be relied on.

Example outer NGINX fragment (TLS termination assumed elsewhere or on this server):

~~~nginx
# Forward the public site to the published frontend / all-in-one port.
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
~~~

Keep WebSocket upgrade configuration for `/ws` as in [Reverse proxy](reverse-proxy.md). No extra Discord-specific path is required beyond ordinary `/api` proxying.

## Production CLI reference

All commands below assume the image working directory `/app/packages/backend` (true for `ghcr.io/uniskela/ts6-manager/backend` and the backend tree inside all-in-one).

| Artifact | Discord API? | DB? | Purpose |
|----------|--------------|-----|---------|
| `dist/discord-command/slash-register-cli.js` | Only with `--fetch-remote` | No | Dry-run registration plan |
| `dist/discord-command/prod-guild-bind-cli.js` | No | Yes (`ts6webui.db`) | Preview / bind / revoke / status with audit |
| `dist/discord-command/guild-bind-cli.js` | No | Isolated INT DBs | Lab/disposable bindings only |
| `dist/discord-command/integration-readiness-cli.js` | No | No | Config readiness checklist (lab/dev) |

Compose service names:

| Layout | Service | Typical container name |
|--------|---------|------------------------|
| Split (`docker-compose.yml`) | `backend` | `ts6-backend` |
| All-in-one (`docker-compose.all-in-one.yml`) | `ts6` | `ts6-all-in-one` |

Database URL in published compose files: `file:/app/packages/backend/data/ts6webui.db`.

## Known limitations

- Replay protection for interaction ids is **in-process** (not shared across replicas).
- Large HTTP floods still need **edge** protection.
- `/ts bridge` reports unavailable without a released voice-bridge worker (by design while Path A Commands & Radio ships without D1).
- Discord users are not TeamSpeak identities; media-group rules that key on TS uids will not treat Discord callers as channel members.
- Live slash **apply** is not exposed by the published CLI yet (see above).

## Related docs

- [Environment variables](environment-variables.md#discord-commands--radio)
- [Radio fetcher](radio-fetcher.md)
- [Reverse proxy](reverse-proxy.md)
- [Discord bridge](discord-bridge.md) (voice lab status — not this feature)
- [Media bots](music-bots.md)
