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
| `MUSIC_DIR` | `/data/music` | Shared media directory |
| `VIDEO_QUEUE_SIZE` | `1024` | Video RTP queue |
| `AUDIO_QUEUE_SIZE` | `2048` | Audio RTP queue |
| `SYNC_PLAYOUT_BUFFER_MS` | `50` | Adaptive pacing buffer |
| `SYNC_VIDEO_BIAS_MS` | `0` | Optional video holdback |
| `SYNC_MAX_DELAY_MS` | `500` | Sync delay clamp |
| `AUDIO_DELAY_MS` | `0` | Optional manual audio delay |
| `SIDECAR_DEBUG_LOGS` | `0` | Verbose sidecar logs when set to `1` |
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

TeamSpeak beta13 Query environment variables belong on the TeamSpeak server/container, not on TS6 Manager. See [TeamSpeak compatibility](teamspeak-compatibility.md).
