# Video streaming

TS6 Manager includes a Go/Pion media sidecar for low-latency video delivery to TeamSpeak clients and the browser preview.

## Supported inputs

The streaming path can accept supported YouTube, Twitch, direct media URLs, and IPTV sources.

The UI exposes quality presets such as 480p, 720p, and 1080p.

## IPTV playlists

The IPTV page manages M3U/M3U8 playlist sources for the selected server. Administrators can add a source as either a **remote playlist URL** or an **uploaded playlist file** (`.m3u`, `.m3u8`, or `.txt` with valid M3U content), then refresh, replace (uploads), or delete it; browse or search its parsed channels; filter by group; choose a running music bot and quality preset; then start or stop that channel's stream.

### URL vs uploaded source

| Source | Refresh | Auto-refresh | Storage |
|--------|---------|--------------|---------|
| Playlist URL | Re-fetches over HTTP(S) | Optional (minutes) | URL only in the database |
| Uploaded file | Re-reads/re-parses the stored file | Off by default (file does not change on its own) | File under backend `data/iptv/` + metadata in the database |

Uploaded sources are stored as application assets on the backend data volume (not TeamSpeak channel file storage). A full restore of uploaded playlists needs both the database and the `backend-data` volume. XMLTV/EPG upload, Xtream credential forms, and source export remain separate follow-ups.

![IPTV playlist and channel browser](iptv.png)

## Architecture

The backend coordinates media preparation and session state. The Go sidecar handles the WebRTC/media relay.

In the standard split-stack compose file:

- the sidecar listens on port 9800 inside the Docker network;
- port 9800 is **not** published to the host;
- backend-to-sidecar mutating requests use `SIDECAR_SECRET`; and
- the backend and sidecar share the media volume.

The all-in-one image keeps the backend and sidecar on loopback behind nginx.

## Synchronization

The sidecar uses RTCP Sender Reports and adaptive pacing controls for A/V synchronization. Environment variables allow limited tuning of playout buffering, bias, queue sizes, bitrate, and encoder behavior.

See [Environment variables](environment-variables.md) for the available sidecar settings.

## Operational notes

Do not expose the sidecar directly to the public network.

If a stream does not start, check:

1. the backend can reach `SIDECAR_URL`;
2. backend and sidecar use the same `SIDECAR_SECRET`;
3. the media volume is mounted at the same path in both containers; and
4. the source URL is still available to yt-dlp/FFmpeg.

Use the Runtime / media strip beside Video streaming or IPTV controls (Refresh) for a bounded on-demand sidecar and tool probe. Routine music-bot status polling does not call the sidecar health endpoint.

See [Troubleshooting](troubleshooting.md) for common deployment checks.
