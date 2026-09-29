# Video streaming

TS6 Manager includes a Go/Pion media sidecar for low-latency video delivery to TeamSpeak clients and the browser preview.

## Supported inputs

The streaming path can accept supported YouTube, Twitch, direct media URLs, and IPTV sources.

## Quality

Pick **Auto** or a fixed preset: 480p, 720p, 1080p, 1440p or 2160p.

- **Auto** probes the source with `ffprobe` and uses the largest preset the source fits without upscaling, up to the **Auto limit** (default 1080p). A 720p channel stays 720p even when the limit is 2160p. If the probe fails, Auto uses 720p (or the limit, if lower) and says so.
- **Fixed presets** skip the probe. Prefer them for IPTV services that allow only one connection, since the probe is a second one.
- The stream panel shows *requested → actual*, e.g. `Auto → 1080p (source 1920×1080)`.
- Leave the bitrate empty to use the preset's bitrate. Admins can set a **bitrate limit** that clamps every stream.

1440p and 2160p need a fast CPU with software encoders; a hardware encoder is recommended.

## Encoders

| Encoder | Codec | Notes |
|---|---|---|
| VP8 (software) | VP8 | Default; `libvpx` realtime |
| VP9 (software) | VP9 | `libvpx-vp9` realtime |
| H.264 (software) | H.264 | `libx264`, offered as **Constrained High** — the only H.264 profile the TeamSpeak client renders |
| VP8 / VP9 / H.264 (VAAPI) | same | GPU encode through VAAPI; H.264 uses Constrained High as well |

**Auto** uses software VP8, unless *Auto prefers hardware* is enabled: then it uses the first VAAPI encoder (H.264, then VP9, then VP8) that passed the sidecar's test encode.

If a hardware encoder cannot open the device or exits during startup, the sidecar restarts with the software encoder **of the same codec** (so connected viewers keep working) and the stream panel shows the fallback and its reason. Use **Check encoders** under *Streaming defaults* to run the test encodes on demand; routine status polling never runs them.

### Enabling VAAPI (Intel / AMD GPUs)

1. Pass the render node through to the sidecar container, for example in `docker-compose.yml`:

   ```yaml
   sidecar:
     devices:
       - /dev/dri:/dev/dri
   ```

2. The sidecar and all-in-one images include Mesa's VAAPI driver (`mesa-va-drivers`, AMD and older Intel) and, on amd64, Intel's `intel-media-va-driver`. For the all-in-one image, pass `/dev/dri` to that container instead.
3. Open *Streaming defaults* → **Check encoders** and confirm the VAAPI rows pass. Set `VAAPI_DEVICE` if your render node is not `/dev/dri/renderD128`.
4. Optionally set `VIDEO_HW_DECODE=1` to decode on the GPU too.

NVENC is not supported yet.

## One media session at a time

- A bot plays **music or video, never both**.
- Only **one video stream** runs at a time across all bots, because they share the media sidecar.

Starting something that would replace what is playing asks for confirmation first ("Replace what is playing?"), listing exactly what will stop. The server only replaces the sessions you confirmed, so double clicks, two admins, or a chat command racing a UI click cannot silently stop each other's media. Something that is still *starting* cannot be replaced — wait for it to finish, then try again.

Chat commands are explicit requests on one bot: `!play` on a bot that is streaming video stops that bot's stream, and `!stream` / `!tv` stop that bot's music. A chat command never stops another bot's stream.

The stop reason says what happened, for example *Replaced by music* or *Replaced by a stream on Bravo*.

## Stopping and stop reasons

A stream stops on its own when:

- **nobody watches it** — no TeamSpeak client has had it open for the no-viewer timeout (default 5 minutes; Off, 1, 5, 10, 30 minutes or custom). While it counts down, the stream panel shows **Auto-stop in m:ss**. The browser preview does not count as a viewer. Each stream can override the timeout without changing the saved default;
- **the bot's channel is empty** for `BOT_AUTO_STOP_EMPTY_SECONDS` (separate setting);
- **a downloaded clip ends**.

After a stream stops, the tab shows the last reason, for example *Last stream: Stopped after 5 minutes with no viewers · 8 min ago*.

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

1. the backend can reach `SIDECAR_URL`, and the sidecar image is the same release as the backend (an older sidecar ignores encoder selection and always sends VP8 — the stream panel says so);
2. backend and sidecar use the same `SIDECAR_SECRET`;
3. the media volume is mounted at the same path in both containers; and
4. the source URL is still available to yt-dlp/FFmpeg.

Use the Runtime / media strip beside Video streaming or IPTV controls (Refresh) for a bounded on-demand sidecar and tool probe. Routine music-bot status polling does not call the sidecar health endpoint.

See [Troubleshooting](troubleshooting.md) for common deployment checks.
