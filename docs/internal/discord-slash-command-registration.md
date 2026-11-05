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
