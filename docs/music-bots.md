# Music bots

TS6 Manager can run multiple TeamSpeak music bots per server. Each bot has independent playback, queue, and volume state.

The Bots view shows live connection/playback status, current media, progress, volume, queue context, and normal playback controls without exposing provider credentials.

![Populated Music Bots view](musicbots.png)

## Sources

Music bots support:

- radio streams with ICY metadata;
- YouTube playback through yt-dlp;
- Spotify and Apple Music media resolution through the supported resolver path;
- local files and downloaded media; and
- saved playlists.

Local/downloaded tracks are decoded incrementally at media speed to keep memory use bounded on long tracks.

## Playback controls

The web UI supports queue management, pause/resume, skip, previous, shuffle, repeat, seek, and volume.

Bots can reconnect automatically with exponential backoff and overlap protection.

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
- **`!vol [0-100]` / `!volume [0-100]`** — Show or set volume
- **`!np` / `!nowplaying`** — Show the current track
- **`!radio [id]`** — List or play radio stations
- **`!stream <url>`** — Start a video stream
- **`!stopstream`** — Stop the active video stream
- **`!viewers`** — List stream viewers
- **`!channels [search]`** — List/search IPTV channels
- **`!tv <name>` / `!iptv <name>`** — Stream an IPTV channel
- **`!lyrics [artist - title]`** — Show/search lyrics

Custom chat commands can also be configured.

### Custom command presets

Music Bots → **Commands** can seed recommended server-scoped canned replies shared by every music bot on that connection:

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

The tool is installed at image build time and validated alongside FFmpeg and Node. To update the bundled extractor, pull a newer TS6 Manager image and recreate the container, or rebuild from a fresh image build.

Administrators can confirm the currently bundled yt-dlp (and related media tools) with the demand-driven Runtime / media check on Settings → YouTube or Music Bots → Library. That check is not part of live bot status polling.

A public-video smoke test is intentionally not a release gate because media availability, rate limits, and regional restrictions are external to the project.
