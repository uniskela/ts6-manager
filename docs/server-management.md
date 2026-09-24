# Server management

TS6 Manager provides browser-based administration for TeamSpeak servers through WebQuery HTTP, with optional authenticated SSH Query for features that need it.

## Dashboard

The selected virtual server appears in the page header with its Online state and live-refresh status. The page groups operational information into **Server Status**, **Traffic**, and **Runtime & Capacity**, including:

- online users;
- channel count;
- uptime;
- ping;
- bandwidth history; and
- server capacity.

![Dashboard with populated server telemetry](dashboard.png)

## Virtual servers and channels

Administrators can:

- list virtual servers and start or stop them where supported;
- browse and reorder channels with drag-and-drop or the touch/keyboard move control;
- create, edit, and delete channels;
- move connected clients; and
- use server and channel groups.

Human and bot counts exclude ServerQuery sessions by default. Administrators can persistently enable **Show Query clients** when diagnostics require them.

## Clients, permissions, and moderation

Management tools include:

- client list;
- kick, ban, move, and poke actions, with deliberate confirmation for destructive actions and success only after the server accepts a request;
- server-group and channel-group management;
- permission editing at server, channel, client, and group scope;
- ban management;
- privilege tokens;
- complaints; and
- offline messages.

Permission edits remain a single-entity workflow. Drafts are isolated by connection, virtual server, permission layer, and entity, and navigation warns before discarding them. **Set only** includes assigned permissions and staged changes. Labels can use the readable Simple mode or raw Technical names.

Compare is read-only: select two to four entities from one permission layer, then use **Set on any**, **Differences only**, or search to inspect raw values, unset states, Skip, and Negate flags. Compare never writes permissions.

![Read-only Permissions Compare](permissions-compare.png)

## Appearance and responsive navigation

Settings → Appearance offers Light, Dark, and Black base themes with Cyan, Violet, Red, Blue, Emerald, and Amber accents. The choice is stored in the current browser.

The same page also has background presets (None, Grid, Dots, Glow, Aurora, and Noise), motion (System, Off, or On), and background intensity (Subtle, Normal, or Strong). System motion follows the browser `prefers-reduced-motion` setting. Intensity is hidden when the background is None. These settings stay in the current browser, and the default look is unchanged: Grid matches the background that previously shipped.

Sidebar sections remember their expanded state, while the mobile menu, dialogs, tables, and editor remain contained on narrow screens.

For installation, safe-area behavior, updates, and offline limits, see [Install TS6 Manager as an app](pwa.md).

## Files and logs

Authenticated SSH Query is used for features that require file-transfer or event access.

The UI includes:

- channel file browsing with upload/download;
- server logs with filtering; and
- instance-level settings.

## Widgets

Public server widgets can expose selected server status without application login using a dedicated widget token.

Available output includes live HTML, SVG, and PNG. Widget configuration can control whether channel and client information is shown. Footers brand as **ts6-manager** and link to the public GitHub repository. The HTML/iframe embed link is always clickable; the SVG footer link works when the SVG is opened as a document (for example via the direct `.svg` URL), but not when the file is embedded as an `<img>`.

Treat widget tokens as public-access capabilities and expose only the information you intend to publish.

## Access control

The application has administrator and viewer roles plus per-server access control. Sensitive configuration, automation, and server-management operations remain administrator-only.

See [Security](security.md) for the controls around stored credentials, outbound requests, WebSockets, and automation.
