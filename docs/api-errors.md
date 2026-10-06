# API errors

User-facing API failures use `AppError` (and a few TeamSpeak subclasses). The JSON body is additive: existing `error` / `details` fields stay, with optional machine-readable metadata.

```json
{
  "error": "Short user-facing title",
  "details": "Useful explanation",
  "reason": "stable_machine_reason",
  "retryable": false,
  "retryAfterSeconds": 5
}
```

Unexpected bugs are never the exception message. They return `reason: "unexpected_error"` plus an `errorId` that is also written to the server log as `[Error <id>] …`.

## Duplicate video start

`POST /api/music-bots/:id/stream/start` while that bot is already streaming:

| Condition | Result |
|---|---|
| Same source, same quality/encoder/options | HTTP 200 `{ success: true, alreadyRunning: true }` |
| Same source, different quality/encoder/options | HTTP 409 `stream_already_running` (stop first) |
| Different source on this bot | HTTP 409 `stream_already_running` (stop or Switch source) |
| Stream still starting / stopping | HTTP 409 `stream_starting` / `stream_stopping` |
| Another bot owns the global video session, or this bot is playing music | HTTP 409 `media_session_conflict` (existing confirm-and-replace) |

Starting a new stream is not an implicit restart. Encoder and quality are applied at start; source changes while live use Switch source (`POST …/stream/source`).

## Reasons that are implemented

| reason | Typical HTTP | Meaning |
|---|---|---|
| `media_session_conflict` | 409 | Replacing another music/video session needs confirmation |
| `stream_already_running` | 409 | This bot already has a video stream |
| `stream_starting` | 409 | Video start is in flight |
| `stream_stopping` | 409 | Video stop is in flight |
| `stream_not_running` | 409 | Volume / source / preview / kick needs a live stream |
| `source_invalid` | 400 | Missing, malformed, or unsafe source |
| `source_not_found` | 404 | Local file is not in the music folder |
| `source_refused` | 422 | Source cannot be used with current settings (duration filter, live-download, …) |
| `source_unavailable` | 502 | yt-dlp / resolve failed |
| `source_timeout` | 504 | Source resolve or download timed out |
| `sidecar_unavailable` | 502/503 | Sidecar missing, crash, or HTTP error (body is not forwarded) |
| `sidecar_timeout` | 504 | Sidecar health check or process start timed out (not HTTP error bodies) |
| `request_timeout` | 504 | Generic abort/timeout on a route that is not sidecar-specific |
| `bot_not_connected` | 409 | Bot must be started first |
| `bot_already_started` | 409 | Start while already connected |
| `ts_query_flood` | 429 | TeamSpeak Query flood protection |
| `ts_query_starting` | 503 | Query is still booting |
| `ts_ssh_disconnected` | 503 | EventBridge SSH session is down |
| `ts_permission_denied` | 403 | Query permission denied |
| `ts_logview_io` | 502 | TeamSpeak logfile I/O (error 2052) |
| `ts_stream_timeout` | 504 | No reply to `setupstream` |
| `ts_stream_refused` | 502 | TeamSpeak refused `setupstream` |
| `unexpected_error` | 500 | Bug; client copy is generic; log has the real error plus `errorId` |

Hardware encoder fallback is not an error: the stream starts on software and the UI shows the fallback note.

Frontend: `apiErrorPresentation()` / `apiErrorMessage()` prefer `reason` over Axios “Request failed with status code …”.
