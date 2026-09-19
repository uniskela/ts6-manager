# Server management

TS6 Manager provides browser-based administration for TeamSpeak servers through WebQuery HTTP, with optional authenticated SSH Query for features that need it.

## Dashboard

The dashboard shows server status and operational information such as:

- online users;
- channel count;
- uptime;
- ping;
- bandwidth history; and
- server capacity.

## Virtual servers and channels

Administrators can:

- list virtual servers and start or stop them where supported;
- browse and reorder channels;
- create, edit, and delete channels;
- move connected clients; and
- use server and channel groups.

## Clients, permissions, and moderation

Management tools include:

- client list;
- kick, ban, move, and poke actions;
- server-group and channel-group management;
- permission editing at server, channel, client, and group scope;
- ban management;
- privilege tokens;
- complaints; and
- offline messages.

## Files and logs

Authenticated SSH Query is used for features that require file-transfer or event access.

The UI includes:

- channel file browsing with upload/download;
- server logs with filtering; and
- instance-level settings.

## Widgets

Public server widgets can expose selected server status without application login using a dedicated widget token.

Available output includes live HTML, SVG, and PNG. Widget configuration can control whether channel and client information is shown.

Treat widget tokens as public-access capabilities and expose only the information you intend to publish.

## Access control

The application has administrator and viewer roles plus per-server access control. Sensitive configuration, automation, and server-management operations remain administrator-only.

See [Security](security.md) for the controls around stored credentials, outbound requests, WebSockets, and automation.
