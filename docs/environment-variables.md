# Environment variables

## Backend

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | — | Required production JWT signing secret |
| `ENCRYPTION_KEY` | — | Required production key for encrypted stored credentials |
| `PORT` | `3001` | Backend HTTP port |
| `DATABASE_URL` | `file:./data/ts6webui.db` | Prisma SQLite database path |
| `JWT_ACCESS_EXPIRY` | `15m` | Access-token lifetime |
| `JWT_REFRESH_EXPIRY` | `7d` | Refresh-token lifetime |
| `FRONTEND_URL` | `http://localhost:3000` | Allowed frontend/CORS origin |
| `MUSIC_DIR` | `/data/music` | Downloaded/local music directory |
| `SIDECAR_URL` | — | Optional media-sidecar URL, normally `http://ts6-sidecar:9800` in split Docker |
| `SIDECAR_SECRET` | — | Shared bearer secret; required with `SIDECAR_URL` in production |
| `SIDECAR_BINARY_PATH` | — | Optional sidecar binary path for non-standard deployments |
| `YT_COOKIE_FILE` | — | Optional Netscape-format yt-dlp cookie file |
| `TS_ALLOW_SELF_SIGNED` | `false` | Allow self-signed TeamSpeak WebQuery TLS certificates |

### Video streaming defaults

These seed the **Streaming defaults** shown to admins on the Video Stream tab. A value saved in the UI overrides the environment value; each stream can still override quality, encoder and the no-viewer stop. Admins can also override any of them for one server ("Applies to: <server> only"); fields left equal to the global value keep inheriting it.

| Variable | Default | Purpose |
|---|---|---|
| `VIDEO_NO_VIEWER_TIMEOUT_SECONDS` | `300` | Stop a video stream no TeamSpeak client has open for this long; `0` disables. Separate from the channel-empty stop (`BOT_AUTO_STOP_EMPTY_SECONDS`) |
| `VIDEO_AUTO_MAX_PRESET` | `1080p` | Highest preset **Auto** quality may pick (`720p`–`2160p`); Balanced profile default |
| `VIDEO_ENCODER` | `auto` | Default encoder: `auto`, `vp8`, `vp9`, `h264`, `vp8_vaapi`, `vp9_vaapi`, `h264_vaapi` |
| `VIDEO_PREFER_HARDWARE` | `false` | Let `auto` use the first VAAPI encoder that passes the sidecar test encode |
| `VIDEO_MAX_BITRATE_KBPS` | `4500` | Clamp every stream bitrate (kbps); `0` = no clamp. Balanced profile default is `4500` |
| `VIDEO_ENCODE_PROFILE` | `balanced` | `performance`, `balanced`, `quality`, or `custom` — expands into Auto max, bitrate clamp, and encode speed |
| `VIDEO_CPU_USED` | `4` | Default libvpx `-cpu-used` when no admin profile/cpuUsed is stored (higher = faster) |

## Frontend development

| Variable | Default/example | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3001` | Backend API URL for Vite development |
| `VITE_WS_URL` | `ws://localhost:3001/ws` | WebSocket URL for Vite development |

The production nginx container proxies the deployed frontend to the backend; these Vite variables are primarily for local development.

## Media sidecar

The values below are code defaults. Compose files may override them.

