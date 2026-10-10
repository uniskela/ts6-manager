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
| `PUBLIC_URL` | — | Address TeamSpeak clients use to reach the manager (e.g. `https://ts6.example.com`); hosted channel banners and listener remote links start with it. A **Public URL** saved in the UI overrides it. Listener remote requires HTTPS (development loopback HTTP is allowed) |
| `TRUST_PROXY` | unset (no forwarded-header trust) | Comma-separated trusted proxy IPs/CIDRs or Express subnet names, e.g. `loopback` for all-in-one nginx. Set only to the proxy chain that can reach the backend; see [Reverse proxy](reverse-proxy.md#listener-remote-and-client-ip-limits) |
| `MUSIC_DIR` | `/data/music` | Downloaded/local music directory |
| `BOT_AUTO_STOP_EMPTY_SECONDS` | `300` | Stop music or video when the bot's channel stays empty this long; `0` disables (including bots created in the UI). A video stream with at least one TeamSpeak viewer is exempt; the no-viewer timeout still applies |
| `SIDECAR_URL` | — | Optional media-sidecar URL, normally `http://ts6-sidecar:9800` in split Docker. For a native Windows sidecar with a Docker Desktop backend, use `http://host.docker.internal:9800`; otherwise use the Windows host's private address |
| `SIDECAR_SECRET` | — | Shared bearer secret; required with `SIDECAR_URL` in production |
| `SIDECAR_BINARY_PATH` | — | Optional sidecar binary path for non-standard deployments |
| `YT_COOKIE_FILE` | — | Optional Netscape-format yt-dlp cookie file |
| `YT_DLP_PATH` | `/usr/local/bin/yt-dlp` | Absolute path to the yt-dlp executable used by music, video and diagnostics. For a nonstandard or native install, set the full executable path (e.g. `/usr/bin/yt-dlp` or `C:\Tools\yt-dlp.exe`). Use an administrator-controlled directory that untrusted users cannot write; inherited `PATH` is not used to locate yt-dlp |
| `TS_ALLOW_SELF_SIGNED` | `false` | Allow self-signed TeamSpeak WebQuery TLS certificates |

### Video streaming defaults

These seed the **Streaming defaults** shown to admins on the Video Stream tab. A value saved in the UI overrides the environment value; each stream can still override quality, encoder and the no-viewer stop. Admins can also override any of them for one server ("Applies to: <server> only"); fields left equal to the global value keep inheriting it.

| Variable | Default | Purpose |
|---|---|---|
| `VIDEO_NO_VIEWER_TIMEOUT_SECONDS` | `300` | Stop a video stream no TeamSpeak client has open for this long; `0` disables. Separate from the channel-empty stop (`BOT_AUTO_STOP_EMPTY_SECONDS`) |
| `VIDEO_AUTO_MAX_PRESET` | `1080p` | Highest preset **Auto** quality may pick (`720p`–`2160p`); Balanced profile default |
| `VIDEO_ENCODER` | `auto` | Default encoder: `auto`, `vp8`, `vp9`, `h264`, `vp8_vaapi`, `vp9_vaapi`, `h264_vaapi`, `h264_nvenc`, `h264_amf` |
| `VIDEO_PREFER_HARDWARE` | `false` | Let `auto` use the first hardware encoder (VAAPI / NVENC / AMF) that passes the sidecar test encode |
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
| `SIDECAR_PORT` | `9800` | Sidecar HTTP port; the native process listens on all interfaces, so restrict access to trusted backend hosts using the host firewall |
| `SIDECAR_SECRET` | — | Shared backend/sidecar secret |
| `WEBRTC_UDP_PORT` | unset | When set (for example `10000`), bind a shared IPv4 ICE UDP mux on that port so Docker can publish one host UDP mapping for browser WebRTC preview. Leave unset to keep ephemeral ICE ports (Docker host browsers usually cannot reach them). |
| `WEBRTC_NAT1TO1_IP` | unset | Comma-separated **IPv4** addresses advertised as ICE **host** candidates (replaces container-private addresses). This is what the **browser** must be able to reach. IPv6 is rejected — the mux binds `udp4` only. Pair with `WEBRTC_UDP_PORT` and a published UDP mapping. `docker-compose.pr-test.yml` defaults to `127.0.0.1` for **same-host** browsers only. For LAN/Tailscale clients use that reachable IPv4; for a public-NAT browser use the public IPv4 (and forward UDP to the host). Do not advertise `127.0.0.1` to remote clients. The same addresses are offered to **TeamSpeak viewers**, and the TeamSpeak client does not connect to `127.0.0.1` even on the Docker host: to watch in TeamSpeak, add the host's LAN or Tailscale IPv4 (for example `127.0.0.1,192.168.1.20`) and publish the port on it. |
| `WEBRTC_BIND_IP` | `127.0.0.1` (compose) | Local Docker **host** address for the published UDP mapping (compose only; not a sidecar env). Distinct from `WEBRTC_NAT1TO1_IP`: bind can stay on a host/LAN address (or `0.0.0.0` if you accept broader exposure) while NAT1To1 advertises the address clients dial. Defaults to loopback for same-host preview. Example (public NAT): advertise `WEBRTC_NAT1TO1_IP=<public-ipv4>`, bind `WEBRTC_BIND_IP=0.0.0.0` (or the host LAN IP), publish `${WEBRTC_BIND_IP}:${WEBRTC_UDP_PORT}:…/udp`, and forward that UDP port from the public IP to the Docker host. |
| `MUSIC_DIR` | `/data/music` | Shared media directory. For a native Windows sidecar, set a Windows path to the same files mounted in the backend's `MUSIC_DIR`. Local video sources use a portable `music://filename` reference resolved under each sidecar's own root; legacy absolute sources still require a matching path |
| `VIDEO_QUEUE_SIZE` | `4096` | Video RTP queue (packets); holds `SYNC_MAX_DELAY_MS` of a 4K stream |
| `AUDIO_QUEUE_SIZE` | `2048` | Audio RTP queue |
| `SYNC_PLAYOUT_BUFFER_MS` | `50` | Playout buffer added to both tracks on top of the later track's latency |
| `SYNC_VIDEO_BIAS_MS` | `0` | Optional video holdback |
| `SYNC_MAX_DELAY_MS` | `1000` | The most one track is held back to meet the other, and how long the first track waits for the other to start |
| `AUDIO_DELAY_MS` | `0` | Optional manual audio delay |
| `SIDECAR_DEBUG_LOGS` | `0` | Verbose sidecar logs when set to `1` |
| `SIDECAR_EGRESS_PROXY` | on | `off` lets ffmpeg connect to remote sources directly, without checking redirects and HLS segment hosts. Not recommended; the backend still checks the first URL. The checking proxy ignores `http_proxy`/`HTTPS_PROXY`, so a sidecar that can only reach the internet through an outbound proxy needs `off` |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg executable; for Windows AMF, use the full path to an AMF-enabled `ffmpeg.exe` (PowerShell: `(Get-Command ffmpeg).Source`) |
| `FFPROBE_PATH` | `ffprobe` | ffprobe binary for the *Auto* quality probe of URL sources; set the Windows executable path if it is not on `PATH` |
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
| `FFMPEG_HTTP_PERSISTENT` | `auto` | `auto` and `0` send the standard `Connection: close` header on remote HTTP(S) inputs. FFmpeg forwards it to HLS playlists, segments and redirects, including URLs without a playlist suffix. MPEG-TS and MP4 remain supported. `1` leaves FFmpeg's connection behavior and custom headers unchanged. Applies to playback and ffprobe; sidecar only |
| `FFMPEG_EXTRA_INPUT_ARGS` | unset | Extra options before each remote input, also used by ffprobe. Parsed as arguments, not a shell. Quotes group values containing spaces; inside double quotes, `\r`, `\n` and `\t` expand. Custom headers are preserved, but `Connection` is replaced with `close` unless `FFMPEG_HTTP_PERSISTENT=1`. Options must work with both ffmpeg and ffprobe and with every remote input format. Do not put HLS-only `-http_persistent` here. The whole value is ignored when it contains `-i` or a bare `scheme://` token; a URL inside a header value is fine. Sidecar only |
| `FFMPEG_EXTRA_OUTPUT_ARGS` | unset | Extra FFmpeg options inserted immediately before each RTP muxer (`-f rtp`), video and audio. Same parsing and rejection rules as the input variable. Sidecar only |
| `VIDEO_GOP` | `15` | Keyframe interval in frames (new viewers start at a keyframe) |
| `VIDEO_VP9_CPU_USED` | `8` | libvpx-vp9 realtime speed/quality trade-off |
| `VIDEO_X264_PRESET` | `veryfast` | libx264 preset for software H.264 |
| `VIDEO_NVENC_PRESET` | `p4` | NVENC preset for `h264_nvenc` (`p1` fastest … `p7` best quality) |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Render node used by VAAPI encoders |
| `VAAPI_LOW_POWER` | `0` | Try the low-power (VDEnc) entrypoint first; the capability probe also retries it automatically |
| `VAAPI_VERIFY_MS` | `1500` | How long a hardware encoder must survive startup before the sidecar trusts it (otherwise it falls back to software) |
| `VIDEO_HW_DECODE` | `0` | Set to `1` to also decode the source on the GPU (`-hwaccel vaapi`, or `-hwaccel cuda` with NVENC); ffmpeg falls back to software decode for unsupported codecs. AMF currently uses software decode and uploads NV12 frames from system memory; this setting does not enable AMF hardware decode. With VAAPI, the decoded frames also stay on the GPU and are scaled there (`scale_vaapi`), see `VIDEO_GPU_FILTERS` |
| `VIDEO_GPU_FILTERS` | on | With VAAPI and `VIDEO_HW_DECODE=1`, keep the decoded frames in GPU memory and scale them with `scale_vaapi` instead of copying them back for the CPU filters. `0` copies them back (the behaviour before). Has no effect without `VIDEO_HW_DECODE=1` |

For a native Windows sidecar, set `WEBRTC_UDP_PORT` directly in the Windows process (typically `10000`) and advertise a Windows LAN/Tailscale IPv4 reachable by viewers via `WEBRTC_NAT1TO1_IP`. There is no Docker UDP publication and `WEBRTC_BIND_IP` has no effect on the native process. Permit the HTTP TCP port only from the backend, and the WebRTC UDP port from intended viewers; do not expose the HTTP API publicly. See [AMD AMF (Windows)](video-streaming.md#amd-amf-windows) for supported production deployment and the separate PR-test setup.

TeamSpeak beta13 Query environment variables belong on the TeamSpeak server/container, not on TS6 Manager. See [TeamSpeak compatibility](teamspeak-compatibility.md).
