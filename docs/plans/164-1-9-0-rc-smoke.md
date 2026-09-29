# #164 / 1.9.0 — Release-candidate smoke checklist

**Status:** Manual checklist for the 1.9.0 media work ([#164](https://github.com/uniskela/ts6-manager/issues/164), [#150](https://github.com/uniskela/ts6-manager/issues/150), evidence for [#72](https://github.com/uniskela/ts6-manager/issues/72)).  
**Scope:** Behavior that unit, route, and Playwright tests cannot prove, because it needs a real TeamSpeak client, a GPU, or a live source.

Run this against the release-candidate images before merging the Release Please PR. Record the image tag, host CPU/GPU, and TeamSpeak client version with each run. Mark each row **Pass**, **Fail** (with a link to the issue), or **N/A** (with the reason, for example "no GPU on this host").

Do not paste stream URLs, IPTV credentials, or internal hostnames into issues or this file. Refer to them as "provider A live channel" or similar.

---

## 0. Setup

| # | Check | Expected |
| --- | --- | --- |
| 0.1 | Start the split stack (`docker-compose.yml`) and, separately, the all-in-one image | Both start healthy. The sidecar port 9800 is not published on the host |
| 0.2 | *Music Bots → Video → Streaming defaults → Check encoders* on a host **without** `/dev/dri` | Software VP8/VP9/H.264 pass. VAAPI rows show *VAAPI device not present* |
| 0.3 | Open *Bot Hub* (`/bot-hub`) | Section links work. Every bot is listed with its server and channel |

## 1. Codec matrix (TeamSpeak client)

Stream the same 720p on-demand source to a TeamSpeak client for each encoder. For each run, join as a second viewer after the stream has started.

| # | Encoder | Expected |
| --- | --- | --- |
| 1.1 | VP8 (software) | Picture and audio in the TS client and browser preview. A late joiner gets a picture within one keyframe interval (about 0.5 s at 30 fps) |
| 1.2 | VP9 (software) | Same as 1.1 |
| 1.3 | H.264 (software) | Same as 1.1. The picture is not black (Constrained High profile is negotiated) |
| 1.4 | Change the source mid-stream (same encoder) | Viewers keep the stream without rejoining |
| 1.5 | H.264 (software, then VAAPI if available) at **1080p** and **1440p** | Picture renders. The offer always declares level 3.1 (`640c1f`); if the client shows black or rejects the stream only above 720p, report it, because the level then has to follow the frame size |
| 1.6 | Stop a stream, start another on the same bot, repeat 3–4 times, then have a viewer join | The viewer joins once and gets a picture; the backend log shows one join per request, not one per earlier stream |

## 2. VAAPI (GPU host)

Pass `/dev/dri` through as described in [Video streaming → Enabling VAAPI](../video-streaming.md#enabling-vaapi-intel--amd-gpus).

| # | Check | Expected |
| --- | --- | --- |
| 2.1 | *Check encoders* | The VAAPI rows that the GPU supports pass. `low-power` shows where the driver needs it (Intel iHD) |
| 2.2 | Stream with H.264 (VAAPI), then VP9 (VAAPI) and VP8 (VAAPI) where supported | Picture in the TS client. The stream panel shows the hardware encoder with no fallback |
| 2.3 | Choose an encoder the GPU cannot run (for example VP8 VAAPI on a GPU without it) | The stream starts on the software encoder **of the same codec**. The panel and Bot Hub show the fallback reason |
| 2.4 | Enable *Auto prefers hardware* and start with encoder **Auto** | The first passing VAAPI encoder (H.264 → VP9 → VP8) is used |
| 2.5 | `VIDEO_HW_DECODE=1` with an H.264 source | The stream runs. Record CPU use compared with 2.2 |
| 2.6 | Explicit H.264 (VAAPI) on Intel iHD **before** running *Check encoders* (fresh sidecar) | The hardware encoder starts after the low-power retry, not the software fallback |

## 3. Quality

| # | Check | Expected |
| --- | --- | --- |
| 3.1 | Auto with a 720p source and Auto limit 2160p | `Auto → 720p (source 1280×720)`. No upscale |
| 3.2 | Auto with a 1080p source and Auto limit 720p | `Auto → 720p` |
| 3.3 | Auto with a portrait (9:16) source | A preset that fits without upscaling beyond about 11% |
| 3.4 | Auto with an unreachable probe (bad URL) | Falls back to 720p (or the limit if lower) and says so, or stops as *source unreachable* |
| 3.5 | Bitrate limit 2000 kbps with the 1080p preset | Encoded bitrate is at most about 2000 kbps (sidecar stats / TS client stats) |
| 3.5a | 2160p (or a custom 20000k bitrate) with no limit set | The client reports about 9.5 Mbit/s or less and the stream keeps running |
| 3.6 | 1440p and 2160p on software VP8 on a small host | Runs, or shows the below-realtime warning (section 5), never a silent freeze |

## 4. Live IPTV (issue #72)

Use at least one live HLS channel and, if available, one CMAF channel whose segments each repeat `moov`.

| # | Check | Expected |
| --- | --- | --- |
| 4.1 | Start the channel from *IPTV* at a fixed preset the host can encode | Source type **Live**. Speed holds **≥ 0.95x** after the first 15 s, sampled for at least 5 minutes |
| 4.2 | Same channel with `!tv` from TeamSpeak chat | Same as 4.1, and the stream is typed **Live** |
| 4.3 | Kill the provider connection (block the host or pull the network) | The stream stops as *source unreachable*, not a frozen picture, within about 10–20 s |
| 4.4 | Pick a preset the host cannot sustain (for example 2160p VP9 software) | After about 35 s the warning names the speed, preset, encoder and source type |
| 4.5 | Optional: `VIDEO_LIVE_PACING=source` on the sidecar | Stream still runs. Record the startup speed burst and steady-state speed for #72 |

## 5. Stopping and stop reasons

| # | Check | Expected |
| --- | --- | --- |
| 5.1 | Stream with no-viewer timeout 1 minute and no TS viewer (browser preview open) | Panel shows **Auto-stop in m:ss**. The stream stops after about 1 minute with *Stopped after 1 minute with no viewers*. The preview does not count as a viewer |
| 5.2 | A TS viewer joins during the countdown | The countdown clears. It restarts when the viewer leaves |
| 5.3 | Per-stream timeout override **Off** | No countdown. The saved default is unchanged |
| 5.4 | The bot's channel empties (`BOT_AUTO_STOP_EMPTY_SECONDS`) | Stops with the channel-empty reason |
| 5.5 | A downloaded clip ends | Stops as *source ended* |
| 5.6 | Stop the sidecar container while streaming | Stops with the sidecar-failure reason. Bot Hub shows it under the last stop |

## 6. One media session at a time

| # | Check | Expected |
| --- | --- | --- |
| 6.1 | Bot A plays music. Start a video on bot A from the UI | The *Replace what is playing?* dialog lists bot A's music. Confirm → music stops (*Replaced by video*), and the video starts |
| 6.2 | Bot A streams video. Play a URL, a library track, a radio station and an autoplay playlist on bot A from the UI | Each one asks first. Confirm → the video stops (*Replaced by music*) |
| 6.3 | Queue a playlist on bot A **without** autoplay while it streams | No dialog. The video keeps running |
| 6.4 | Bot A streams video. Start a video on bot B | The dialog names bot A's stream. Confirm → bot A stops as *Replaced by a stream on B* |
| 6.5 | Two browser tabs confirm replacing the same session at the same time | One start wins. The other gets a fresh dialog or a clear error, never two streams |
| 6.6 | Bot A streams video. `!play` on bot A in chat | Bot A's stream stops and music plays |
| 6.7 | Bot A streams video. `!stream` on bot B in chat | Refused with a message. Bot A keeps streaming |
| 6.8 | Start a replacement while the other session is still *starting* | Refused with *still starting*. Nothing stops |

## 7. Audit and privacy

| # | Check | Expected |
| --- | --- | --- |
| 7.1 | *Audit History* after sections 5–6 | Rows for music start/stop, video start/stop, source change, and session switch. Each switch has a stop row per replaced session (on the bot that lost it) with the same operation ID |
| 7.2 | Inspect those rows and the backend log | No full URLs, query strings, tokens, or IPTV credentials. Only the hostname or file name appears |
| 7.3 | Save global and per-server streaming defaults | `settings.video_streaming_update` rows. The server scope shows *Overrides: …* and *Use global defaults* clears them |

## 8. Long music across reconnects

| # | Check | Expected |
| --- | --- | --- |
| 8.1 | Play a long queue for at least 2 hours | No audio gaps or drift. Bot Hub stays current |
| 8.2 | Restart the TeamSpeak server during playback | The bot reconnects. Stopped music shows a server-disconnect or similar reason, not a stale *Playing* |
| 8.3 | Let the queue finish | Bot Hub shows *source ended*. The next play gets a new session (new start time) |
| 8.4 | Radio stream for at least 1 hour, then stop it | The ICY title updates while playing and stops updating after stop |

---

## Sign-off

| Area | Result | Host / client | Notes |
| --- | --- | --- | --- |
| 1 Codec matrix | | | |
| 2 VAAPI | | | |
| 3 Quality | | | |
| 4 Live IPTV | | | |
| 5 Stop reasons | | | |
| 6 Single session | | | |
| 7 Audit | | | |
| 8 Long music | | | |

Any **Fail** blocks the release PR unless the behavior is already documented as a known limitation in [Video streaming](../video-streaming.md) or the release notes.