| Variable | Default | Purpose |
|---|---|---|
| `SIDECAR_PORT` | `9800` | Sidecar HTTP port |
| `SIDECAR_SECRET` | — | Shared backend/sidecar secret |
| `WEBRTC_UDP_PORT` | unset | When set (for example `10000`), bind a shared IPv4 ICE UDP mux on that port so Docker can publish one host UDP mapping for browser WebRTC preview. Leave unset to keep ephemeral ICE ports (Docker host browsers usually cannot reach them). |
| `WEBRTC_NAT1TO1_IP` | unset | Comma-separated **IPv4** host/LAN/Tailscale IPs to advertise as ICE **host** candidates (replaces container-private addresses). IPv6 is rejected — the mux binds `udp4` only. Pair with `WEBRTC_UDP_PORT` and a published UDP mapping. `docker-compose.pr-test.yml` defaults to `127.0.0.1` for same-host browsers. |
| `WEBRTC_BIND_IP` | `127.0.0.1` (compose) | Host address Docker binds when publishing `WEBRTC_UDP_PORT` (compose only; not a sidecar env). Defaults to loopback so the media port is not exposed on all interfaces. For a remote browser, set this to the same LAN/Tailscale IPv4 as `WEBRTC_NAT1TO1_IP`. |
| `MUSIC_DIR` | `/data/music` | Shared media directory |
| `VIDEO_QUEUE_SIZE` | `1024` | Video RTP queue |
| `AUDIO_QUEUE_SIZE` | `2048` | Audio RTP queue |
| `SYNC_PLAYOUT_BUFFER_MS` | `50` | Adaptive pacing buffer |
| `SYNC_VIDEO_BIAS_MS` | `0` | Optional video holdback |
| `SYNC_MAX_DELAY_MS` | `500` | Sync delay clamp |
| `AUDIO_DELAY_MS` | `0` | Optional manual audio delay |
| `SIDECAR_DEBUG_LOGS` | `0` | Verbose sidecar logs when set to `1` |
| `SIDECAR_EGRESS_PROXY` | on | `off` lets ffmpeg connect to remote sources directly, without checking redirects and HLS segment hosts. Not recommended; the backend still checks the first URL. The checking proxy ignores `http_proxy`/`HTTPS_PROXY`, so a sidecar that can only reach the internet through an outbound proxy needs `off` |
| `FFPROBE_PATH` | `ffprobe` | ffprobe binary for the *Auto* quality probe of URL sources |
| `VIDEO_RTP_READ_BUFFER` | `4194304` | Requested video UDP read buffer |
| `AUDIO_RTP_READ_BUFFER` | `1048576` | Requested audio UDP read buffer |
| `VIDEO_WIDTH` | `1280` | Default output width |
| `VIDEO_HEIGHT` | `720` | Default output height |
| `VIDEO_FRAMERATE` | `30` | Default output frame rate |
| `VIDEO_BITRATE` | `1500k` | Default VP8 bitrate |
| `AUDIO_BITRATE` | `128k` | Default Opus bitrate |
| `VIDEO_CPU_USED` | `4` | libvpx realtime speed/quality trade-off |
| `VIDEO_ENCODE_THREADS` | CPU count | libvpx encode thread count |
| `VIDEO_BUFSIZE` | automatic | Optional explicit bitrate buffer |
| `VIDEO_LIVE_PACING` | `re` | `re` reads live sources with `-re` (measured steady ~1.0x); `source` lets the live source pace input (startup burst) |
| `VIDEO_GOP` | `15` | Keyframe interval in frames (new viewers start at a keyframe) |
| `VIDEO_VP9_CPU_USED` | `8` | libvpx-vp9 realtime speed/quality trade-off |
| `VIDEO_X264_PRESET` | `veryfast` | libx264 preset for software H.264 |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Render node used by VAAPI encoders |
| `VAAPI_LOW_POWER` | `0` | Try the low-power (VDEnc) entrypoint first; the capability probe also retries it automatically |
| `VAAPI_VERIFY_MS` | `1500` | How long a hardware encoder must survive startup before the sidecar trusts it (otherwise it falls back to software) |
| `VIDEO_HW_DECODE` | `0` | Set to `1` to also decode the source on the GPU (`-hwaccel vaapi`); ffmpeg falls back to software decode for unsupported codecs |

TeamSpeak beta13 Query environment variables belong on the TeamSpeak server/container, not on TS6 Manager. See [TeamSpeak compatibility](teamspeak-compatibility.md).
