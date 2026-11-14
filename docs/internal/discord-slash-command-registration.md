# Discord slash-command registration (Phase 2C Step 3B.2)

Maintainer notes for guild-scoped slash registration. Not a public runbook.

## Concepts

| Value | Meaning |
|-------|---------|
| Application ID | Discord application snowflake (`DISCORD_APPLICATION_ID`). Identifies the app that owns commands and receives interactions. |
| Guild ID | Discord server snowflake. Guild commands exist only in that server (not DMs). |
| Bot token | `DISCORD_BOT_TOKEN`. Used as `Authorization: Bot <token>` for the Applications Commands HTTP API. Never commit or log this value. |
| Public key | `DISCORD_PUBLIC_KEY`. Ed25519 verify key for the interactions HTTP endpoint — not used for registration. |

Registration uses Discord API v10:

`POST/GET /applications/{applicationId}/guilds/{guildId}/commands`

This step **never** calls the global commands endpoint. Guild scope comes from that path — not from global-only body fields.

## Guild payload schema

- Omit deprecated `dm_permission` from guild command bodies (it was for globally-scoped commands).
- Do **not** add `contexts` / `integration_types` on guild registration payloads (installation/interaction context fields for global commands).
- Send `type`, `name`, `description`, `default_member_permissions`, and `options` only.
- `default_member_permissions: null` only affects Discord UI visibility — backend auth (guild binding, TS6 roles, media permissions) remains mandatory. Admin-only handlers stay protected even if a command is visible.

## Same-name overwrite protection

Discord `POST …/guilds/{guildId}/commands` upserts **by name**. An existing same-name command may belong to another TS6 feature (or another operator’s registration) and must **not** be overwritten without explicit operator approval.

| Situation | Behaviour |
|-----------|-----------|
| Same name + equivalent schema | unchanged — no write |
| Same name + changed schema | update — requires `confirmSameNameOverwrite: true` |
| Same name + different command type | collision — refuse; no overwrite |
| Remote-only unknown names | preserved — never DELETE |
| Empty apply `names` list | no writes |
| Dry run | GET only — no POST |
| Apply | recomputes plan; `fromPlan` must match applicationId + guildId |

The client never bulk-overwrites (`PUT` all) and never deletes.

## Installation scope

The Discord application must be installed in the target guild with permission to manage application commands (bot installed in the guild, or an OAuth2 token with `applications.commands`). Prefer the bot token already used for the TS6 Discord integration once live apply is approved.

Registration never creates guild bindings automatically.

## Supported commands

Definitions live in `packages/backend/src/discord-command/slash-commands.ts` and are derived from the Discord adapter + music service only (`/ts …`, `/play`, `/queue`, `/nowplaying`, `/pause`, `/resume`, `/skip`, `/stop`, `/volume`, `/playlist …`, `/radio …`).

## Offline preview (dry run)

From `packages/backend`:

```bash
node --import tsx src/discord-command/slash-register-cli.ts \
  --application-id "$DISCORD_APPLICATION_ID" \
  --guild-id "$GUILD_ID"
```

Optional comparison against a saved remote list (no network):

```bash
node --import tsx src/discord-command/slash-register-cli.ts \
  --application-id "$DISCORD_APPLICATION_ID" \
  --guild-id "$GUILD_ID" \
  --remote ./remote-guild-commands.json
```

Dry-run reports create / update / unchanged / collisions / unrelated. Unrelated remote commands are preserved (never deleted).

## Later live apply (not enabled here)

1. Preview dry-run against the test guild.
2. Confirm application ID and guild ID are the **test** targets (not production).
3. Call `createSlashRegistrationClient(…).apply(guildId, { names: […], confirmApply: true, confirmSameNameOverwrite: true })` when updating existing same-name commands.
4. Pass `fromPlan` from the preview when locking identity between plan and apply.
5. Keep `DISCORD_INTERACTIONS_ENABLED` off until interactions + follow-up + bindings are ready for that environment.

