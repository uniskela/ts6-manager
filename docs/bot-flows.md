# Bot flows reference

This document describes the **bot flow engine** in TS6 Manager: triggers, conditions, actions, variables, and common patterns. It was originally adapted from [uniplayer1/ts6-manager](https://github.com/uniplayer1/ts6-manager) (MIT) and is maintained here for this core-focused fork.

## Overview

Bot flows are visual workflows stored per TeamSpeak server connection. Each flow has:

- **Triggers** — what starts execution
- **Conditions** — optional expression gates
- **Actions** — TeamSpeak, HTTP, music-bot, and utility operations
- **Variables** — persistent per-flow values plus execution-local temporary values
- **Delay / log nodes** — pacing and execution diagnostics

Flows run in the backend **bot engine**, which maintains the relevant TeamSpeak connections and executes connected nodes in order. Flow management/read routes are admin-only because flow data can contain secrets such as webhook tokens and outbound request configuration.

## Editor and templates

The editor uses rounded orthogonal connections and labelled **True** / **False** condition paths. Its drawing surface grows from the actual node and route extents, so wider saved flows are not clipped by a fixed canvas. Keep flows readable rather than relying on extreme spacing.

An unsaved editor draft is protected from normal in-app navigation, browser unload, and query refresh replacement. The saved baseline advances only after a successful save.

![Bot Flow Editor with condition branches](flow-editor.png)

**From Template** opens the maintained template gallery on the Bot Flows page. Choosing a template creates an ordinary editable flow after its required fields are configured; templates are not a separate route.

![Flow Templates gallery](flow-templates.png)

## Triggers

| Trigger | Description |
|---------|-------------|
| TS3 event | Fires on registered ServerQuery notifications such as client/channel/text events |
| Cron | Scheduled execution using the configured cron expression and optional timezone |
| Webhook | Token-addressed HTTP webhook trigger |
| Chat command | Text message matching the configured command prefix/name; command arguments are exposed to the flow event data |

The exact event fields available under `event.*` depend on the trigger that started the run.

## Conditions

Condition nodes use **expr-eval** expressions evaluated against a scoped data object. Available namespaces are:

- `event.*` — trigger/event fields; numeric strings are converted to numbers when possible
- `var.*` — persistent flow variables stored in the database
- `temp.*` — values created during the current execution
- `time.*` — time/date fields in the flow timezone

Examples:

```text
event.client_idle_time > 300
var.warningCount >= 3
contains(event.msg, "help")
time.dayOfWeek == 0
```

Custom expression helpers currently include `contains`, `startsWith`, `endsWith`, `lower`, `upper`, `length`, and `split`.

> [!IMPORTANT]
> Condition expressions do **not** use `{{...}}` template interpolation. Reference namespaces directly (`event.field`, `var.name`, `temp.value`, `time.hours`). This is intentional: interpolating untrusted event text into expression source would allow the incoming value to alter expression syntax.

A failed or invalid condition evaluates false and follows the condition node's false branch when one is connected.

## Actions

The backend dispatcher currently supports these action families:

| Action family | Current operations |
|---------------|--------------------|
| Client control | Kick, ban, move, poke |
| Messaging | Send private/channel/server text messages |
| Channel control | Create, edit, delete channels; temporary-channel cleanup; animated channel names |
| Server groups | Add/remove a client from a server group; poke group; rank checks |
| WebQuery | Run an allowed WebQuery command with resolved parameters |
| HTTP/webhooks | Outbound webhook and HTTP request actions, with URL validation / SSRF protections |
| Automation | AFK mover, idle kicker |
| Music / voice bots | Play, stop, join channel, leave channel, volume, pause/resume, skip, seek, text-to-speech |
| Utility | Generate a code/value for later nodes |

There is **no generic run-sub-flow action** in the current dispatcher. If one is added in future, update this reference alongside the implementation.

### WebQuery safety

The raw WebQuery action is restricted by the backend command whitelist. Flow authors cannot use it as an unrestricted escape hatch for destructive ServerQuery/WebQuery commands.

### Outbound requests

HTTP and webhook actions resolve configured templates before sending. Outbound URLs pass through the backend URL validator and SSRF protections; do not document or design flows around bypassing those checks.

## Variables, temporary values, and templates

### Persistent flow variables

Variable nodes write values to the database with **flow scope**. Supported operations are:

- `set`
- `increment`
- `append`

Persistent values are referenced as:

```text
{{var.name}}
```

or inside a condition expression as:

```text
var.name
```

### Execution-local temporary values

Actions can place transient results into the current execution context. These are referenced as:

```text
{{temp.name}}
{{temp.apiResult.someField}}
```

Temporary values disappear when that flow execution ends.

### Event, time, and execution placeholders

Templates support these namespaces:

- `{{event.field}}` — event/trigger data
- `{{var.name}}` — persistent flow variable
- `{{temp.name}}` — current-run temporary value
- `{{time.hours}}`, `{{time.time}}`, `{{time.date}}`, etc. — timezone-aware time values
- `{{exec.flowId}}`, `{{exec.executionId}}`, `{{exec.configId}}`, `{{exec.sid}}`, `{{exec.triggerType}}` — execution metadata

Nested JSON access is supported for applicable event/temp values. Template filters currently include `uptime`, `round`, and `floor`, for example:

```text
{{event.client_idle_time|uptime}}
{{temp.latency|round}}
```

**Client leave enrichment:** `notifyclientleftview` payloads from TeamSpeak often include only `clid` / channel / reason fields. EventBridge caches allow-listed identity fields (`client_nickname`, `client_type`, `client_unique_identifier`, `client_database_id`) from `notifycliententerview` and merges them into leave events before flows run. Cached fields never override values already present on the leave event. If the client was never observed joining (reconnect gap), the native leave event is still emitted without those fields.

## Delays and execution limits

Delay nodes are capped by the backend at **5 minutes per delay node**. The flow runner also caps node visits at **100 per execution** to stop accidental infinite traversal/loops.

Execution status and logs are persisted so admins can inspect recent runs and node-level messages from the UI/API.

## Security notes

- Flow CRUD, reads, execution history, and logs are admin-only.
- Treat webhook trigger tokens and configured outbound secrets like passwords.
- WebSocket live updates are scoped to servers the authenticated user may access.
- Condition expressions are evaluated without template interpolation.
- Outbound HTTP actions use URL validation / SSRF protections.
- Raw WebQuery flow actions use an allowlist.

## Example patterns

### Welcome message

1. Trigger: client-enter event
2. Condition: ignore query/service clients if required
3. Action: send a private or channel message with server rules

### AFK mover

1. Trigger: cron schedule
2. Action: AFK mover with an idle threshold and exempt channel/group configuration

### Temporary channel cleanup

1. Trigger: suitable client/channel event or schedule
2. Action: temporary-channel cleanup using the configured parent/protected channel IDs

### Chat command bot

1. Trigger: chat command such as `!rules`
2. Optional condition using `event.*` fields or persistent `var.*` values
3. Action: send the response to the appropriate TeamSpeak text target

### Music-bot automation

1. Trigger: cron, webhook, chat command, or TeamSpeak event
2. Action: choose a voice/music-bot operation such as play, volume, pause/resume, skip, or seek
3. Optional log node to record the automation outcome

## Music bots outside flows

Music bots are a separate subsystem built on the TeamSpeak voice stack. They can also be controlled directly through:

- the **Music Bots** web UI
- in-channel text commands (`!play`, `!skip`, `!vol`, etc.)

See the Music Bots section in the main README for queue, YouTube, radio, and local-library behavior.

## Safe temporary-channel ownership (v1.6.0)

The Temp Channel Creator template opts its Create Channel node into **Track for this
flow’s temporary-channel cleanup**. It records each newly created semi-permanent
channel in a persistent internal BotVariable registry scoped to flow, server
connection and virtual server, and appends a random ownership marker to its description while preserving any description configured by the flow.
Cleanup requires both the registry and the matching marker, the expected parent,
semi-permanent status and an empty channel. Non-forced deletion lets TeamSpeak reject
a client-join race. Unrelated siblings, lobby, parent and other flows’ channels are
preserved. Missing IDs are removed from tracking; reused IDs without the marker are
never deleted. Removing the ownership marker, moving the channel, or promoting it to permanent prevents cleanup; ordinary description edits are safe when the marker is retained.

**Existing templates:** enable tracking on the Create Channel node (semi-permanent
mode), or import the updated template. Only subsequently created channels are tracked.
Previously created/untracked channels must be reviewed and removed manually; the
manager never adopts channels by name or parent. Deleting a flow removes its registry
without deleting its channels. Restoring TeamSpeak independently of the manager DB
may leave orphan channels, which is preferable to deleting administrator-owned data.
Tracking does not restrict an explicitly configured generic Delete Channel action.

## Further reading

- [Documentation index](index.md) — public guides and reference
- [Music bots](music-bots.md) — queue, playback, downloads, and chat controls
- [Security](security.md) — application and deployment security
- [Architecture](architecture.md) — package and service layout
- [Roadmap](roadmap.md) — public fork direction
- [CREDITS.md](../CREDITS.md) — upstream and fork attribution
