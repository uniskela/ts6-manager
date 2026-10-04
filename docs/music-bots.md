# Media bots

TS6 Manager can run multiple TeamSpeak media bots per server. Each bot has independent playback, queue, and volume state.

## Bot Hub

**Automation → Bot Hub** (`/bot-hub`) is the list of media bots. Each card shows live connection/playback status, current media, channel, progress, volume, and, for video, quality, encoder, viewers, uptime, the no-viewer auto-stop countdown and last stop reason. Live status reads in-memory bot state; it does not probe the media sidecar or TeamSpeak Query.

Use **New bot** to create a bot with a single **Name**, used as both the admin label and TeamSpeak nickname. Names must be 3–30 characters; the web UI and API reject out-of-range nicknames before connecting. If the API request omits `nickname`, it uses `MediaBot`. Each card's settings menu provides **Edit bot**, **Start bot** or **Stop bot**, **Widget link**, and **Delete bot**. The same menu is available as **Bot settings** in the console header. Bots can reconnect automatically with exponential backoff and overlap protection.

![Bot Hub showing one playing bot and one idle bot](bot-hub.png)

A bot plays music **or** video, never both, and only one video stream runs at a time. See [Video streaming — one media session at a time](video-streaming.md#one-media-session-at-a-time).

## Bot console

Choose **Open console** on a Bot Hub card to open `/bot-hub/:botId`. **Now playing** shows that bot's current media and playback controls. **Up next** holds its music queue; use the drag handles to reorder with a mouse, touch or keyboard, play a queued item now, remove an item, or **Clear** the queue. With a keyboard, focus a drag handle, press Space to pick up, use the arrow keys to move, then press Space to drop or Escape to cancel.

![Bot console with Now playing, Up next and source tabs](musicbots.png)

Under **Play something**, choose a source:

- **Music** — Choose **Songs**, **Playlists**, or **Recent requests**; search songs by title or artist. The play button starts an item; the queue button adds it without interrupting playback.
- **Link** — Paste a supported URL and choose **Play as music** or **Stream as video**. For video, a filename can refer to a file already in the music folder; local music files play from **Music**. See [Video streaming](video-streaming.md).
- **Radio** — Search stations or filter by mood, then play a station. Moods come from each station's **Mood or genre** in **Media Library → Radio stations**.
- **IPTV** — Browse groups or search across playlists, filter by **Playlist**, and use **Favourites** or **Recent**. See [IPTV playlists](video-streaming.md#iptv-playlists).

If the bot is offline, the console offers **Start bot** before showing its sources. When a start conflicts with an active media session, **Replace what is playing?** lists what will stop. Choose **Keep playing** to cancel or **Stop and switch** to replace it.

Radio and video keep the music queue. **Play queue** resumes the upcoming songs, with the replacement prompt when needed; while radio or video plays and nothing is queued, **Up next** is hidden. Radio shows the station and live status rather than track progress or skip controls. Music controls include pause/resume, skip and volume; **Up next** also provides **Shuffle** and repeat modes.

## Media Library

**Automation → Media Library** (`/media-bots`) manages media shared by every bot on a server. Select the server, then choose one of its five tabs:

| Tab | Purpose |
|-----|---------|
| **Library** | Manage local/downloaded songs and media imports. |
| **Playlists** | Create and edit saved playlists. |
| **Radio stations** | Add stations manually, from built-in presets, or by searching [Community Radio Browser](https://www.radio-browser.info/), then edit name, stream URL and mood or genre. |
| **Requests** | Review `!play` history and replay or enqueue a request. |
| **Streaming defaults** | Set defaults for future streams and auto-stop chat notices. |

Use a bot's console to choose sources and control playback. Changes to video options in the console apply to that one stream; **Streaming defaults** stay as they are. The console's source lists offer 25, 50 or 100 items per page and remember the chosen size for each list.

Old links still work: `/music-bots` redirects to `/media-bots`; the old **Bots** tab goes to Bot Hub, and **Queue** with a bot ID goes to its console. **Video** with a bot ID goes to the console, otherwise to **Streaming defaults**. **Commands** goes to **Bot Flows → Chat commands**.

## Auto-stop chat notices

**Media Library → Streaming defaults → Announce auto-stops in chat** is enabled by default. When a bot stops music or radio because its channel is empty, it posts a line such as `Stopped the music: the channel was empty for 5 minutes.` or `Stopped radio: the channel was empty for 5 minutes.` Video auto-stops also explain an empty channel or lack of viewers, for example `Stopped the stream: nobody watched for 5 minutes.` The duration follows the configured timeout.

When the video no-viewer timeout is longer than 60 seconds, the bot warns one minute before stopping: `Nobody is watching. The stream stops in 1 minute.` A viewer joining cancels the warning timer and stop countdown. Timeouts of 60 seconds or less skip the warning. All notices use the existing TeamSpeak flood hold.

Turn **Announce auto-stops in chat** off and choose **Save defaults** to suppress both the warning and stop notices. Automatic stopping remains enabled. Video and IPTV use the notice setting saved when the stream starts; music and radio use the current setting when they auto-stop.

## Bot avatars

Open a bot's settings menu in Bot Hub or **Bot settings** in its console, choose **Edit bot**, and use **Avatar → Upload**, **Use default**, or **None**. Uploads accept PNG, JPEG or GIF images up to 200 KB, checked by image content. TeamSpeak 6 clients leave avatars larger than about 320×320 pixels blank, so the bot shrinks larger images to fit 300×300 (keeping the aspect ratio, and keeping GIF animation) before uploading them to TeamSpeak. This uses the `ffmpeg` already shipped in the images. Bot Hub and the console still show the original upload.

New bots created in the web UI use the bundled TS6 Manager app icon by default. Existing bots start with **None**. The chosen image appears on Bot Hub cards and in the console header, even when TeamSpeak refuses the upload. Bot Flows query clients do not use avatars.

The bot uploads and confirms its selected image whenever it connects or the avatar changes. Its TeamSpeak server group must allow file uploads. If TeamSpeak refuses an upload, the bot stays connected and settings show:

> TeamSpeak refused the avatar upload. Allow file uploads for the bot's server group, or choose None.

Choosing **None** clears the avatar and asks TeamSpeak to delete the uploaded file. If TeamSpeak refuses the deletion, the old file remains on the server without being displayed as the bot's avatar.

## Requests

**Media Library → Requests** (`/media-bots?tab=requests`) shows `!play` history for the selected server. **Play** starts that request immediately. **Enqueue** adds it to the queue without interrupting current playback. When several bots are running, pick the target bot. `/music-requests` redirects here. System → Music Request History is no longer a separate page.

## Sources

Music bots support:

- radio streams with ICY metadata;
- YouTube playback through yt-dlp;
- Spotify and Apple Music media resolution through the supported resolver path;
- local files and downloaded media; and
- saved playlists.

Local/downloaded tracks are decoded incrementally at media speed to keep memory use bounded on long tracks.

## Playlists

Playlists are shared by every media bot on the same TeamSpeak server. Create and edit them in **Media Library → Playlists**, then start or enqueue them from any bot's **Music → Playlists** view. Chat `!playlist` and `!pl` use the same server-wide list, including playlists created for another bot.

## Channel text commands

When a bot is connected to a configured command channel, users in that channel can use built-in commands.

- **`!help`** — Show built-in and custom commands
- **`!here [id]`** / **`!come [id]`** — Summon an idle music bot to your channel (or target a bot by ID)
- **`!commands`** — List enabled custom chat commands only
- **`!play <url>`** — Play supported media
- **`!play`** — Resume paused playback
- **`!queue [show|clear|remove <n>|play <n>|<url>]`** — Show or manage the queue
- **`!add <url>`** — Alias for adding to the queue
- **`!playlist [name-or-id]` / `!pl <name-or-id>`** — List or append a saved playlist
- **`!repeat [off|track|queue]`** — Show or set repeat mode
- **`!seek <seconds|+seconds|-seconds>`** — Seek within local/downloaded media
- **`!remove <text>`** — Remove one unambiguous upcoming match
- **`!shuffle [on|off]`** — Toggle or set shuffle
- **`!stop`** — Stop playback
- **`!pause`** — Toggle pause/resume
- **`!skip` / `!next`** — Advance the queue
- **`!prev`** — Previous track
- **`!vol [0-100]` / `!volume [0-100]`** — Show or set the bot volume. The same level is used for music, radio, video, and IPTV.
- **`!np` / `!nowplaying`** — Show the current track
- **`!radio [id]`** — List or play radio stations
- **`!stream <url> [preset]`** — Start a video stream. Without a preset, a YouTube or Twitch link starts at Auto quality (up to the Auto quality limit) and any other URL at the bot's stored preset (720p by default), because Auto opens the source once more to measure it; `auto`, `480p`, `720p`, `1080p`, `1440p` or `2160p` sets it
- **`!stopstream`** — Stop the active video stream
- **`!viewers`** — List stream viewers
- **`!channels [search]`** — List/search IPTV channels
- **`!tv <name>` / `!iptv <name>`** — Stream an IPTV channel
- **`!lyrics [artist - title]`** — Show/search lyrics

Custom chat commands are configured in **Bot Flows → Chat commands**, alongside the built-in list and clash warnings. See [Bot Flows](bot-flows.md).

### Custom command presets

**Bot Flows → Chat commands** can seed recommended server-scoped canned replies shared by every music bot on that connection:

| Command | Purpose |
|---------|---------|
| `!rules` | Server rules text |
| `!links` | Useful links (website, Discord, donate, …) |
| `!discord` | Discord invite (optional; can fold into `!links`) |
| `!info` / `!about` | Short community blurb |

Seeded presets start **disabled**. Edit the placeholder Markdown, then enable. `!commands` is a built-in that lists enabled customs (also shown under Custom in `!help`). Multiple bots on the same channel only send one informational reply (`!help` / `!commands` / customs) per user within a short cooldown.

## Download progress

Explicit library downloads run as bounded background jobs and can expose:

- current and total item counts;
- yt-dlp percentage;
- speed;
- ETA;
- processing state; and
- failure status.

Progress endpoints require an authenticated administrator, the matching server, and the requesting user. Jobs are kept in memory, capped, and expire automatically. A backend restart clears progress history.

## yt-dlp lifecycle

Production containers do not self-update yt-dlp.

The tool is installed at image build time and validated alongside FFmpeg, Node, and Deno. Deno (pinned in `.deno-version`) is the only yt-dlp JavaScript runtime configured for YouTube challenge solving (`--js-runtimes deno`). Image Node remains 20 for the Nest backend and is not an EJS fallback. To update the bundled extractor or Deno, pull a newer TS6 Manager image and recreate the container, or rebuild from a fresh image build.

Administrators can confirm the currently bundled yt-dlp (and related media tools) with the demand-driven Runtime / media check on Settings → YouTube or Media Library → Library. That check is not part of live bot status polling.

A public-video smoke test is intentionally not a release gate because media availability, rate limits, and regional restrictions are external to the project.
