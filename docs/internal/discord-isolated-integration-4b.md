# Discord isolated integration (Phase 2C Step 4B)

Maintainer runbook for preparing a supervised first Discord interaction test.
**Preparation only** — do not treat this document as authorisation to touch live Discord, tunnels, or production.

## 1. Application isolation decision

**Recommendation: B — dedicated Discord test application.**

Evidence in-repo:

| Source | Finding |
|--------|---------|
| `docs/internal/plans/discord-commands-media-proposal.md` | Intends a Uniskela command app (`applications.commands`) later; does **not** record that it already serves production Interactions. |
| `docs/public/discord-bridge.md` | Voice-bridge / D1 lab is a separate product lifecycle — **not interchangeable** with the command app. |
| Live Discord remote inventory | **Unverified** (no API access in 4B). |

Do **not** change the existing Uniskela command-app Interactions Endpoint URL or routing as part of this isolated test. Prefer a dedicated test application so production command routing stays untouched.

Use option **A** (existing command app) only after an operator confirms, offline, that its Interactions Endpoint URL is unused or safe to repoint without interrupting users, and that remote `/ts` ownership is understood.

Still required before live: confirm Interactions URL ownership on the **test** app; confirm remote guild command inventory (read-only GET, separately approved).

## 2. Configuration template

Copy [`.env.discord-integration-test.example`](../../.env.discord-integration-test.example) to a **gitignored** local file (`.env.discord-integration-test`). Never commit secrets. Placeholders only in the example file.

Readiness (no secret values):

```bash
cd packages/backend
node --import tsx src/discord-command/integration-readiness-cli.ts \
  --env-file ../../.env.discord-integration-test
```

Statuses: `PRESENT` / `MISSING` / `INVALID` / `DISABLED`. Keep `DISCORD_INTERACTIONS_ENABLED=false` during preparation. Missing application ID, public key, or role IDs cannot silently enable interactions (flag defaults off; HTTP router stays unmounted).

## 3. Isolated SQLite bootstrap

**Private disposable DB only.** Basename must be exactly `discord-int-test.db`. Substring markers, query-string tricks, `ts6webui.db`, and symlink aliases to production basenames are refused.

Default CLI execution is dry-run (identifies the resolved target, writes nothing):

```bash
cd packages/backend
node --import tsx src/discord-command/isolated-db-cli.ts \
  --database-url 'file:./data/discord-int-test.db'
# then, after verifying the printed resolvedPath:
node --import tsx src/discord-command/isolated-db-cli.ts \
  --database-url 'file:./data/discord-int-test.db' \
  --confirm-write
```

With `--confirm-write`, this runs `prisma db push` (no migration-history edits), `finalizePlaylistNameKeyMigration`, and seeds:

- `TsServerConfig` id=1 (lab label)
- `MusicBot` id=10 on that server (non-D1 test bot fixture ids — replace with real lab bot ids when binding live)
- Confirms `DiscordGuildBinding` table exists

## 4. Guild binding CLI

**Private test guild** → one **non-D1** TeamSpeak test music bot. Default is dry-run. Writes need `--confirm-write`. Target DB is printed (resolved path) before any mutation. Revoke also requires `--confirm-write`.

```bash
# Preview (no writes)
node --import tsx src/discord-command/guild-bind-cli.ts preview-bind \
  --database-url 'file:./data/discord-int-test.db' \
  --guild-id "$DISCORD_TEST_GUILD_ID" \
  --instance-id discord-int-test \
  --server-config-id 1 \
  --music-bot-id 10

# Bind (mutation)
node --import tsx src/discord-command/guild-bind-cli.ts bind \
  --database-url 'file:./data/discord-int-test.db' \
  --guild-id "$DISCORD_TEST_GUILD_ID" \
  --instance-id discord-int-test \
  --server-config-id 1 \
  --music-bot-id 10 \
  --confirm-write

# Status / revoke
node --import tsx src/discord-command/guild-bind-cli.ts status --database-url 'file:./data/discord-int-test.db' --guild-id "$DISCORD_TEST_GUILD_ID"
node --import tsx src/discord-command/guild-bind-cli.ts revoke --database-url 'file:./data/discord-int-test.db' --guild-id "$DISCORD_TEST_GUILD_ID" --confirm-write
```

Validates guild snowflake, server existence, and bot∈server before mutation. Invalid relationships are refused. No public HTTP binding API.

## 5. Initial registration set (offline)

**Do not register `/ts`** while production presence providers remain stubbed.

Initial names: `queue`, `play`, `stop`.

