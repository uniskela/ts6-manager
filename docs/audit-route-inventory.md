# #91 Slice 4 — Administrative audit: remaining route inventory

Prefer the same patterns:

- **Remote TeamSpeak writes:** `beginRemoteAttempt` → dispatch → `completeRemoteAttempt`
  (fail-closed on attempt insert; `unknown` on timeout / ambiguous completion).
- **Local DB writes:** `recordLocalSuccess` inside `$transaction`.
- **DB + engine/pool:** success then `markPartial` on reload/pool failure.
- **Never** audit request bodies, free-text reasons/messages, flow JSON, credentials,
  cookie contents, token path values, or exception text.

## Instrumented (core + channel/group/permission follow-up)

| Action | Route(s) |
|--------|----------|
| `client.kick` / `client.ban` | `POST .../clients/:clid/kick\|ban` |
| `client.move` / `client.poke` / `client.message` | `POST .../clients/:clid/move\|poke\|message` (omit msg / cpw) |
| `client.permission_add` / `client.permission_delete` | `PUT/DELETE .../clients/:cldbid/permissions` |
| `ban.create` / `ban.delete` / `ban.delete_all` | `POST/DELETE .../bans` |
| `channel.create` / `update` / `delete` / `move` / permission add\|delete | `.../channels` |
| `server_group.*` (CRUD, copy, members, permissions) | `.../server-groups` |
| `channel_group.*` (CRUD, assign, permissions) | `.../channel-groups` |
| `privilege_key.create` / `privilege_key.delete` | `.../tokens` (**never** store token string) |
| `virtual_server.edit` / `start` / `stop` | `PUT .../vs/:sid`, `POST .../:sid/start\|stop` |
| `connection.create` / `update` / `credentials_changed` / `delete` | `POST/PUT/DELETE /api/servers` |
| `flow.create` / `update` / `delete` / `enable` / `disable` | `/api/bots` mutations |
| `user.create` / `update` / `delete` | `/api/users` mutations |
| `settings.yt_cookies_*` / `settings.limits_update` | `/api/settings` mutations |

## Remaining (not yet instrumented)

### Moderation / clients

- `POST/DELETE .../complaints...`

### Virtual server / instance

- `POST .../virtual-servers` (`servercreate`)
- `DELETE .../:sid`
- `POST .../:sid/snapshot` / `snapshot/deploy` (no snapshot body)
- `PUT .../instance` (`instanceedit`)

### Connections (lower priority)

- `POST /api/servers/demo`
- Draft/persisted WebQuery & SSH tests (`test-webquery`, `test-ssh`, `/:id/test`) — audit “tested” fact only, never credentials

### Settings / auth

- `PUT /api/auth/password` (self password change — fact only)
- `POST /api/setup/init` (bootstrap — special case)

### Media / automation / content (after core coverage)

- Music bot CRUD + start/stop/play/queue/stream
- Playlist / music library / radio / chat-command / IPTV / widget mutations
- Messages / files mkdir/delete

### Explicitly out of scope for admin audit

- Auth login/refresh/logout (session lifecycle)
- Bot webhook triggers
- Public widget routes
- Read-only routes (`logs`, `dashboard`, `permissions` list, music-requests GET)