## Avoiding production changes

- Do not set production guild IDs in local apply experiments.
- Do not use bulk overwrite (`PUT` all commands) — this client does not implement it.
- Do not register at backend startup; registration is operator-invoked only.

## Production application checklist (dry-run only until authorised)

Use a **dedicated** Discord application for production Commands & Radio. Do not reuse the INT-TEST app.

1. Create the application in the Discord developer portal (or reuse an approved production app).
2. Set the Interactions Endpoint URL only after TLS is ready; keep `DISCORD_INTERACTIONS_ENABLED` off until dual-latch checks pass.
3. Install the bot in the target guild with `applications.commands`.
4. Dry-run guild registration (never global):

```bash
node --import tsx src/discord-command/slash-register-cli.ts \
  --application-id "$DISCORD_APPLICATION_ID" \
  --guild-id "$GUILD_ID" \
  --fetch-remote
```

5. Compare create/update/unchanged/collisions. Resolve collisions before any apply.
6. Guild bind with the **production** CLI only:

```bash
# Preview prints the canonical realpath. --operator is attribution, not auth.
node --import tsx src/discord-command/prod-guild-bind-cli.ts preview-bind \
  --database-url "file:/absolute/path/to/data/ts6webui.db" \
  --operator "$OPERATOR_ID" \
  --application-id "$DISCORD_APPLICATION_ID" \
  --guild-id "$GUILD_ID" \
  --instance-id "$INSTANCE_ID" \
  --server-config-id "$SERVER_ID" \
  --music-bot-id "$BOT_ID"

# Write: existing ts6webui.db + exact realpath confirm + audit log (preflighted).
node --import tsx src/discord-command/prod-guild-bind-cli.ts bind \
  --database-url "file:/absolute/path/to/data/ts6webui.db" \
  --confirm-database-realpath "/absolute/path/to/data/ts6webui.db" \
  --audit-log "/absolute/path/to/guild-bind-audit.jsonl" \
  --operator "$OPERATOR_ID" \
  --application-id "$DISCORD_APPLICATION_ID" \
  --guild-id "$GUILD_ID" \
  --instance-id "$INSTANCE_ID" \
  --server-config-id "$SERVER_ID" \
  --music-bot-id "$BOT_ID" \
  --confirm-write
```

### Production guild-bind trust model

- `--operator` is **self-declared attribution** for the audit trail. It does not authenticate the caller.
- Authorisation is **OS/container filesystem permission** to read/write the confirmed database realpath (and to append the audit log). Only identities that already administer the TS6 data volume should be able to run this CLI against production.
- Basename `ts6webui.db` alone is insufficient: the file must **already exist** as a regular file, and writes require `--confirm-database-realpath` equal to `fs.realpathSync` of that file (blocks same-basename accidents in another directory / symlink tricks to a non-allowlisted realpath).
- `--audit-log` is required for writes. The CLI preflights appendability **before** the DB mutation. If the post-mutation audit append fails, the CLI exits non-zero, prints `AUDIT_APPEND_FAILED`, and reprints the audit record for manual reconciliation (revoke if needed). The DB change is not silently rolled back.
- There is no `--allow-any-database` on this path.

7. Enable interactions only with an explicit operator change to env + restart. Disable by clearing `DISCORD_INTERACTIONS_ENABLED` (or setting it false) and restarting.

**Hard rules:** no global slash registration; no apply without preview; no `--allow-any-database` on the production guild-bind path; `/ts bridge` stays honest-unavailable without a D1 worker/status source.

## Known product limitations (announce honestly)

- Discord users do not have TeamSpeak identities — media-group rules that expect a TS uid will not treat Discord as “everyone”.
- Full-source radio EOF drain is unit-tested and sustained playback was accepted in INT; natural end-of-stream live proof is still a known limitation.
- `/ts bridge` without a bridge worker reports unavailable (by design on Path A).
