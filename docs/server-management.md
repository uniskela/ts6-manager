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
- **Server Logs 2.0** (admin-only): bounded TeamSpeak `logview` pages with Previous/Older cursor paging, Refresh back to the newest page, connection / virtual-server / instance scope labels, page-local search and level filters, and source timestamps with a single page-level note that TeamSpeak does not report timezone (no per-row “timezone unknown”); and
- instance-level settings.

Log filters never silently fetch the entire history. Instance logfile mode is labeled separately from the selected virtual server so instance-wide rows are not attributed to that VS. If TeamSpeak returns logfile I/O error 2052, the UI shows **TeamSpeak log file unavailable** with a single manual Retry (see [troubleshooting](troubleshooting.md#server-logs-teamspeak-log-file-unavailable--error-2052)).

## Activity journal and administrative audit

Admin-only **Activity Journal** records opt-in TeamSpeak join/leave history for the selected connection and virtual server (column headers: date/time, event, user, type, identity). History auto-refreshes while capture is running on the newest page.

**Administrative Audit** lists Manager-initiated admin mutations (not TeamSpeak client activity). Rows show date/time, action, actor, target, connection/SID context, and outcome/result. The newest page live-refreshes about every 10 seconds; older pages stay frozen while paging.

## Widgets

Public server widgets can expose selected server status without application login using a dedicated widget token.

Available output includes live HTML, SVG, and PNG. Widget configuration can control whether channel and client information is shown. Footers brand as **ts6-manager** and link to the public GitHub repository. The HTML/iframe embed link is always clickable; the SVG footer link works when the SVG is opened as a document (for example via the direct `.svg` URL), but not when the file is embedded as an `<img>`.

Treat widget tokens as public-access capabilities and expose only the information you intend to publish.

## Access control

The application has administrator and viewer roles plus per-server access control. Sensitive configuration, automation, and server-management operations remain administrator-only.

See [Security](security.md) for the controls around stored credentials, outbound requests, WebSockets, and automation.
