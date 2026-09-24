# Configuration

## Required application secrets

Production deployments require stable secrets.

### `JWT_SECRET`

Signs application access and refresh tokens. Use a strong random value.

### `ENCRYPTION_KEY`

Encrypts stored TeamSpeak API keys and SSH passwords with AES-256-GCM.

Generate this value once and preserve it across restarts and upgrades. If it changes, TS6 Manager can no longer decrypt credentials written with the previous key.

### `SIDECAR_SECRET`

Authenticates mutating calls from the backend to the media sidecar. It is required when a production backend uses `SIDECAR_URL`.

## Initial administrator

The setup wizard creates the first administrator account. There are no default login credentials.

## Add a TeamSpeak server

Open **Settings → Connections** and provide the TeamSpeak host, WebQuery HTTP port, and a management API key.

**Test WebQuery** runs staged checks in order: reachability, authentication, **read** permissions, then virtual server access. A complete success confirms management read access only — it does **not** authorize kicks, bans, file changes, or other writes. Those actions still need their own Query permissions and surface failures at the action. The result can be a complete success or a partial success when some stages pass and a later stage does not. **Test SSH** stays a single pass or fail.

For TeamSpeak 6.0.0-beta13, see [TeamSpeak compatibility](teamspeak-compatibility.md) for the recommended Query settings and deterministic admin-key option.

### Persistent WebQuery API keys

If you create a key manually through authenticated Query, use a non-expiring lifetime when appropriate:

~~~text
use 1
apikeyadd scope=manage lifetime=0 ip=0.0.0.0/0
~~~

Restrict the source network where practical.

TS6 Manager encrypts the saved key. Editing a connection intentionally leaves secret fields blank; leaving a secret field blank preserves the existing encrypted value.

### Demo server for UI testing

The connection setup wizard can create a **Demo TeamSpeak Server** without a real TeamSpeak deployment. Demo mode uses deterministic, generic synthetic channels, clients, groups, permissions, bans, tokens, and logs inside the manager process.

Demo mode does not resolve a TeamSpeak hostname, open a WebQuery or SSH connection, or send commands to a real server. It is intended for UI/UX evaluation, screenshots, and learning the interface. Mutating actions are simulated and the fixture state is not a substitute for a real TeamSpeak server.

Delete the demo connection from **Settings → Connections** when it is no longer needed.

## SSH Query

Authenticated SSH Query is optional for core WebQuery management, but some features need it, including file browsing, bot-flow event triggers, and music-bot channel chat commands.

Transient SSH closes during the initial handshake are retried automatically. Authentication and host-key failures remain configuration errors that need administrator attention.

## Self-signed TeamSpeak certificates

`TS_ALLOW_SELF_SIGNED` defaults to `false`. Enable it only when you intentionally use a self-signed TeamSpeak WebQuery TLS certificate and understand the trust implications.

## YouTube cookies

`YT_COOKIE_FILE` can point to a Netscape-format cookies file. Cookies can also be managed through **Settings → YouTube** in the web interface.

Cookies may be needed for media that requires authentication, age verification, or membership. Treat them as credentials.

See [Environment variables](environment-variables.md) for the complete runtime reference.
