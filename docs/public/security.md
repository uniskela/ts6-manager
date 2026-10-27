# Security

TS6 Manager includes application and container controls intended to keep administrative TeamSpeak access scoped and auditable.

## Accounts and authorization

- The first administrator is created through setup; there are no default credentials.
- Roles include administrator and viewer.
- Per-server access controls restrict which configured TeamSpeak servers a user may access.
- Flow CRUD, execution history, sensitive settings, and other administrative operations are administrator-only.

## Stored credentials

WebQuery API keys and SSH passwords are encrypted before they are written to SQLite.

Production requires a stable `ENCRYPTION_KEY`. Do not rotate it casually: previously stored secrets cannot be decrypted with a different key.

Secret fields are not populated back into edit forms. Leaving a secret field blank preserves the stored encrypted value.

## Authentication

The backend uses JWT access tokens plus refresh-token rotation with reuse detection. Authentication endpoints are rate-limited and password complexity rules apply.

WebSocket connections require application authentication and are scoped to the servers the user may access.

## Listener remote

The `!remote` chat command gives a listener in a media bot's channel a private, one-time link to a small web page where they can see the queue and add music. It does not sign anyone in to the manager. The link is valid for 5 minutes and works once; the session it opens lasts 15 minutes in total and ends early if the listener leaves the channel. Only hashes of the credentials are kept in memory, and a backend restart ends every session. Pasted links go through the same outbound-request checks as other media URLs, without the IPTV local-hosts exception. It needs an HTTPS Public URL and, behind an outer reverse proxy, a matching `TRUST_PROXY`. See [Media bots — Listener remote](music-bots.md#listener-remote) and [Reverse proxy](reverse-proxy.md#listener-remote-and-client-ip-limits).

## Outbound requests

HTTP automation actions and FFmpeg/media URL paths include SSRF protections; media downloads are also checked at connection time (see [Media downloads](#media-downloads)). An administrator can allow specific LAN IPTV hosts from the IPTV page header **Local hosts** dialog; that list is IPTV-only ([Video streaming](video-streaming.md#playlists-and-channels-on-your-local-network)). Bot flows do not provide an unrestricted WebQuery escape hatch: raw WebQuery actions use an allowlist.

Do not design deployments or automations around bypassing these checks.

### Media downloads

yt-dlp handles media links for music, video, library downloads, playlist imports, the listener remote and request replay. Every connection it makes goes through a checking proxy inside the backend. That includes connections from an ffmpeg that yt-dlp starts, and from the backend's own ffmpeg when it plays a track URL yt-dlp resolved. The proxy:

- accepts only connections from the job that started them (each download gets its own short-lived credentials);
- resolves each host itself, refuses loopback, private, link-local, cloud metadata and other reserved addresses (with no local-network exception), and connects only to an address it approved;
- allows only ports 80 and 443;
- never follows redirects: yt-dlp does, and each hop is checked again;
- runs yt-dlp without configuration files or plugins from the host, with its own downloader and HTTP(S), HLS and DASH formats only. When yt-dlp would hand an HTTPS stream to ffmpeg instead, the download fails;
- lets the backend's ffmpeg play only a single media file from a resolved URL, never a playlist.

If the proxy cannot start, downloads fail instead of connecting directly.

Video that yt-dlp resolves for direct streaming (YouTube direct playback, Twitch) is played by the media sidecar. The sidecar connects through its own checking proxy (`SIDECAR_EGRESS_PROXY`). Before handing a URL over, the backend checks its address and limits it to ports 80 and 443. Redirects and playlist segments that the sidecar's ffmpeg then follows are checked by the sidecar's proxy under its own rules. `MEDIA_EGRESS_PROXY=off` is an emergency setting; see [Environment variables](environment-variables.md#backend).

**What this does not cover.** The proxy controls traffic that yt-dlp and ffmpeg send through it. It is not an operating-system boundary: a downloader that ignored its proxy settings, through a bug or a future change, would not be stopped by it. The proxy also cannot recognise a NAT64 prefix that a network operator chose instead of the standard `64:ff9b::/96`. This applies to every deployment today, including the split Docker stack, the all-in-one image and a backend run outside Docker. Running downloads in a separate container with no route except the proxy is planned for the split stack ([#476](https://github.com/uniskela/ts6-manager/issues/476)). The all-in-one image and native installs will continue to rely on the proxy alone.

**Restricting outbound access yourself.** The backend needs outbound HTTPS for media and its TeamSpeak Query connections. Media downloads need no private-network access. Where you control the host or network:

- deny the backend's outbound traffic to cloud metadata, link-local and loopback addresses outside the container, and to private ranges it has no reason to reach (keep the TeamSpeak server, the sidecar and any outbound proxy reachable);
- on a native install, run the backend under its own service account so host firewall rules can match it;
- in Docker, apply those rules to the backend container's network, for example with host firewall rules for its bridge subnet.

## Appearance custom CSS

Settings → Appearance → Advanced lets a browser store optional custom CSS for that origin. The CSS is a local presentation override only:

- it is never uploaded to the backend and never changes authorization, credentials, or service-worker caching;
- it is applied only inside the signed-in management UI through one managed `<style>` element (`textContent`), not through HTML parsing or script execution;
- typing or importing into the editor does not activate CSS until **Save CSS** commits the draft and **Enable custom CSS** is on;
- custom CSS can still hide controls, override accessibility colours, and cause the browser to request external resources (`@import`, `url(...)`, and similar). There is no sanitizer — treat pasted or imported CSS as trusted local customization.

If custom CSS makes the UI unusable, open `/settings?tab=appearance&safe-ui=1` (safe mode). Safe mode latches for that document lifetime so SPA navigation cannot re-apply the CSS, does not erase saved CSS, and exposes Disable/Reset in Appearance. Leave safe mode with a normal reload after disabling or resetting.

The hard size limit is **64 KiB** (UTF-8). Oversized import/save/hydration input is rejected rather than truncated.

## Media sidecar

The sidecar mutating API is authenticated with `SIDECAR_SECRET`.

The standard compose file keeps sidecar port 9800 internal. The all-in-one image keeps it on loopback. Do not expose it publicly.

`/health` is unauthenticated and reports the sidecar's version and platform, and the secret is sent over plain HTTP. An optional [native sidecar](native-sidecar.md#network-and-security) therefore needs the same isolation Docker provides by default: bind it with `SIDECAR_HOST`, firewall TCP 9800 to the backend, and keep the path on a trusted or encrypted network.

## Runtime image hardening

Production Node images omit npm, npx, pnpm, Corepack, and esbuild build tooling.

CI rebuilds all release images and scans them with Trivy. The release gate fails when a HIGH or CRITICAL finding has an available fix. Unfixed findings remain visible in the full scan inventory rather than being hidden by ignore rules. Maintainer-approved prereleases reuse the same scan before they reach GHCR; they never move `latest`. See [Beta releases](beta.md).

## TeamSpeak Query

TS6 Manager requires authenticated WebQuery and optional authenticated SSH Query. It does not need beta13 guest Query access.

Restrict TeamSpeak Query ports to trusted management networks and see [TeamSpeak compatibility](teamspeak-compatibility.md) for beta13 settings.
