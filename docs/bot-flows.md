# Bot flows reference

This document describes the **bot flow engine** in TS6 Manager: triggers, conditions, actions, and common patterns. Adapted from [uniplayer1/ts6-manager](https://github.com/uniplayer1/ts6-manager) (MIT), trimmed for this core-focused fork (no Discord bridge triggers).

## Overview

Bot flows are visual workflows stored per TeamSpeak server connection. Each flow has:

- **Triggers** — what starts execution (TS3 events, cron, webhooks, chat commands)
- **Conditions** — optional gates (time windows, client properties, channel checks)
- **Actions** — what the bot does (messages, moves, group changes, HTTP calls, nested flows)

Flows run on the backend **bot engine**, which maintains ServerQuery/WebQuery connections and executes nodes in order.

## Triggers

| Trigger | Description |
|---------|-------------|
| TS3 event | Fires on server notifications (client connect/disconnect, channel edit, text message, etc.) |
| Cron | Scheduled execution (cron expression) |
| Webhook | HTTP POST to `/api/bots/webhook/:token` (token is flow-specific) |
| Chat command | Text message matching a prefix (e.g. `!help`) |

Chat commands support `command_args_list` — split arguments passed to downstream action nodes.

## Conditions

Common condition nodes:

- **Time range** — only run during configured hours/days
- **Client online time** — minimum seconds connected
- **Channel match** — client in specific channel(s)
- **Server group** — client has / lacks group membership
- **String match** — compare event fields or variables

Conditions that fail skip the connected action branch (depending on edge wiring).

## Actions

| Action | Description |
|--------|-------------|
| Send message | Channel or private text (supports templates) |
| Move client | Move to channel by ID or name |
| Group add/remove | Server group membership |
| Kick / ban | With optional reason and duration |
| Set channel variable | Flow-scoped or server-persisted variables |
| HTTP request | Outbound webhook (SSRF-validated URLs) |
| Run sub-flow | Invoke another flow by ID |
| AFK mover | Move idle clients after timeout (exempt channel IDs supported) |
| Temp channel | Create/delete temporary channels from templates |

## Variables and templates

- **`{{event.field}}`** — fields from the triggering TS3 event
- **`{{flow.varName}}`** — variables set by earlier nodes in the same run
- **`{{client.nickname}}`**, **`{{channel.name}}`** — common shortcuts where supported

## Security notes

- Bot flow **GET** routes (listing flows, reading `flowData`, webhook tokens) require **admin** role.
- Webhook endpoints use unguessable tokens; treat leaked tokens like passwords.
- WebSocket live updates are scoped to servers the authenticated user may access.

## Example patterns

### Welcome message

1. Trigger: `cliententerview`
2. Condition: client not a query connection
3. Action: private message with server rules link

### AFK mover

1. Trigger: cron every 60s (or TS3 idle event if available)
2. Condition: client idle time > threshold; channel not in exempt list
3. Action: move to AFK channel

### Temporary channel

1. Trigger: client enters "lobby" channel
2. Action: create temp channel from template, move client, register cleanup on empty

### Chat command bot

1. Trigger: chat command `!rules`
2. Action: channel message with rules text

## Music bots (separate subsystem)

Music bots use the **voice bot** stack (TS3 voice protocol, not ServerQuery flows). Users control playback via:

- Web UI (Music Bots page)
- In-channel text commands (`!play`, `!skip`, `!vol`, etc.)

See the Music Bots section in the main README for queue, YouTube, radio, and video streaming.

## Further reading

- [README.md](../README.md) — feature overview and deployment
- [CREDITS.md](../CREDITS.md) — upstream and fork attribution
- [docs/plans/opinionated-fork-roadmap.md](plans/opinionated-fork-roadmap.md) — fork scope
