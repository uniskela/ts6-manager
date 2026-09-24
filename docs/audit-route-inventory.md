# #91 Slice 4 — Administrative audit: remaining route inventory

This PR ships the audit **core** (schema, writer, retention, read API/UI) plus a
**representative** set of high-impact instruments. Routes below still need
instrumentation in follow-up PRs. Prefer the same patterns:

- **Remote TeamSpeak writes:** `beginRemoteAttempt` → dispatch → `completeRemoteAttempt`
  (fail-closed on attempt insert; `unknown` on timeout / ambiguous completion).
- **Local DB writes:** `recordLocalSuccess` inside `$transaction`.
- **DB + engine/pool:** success then `markPartial` on reload/pool failure.
- **Never** audit request bodies, free-text reasons/messages, flow JSON, credentials,
  cookie contents, token path values, or exception text.

## Instrumented in this PR

| Action | Route(s) |
|--------|----------|
| `client.kick` / `client.ban` | `POST .../clients/:clid/kick\|ban` |
| `ban.create` / `ban.delete` / `ban.delete_all` | `POST/DELETE .../bans` |
| `connection.create` / `update` / `credentials_changed` / `delete` | `POST/PUT/DELETE /api/servers` |
| `flow.create` / `update` / `delete` / `enable` / `disable` | `/api/bots` mutations |
| `user.create` / `update` / `delete` | `/api/users` mutations |
| `settings.yt_cookies_*` / `settings.limits_update` | `/api/settings` mutations |

## Remaining (not in this PR)

### Moderation / clients

- `POST .../clients/:clid/move`
- `POST .../clients/:clid/poke`
- `POST .../clients/:clid/message` (omit message body)
- `PUT/DELETE .../clients/:cldbid/permissions`
- `POST/DELETE .../complaints...`

### Virtual server / instance

- `PUT .../vs/:sid` (`serveredit`)
- `POST .../virtual-servers` (`servercreate`)
- `POST .../:sid/start\|stop`
- `DELETE .../:sid`
- `POST .../:sid/snapshot` / `snapshot/deploy` (no snapshot body)
- `PUT .../instance` (`instanceedit`)

### Channels / groups / permissions / tokens

- Channel CRUD / move / channel permissions
- Server group CRUD / copy / members / permissions
- Channel group CRUD / assign / permissions
- Privilege key create/delete (**never store token string from URL/body**)

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