```bash
# Empty remote = SIMULATED "no guild commands" (NOT real Discord state)
node --import tsx src/discord-command/slash-register-cli.ts \
  --application-id "$DISCORD_APPLICATION_ID" \
  --guild-id "$DISCORD_TEST_GUILD_ID" \
  --remote src/discord-command/fixtures/remote-guild-empty.json \
  --names queue,play,stop

# SIMULATED unrelated + divergent /ts (fixture JSON, NOT live Discord)
node --import tsx src/discord-command/slash-register-cli.ts \
  --application-id "$DISCORD_APPLICATION_ID" \
  --guild-id "$DISCORD_TEST_GUILD_ID" \
  --remote src/discord-command/fixtures/remote-guild-unrelated.json \
  --names queue,play,stop
```

Fixture files are **simulated** remote inventories. They do not prove ownership of live guild commands. Real remote inventory requires a **separately approved** read-only Discord GET. Apply remains a later external write.

## 6. HTTPS test architecture + rollback (do not execute here)

Use a **temporary HTTPS** exposure of only `/api/discord/interactions` for the **test** application. Do not modify production reverse-proxy, Portainer, or existing Uniskela command-app routing.

| Step | Action | Kind |
|------|--------|------|
| 1 | Start isolated backend with test `.env` (`DISCORD_INTERACTIONS_ENABLED` still false until the supervised window) | Local |
| 2 | Temporary HTTPS only to `/api/discord/interactions` (tunnel/lab host) | External infra |
| 3 | Set **test** application Interactions Endpoint URL (not production command app) | Discord write |
| 4 | Enable interactions flag; restart | Local config |
| 5 | Register guild commands `queue,play,stop` with confirms | Discord write |
| 6 | Explicit bind: test guild → non-D1 test music bot | Local DB write |
| 7 | Verify `/queue`, auth failures, then one controlled `/play` + `/stop` | Discord + TS test bot |
| 8 | Revoke binding (`--confirm-write`) | Local DB write |
| 9 | Remove guild commands (Developer Portal or explicit DELETE — client does not DELETE) | Discord write |
| 10 | `DISCORD_INTERACTIONS_ENABLED=false`; clear test Interactions URL; tear down tunnel | Local + Discord + infra |

**Kill switch:** disable interactions flag and restart; revoke binding; clear test Interactions URL.

**Environment:** dedicated test Discord application, private test guild, isolated `discord-int-test.db`, non-D1 TeamSpeak lab bot.

## 7. Viewer-only Discord identity (findings #5 / #21)

Prepare a genuine viewer-only member before the next supervised live window:

1. In the INT-TEST guild, create (or reuse) a role with **no** administrator / Manage Guild powers.
2. Put that role snowflake only in `DISCORD_VIEWER_ROLE_IDS` (not in `DISCORD_ADMIN_ROLE_IDS`).
3. Assign it to a second Discord account used only for deny checks.
4. Confirm that account lacks every role listed in `DISCORD_ADMIN_ROLE_IDS`.
5. Live checks (after a new operator GO): `/ts status` and `/playlist create` must deny; admin account commands still succeed.

Do not fabricate deny observations. Do not broaden privileges just to green the matrix.

## 8. INT-TEST media fetcher (finding #20)

Radio playback requires the isolated media fetcher. There is no legacy/unrestricted ffmpeg fallback. Live #20 PASS requires audible playback with a healthy fetcher — an unavailable message alone is not acceptance.

Standalone compose (does not touch production fetcher stacks). Services use `restart: "no"` so the operator controls start/stop.

```bash
umask 077; openssl rand -hex 32 > .media-fetcher-token-int   # seed; gitignored
mkdir -p data/discord-int-media-jobs data/discord-int-media-ctl
# Optional override: MEDIA_FETCHER_SEED_TOKEN_FILE=./.media-fetcher-token-int
docker compose -f docker-compose.discord-int-media-fetcher.yml up --build
```

Keep seed and installed paths distinct even if backend env is exported into the shell:

| Variable | Role |
|----------|------|
| `MEDIA_FETCHER_SEED_TOKEN_FILE` | Compose install input (default `./.media-fetcher-token-int`) |
| `MEDIA_FETCHER_TOKEN_FILE` | Backend → installed `data/discord-int-media-jobs/.token` |
| `MEDIA_FETCHER_SOCK` | Backend → installed `data/discord-int-media-jobs/jobs.sock` |

Landlock, internal `discord_int_fetch` network, token mode 600, and fail-closed client behaviour match production fetcher policy. Do not fall back to in-process ffmpeg.

Tear down after the supervised window:

```bash
docker compose -f docker-compose.discord-int-media-fetcher.yml down
```

Do not modify production media-fetcher services.

## 9. External actions that still need explicit approval

1. Creating or selecting a Discord **test** application (leave existing Uniskela command-app routing alone).
2. Setting the test application's Interactions Endpoint URL.
3. Read-only fetch of remote guild commands.
4. Registering/updating guild slash commands (include `/playlist tracks` when refreshing guild commands after this fix).
5. Creating a public HTTPS tunnel / DNS.
6. Any TeamSpeak playback on a lab bot.
7. Pointing anything at production guilds, D1, or Portainer stacks.
8. Starting the INT-TEST media-fetcher compose alongside a live interactions window.
