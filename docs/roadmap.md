# Roadmap

This fork intentionally stays focused on core TeamSpeak management rather than absorbing every upstream feature.

## Implemented phases

### Security baseline

Delivered controls include encrypted stored credentials, authenticated sidecar calls, internal-only media networking, SSRF protections, required production encryption keys, and security/release hardening.

### Reliability

Completed work includes WebQuery and SSH reconnection improvements, safer connection refresh behavior, bot fixes, and better error handling.

### Core quality of life

The fork added media-library improvements, bot and permissions UI refinements, safer temporary-channel behavior, automation improvements, and controlled yt-dlp lifecycle management.

### Video and restart reliability — v1.4.0

v1.4 focused on video-sidecar reliability, A/V synchronization, encoder tuning, stream timeouts, and cleaner shutdown/restart behavior.

### Music transport and memory reliability — v1.5.0

v1.5 improved TeamSpeak voice target resolution, bounded-memory local/downloaded playback, FFmpeg pacing, and reconnect overlap protection.

### TeamSpeak beta13 and safer operations — v1.6.0

v1.6 adds:

- authenticated beta13 compatibility testing;
- explicit guest-Query guidance;
- deterministic admin-key documentation;
- persistent per-flow temporary-channel ownership;
- playlist, repeat, seek, and remove chat controls;
- bounded yt-dlp download progress;
- queue/shuffle correctness fixes;
- pruned production Node runtimes; and
- a four-image Trivy gate for fixable HIGH/CRITICAL findings.

### Media session and streaming — v1.9.0

Published as [v1.9.0](https://github.com/uniskela/ts6-manager/releases/tag/v1.9.0) (Release Please [#198](https://github.com/uniskela/ts6-manager/pull/198)). [v1.9.1](https://github.com/uniskela/ts6-manager/releases/tag/v1.9.1) is the published ICE timeout and loopback NAT follow-up ([#202](https://github.com/uniskela/ts6-manager/issues/202)). [v1.9.2](https://github.com/uniskela/ts6-manager/releases/tag/v1.9.2) keeps watched video streams running through the channel-empty auto-stop ([#215](https://github.com/uniskela/ts6-manager/issues/215)), fixes preview retries reusing a stale connection ([#202](https://github.com/uniskela/ts6-manager/issues/202)), and prefers VP9 over AV1 for YouTube streams ([#226](https://github.com/uniskela/ts6-manager/pull/226)).

Shipped on `main` in [#192](https://github.com/uniskela/ts6-manager/pull/192) and [#199](https://github.com/uniskela/ts6-manager/pull/199).

- **Bot Hub** (Automation → Bot Hub) shows each bot's current track or stream, channel, video quality and encoder, viewer count, uptime, no-viewer auto-stop countdown, and last stop reason. It reads in-memory bot state only.
- One active media session: a bot plays music or video, never both, and only one video stream runs at a time across bots.
- **Auto** quality up to 2160p, plus VAAPI encode with software fallback of the same codec.
- Live versus on-demand source mode, with encode-health warnings when encoding stays below realtime.
- No-viewer auto-stop (default 5 minutes; the browser preview does not count as a viewer).
- **IPTV header → Local hosts** (administrators only) is an allowlist for LAN IPTV proxies (Threadfin, xTeVe, TVHeadend, and similar). It applies only to playlist refresh, IPTV-page starts, and `!tv`. When the egress proxy is enabled, the sidecar checks every ffmpeg hop against that list.
- Stream start reports a TeamSpeak refusal immediately, holds chat on antiflood error 524, and the sidecar keeps early ICE candidates until the viewer answers.
- [#204](https://github.com/uniskela/ts6-manager/pull/204) fixes Twitch live URL resolution and browser-preview ICE, with reverse-proxy notes.
- [#209](https://github.com/uniskela/ts6-manager/pull/209) renames the UI to Media Bots at `/media-bots` (`/music-bots` redirects) and adds encode profiles **Performance / Balanced / Quality**. Profile detail is in [Video streaming — Quality](video-streaming.md#quality).
- [#211](https://github.com/uniskela/ts6-manager/pull/211) adds **Media Bots → Requests** (`/media-bots?tab=requests`) for `!play` history. See [Media bots — Requests](music-bots.md#requests).
- WebRTC UDP mux ([#208](https://github.com/uniskela/ts6-manager/pull/208)) and the v1.9.1 ICE follow-up are already covered in [Video streaming](video-streaming.md), [Environment variables](environment-variables.md), [Reverse proxy](reverse-proxy.md), and [Troubleshooting](troubleshooting.md).

Operator detail: [Media bots — Bot Hub](music-bots.md#bot-hub) and [Video streaming](video-streaming.md).

### Bot console and shared media — v1.10.0

Merged on `main` for the upcoming 1.10.0 release; tracked in [#164](https://github.com/uniskela/ts6-manager/issues/164) and [#196](https://github.com/uniskela/ts6-manager/issues/196).

- **Bot Hub** is the bot list, with **Open console** for each bot. The console combines **Now playing**, **Up next** with mouse, touch and keyboard queue reordering, and **Music · Link · Radio · IPTV** sources.
- **Media Library** keeps **Library · Playlists · Radio stations · Requests · Streaming defaults**. Playlists are shared by all bots on a server; radio stations can be edited and filtered by mood in the console.
- **Bot Flows → Chat commands** holds custom replies, a read-only built-in command list and name clash warnings. Old media URLs redirect to their new destinations.
- IPTV adds groups, cross-playlist search, a playlist filter, **Favourites** and **Recent** shared by server. **Stream on…** selects a channel in a bot's console without starting it.
- Auto-stops post channel-chat notices, with a one-minute warning before a no-viewer video stop. **Announce auto-stops in chat** controls both.
- Bot avatars can use a custom image, the default or none, and are re-applied on reconnect. New UI-created bots use the default.
- Shared URL handling and the media page and chat-handler splits are merged. Streaming adds H.264 NVENC and an optional **Stream YouTube videos directly** switch; AMD homelab validation uses VAAPI.
- Channel banner images can be uploaded to Manager and used without a public image host ([#287](https://github.com/uniskela/ts6-manager/pull/287)).

IPTV country/language parsing, columns and filters (Task 12) remain a 1.10.x follow-up. Favourites/recent, avatars and the chat-handler split have merged and are included.

Operator detail: [Media bots](music-bots.md), [Bot flows](bot-flows.md), [Video streaming](video-streaming.md), [upgrade backup note](upgrading.md#upgrading-to-1100) and the [release-candidate smoke checklist](plans/164-1-10-0-rc-smoke.md).

## Follow-up direction

Planned work remains intentionally separated into dedicated changes.

### Observability and operations — v1.8

Tracked in [#91](https://github.com/uniskela/ts6-manager/issues/91). Acceptance evidence: [`docs/plans/91-slice-6-acceptance.md`](plans/91-slice-6-acceptance.md).

Shipped on `main`:

- optional TeamSpeak native metrics with authenticated WebQuery fallback;
- staged connection diagnostics (reachability, authentication, read permissions, virtual-server access);
- Server Logs 2.0 paging, filters, context labels, and honest refresh/interrupted states;
- bounded administrative audit and TeamSpeak activity journal (no secrets), with scope-safe pagination and capture status;
- demand-driven storage summaries and runtime/media probes (no permanent expensive polling); and
- action-local permission / compatibility guidance.

Appearance 1.8 ([#101](https://github.com/uniskela/ts6-manager/issues/101)) — backgrounds/motion and custom CSS with `?safe-ui=1` recovery — is shipped (#122 / #128).

v1.8.0 published in Release Please [#120](https://github.com/uniskela/ts6-manager/pull/120).

Metrics and diagnostics remain backend-mediated, access-controlled, and scoped to configured TeamSpeak servers. This is not a bundled monitoring stack or long-term time-series platform.

### Framework modernization

Future major upgrades may include newer React, Vite, Tailwind, React Router, TypeScript, Express, Prisma, Node, and pnpm generations. These should be upgraded deliberately rather than bundled into unrelated features.

### CI and dependency hygiene

Keep image scanning, base-image updates, dependency review, and dead-dependency cleanup current.

### Music and voice validation

Continue runtime testing for long-track memory use, seek/repeat/queue behavior, reconnects, and real-world media extraction changes.

### Streaming

Continue validating quality presets, source compatibility, and sidecar/media transport behavior against current TeamSpeak and browser versions.

## Explicit scope boundaries

The fork currently does not plan to adopt features that weaken the sidecar/encryption boundaries or turn TS6 Manager into a general container orchestrator.

Large unrelated suites such as Discord bridges, broad SSO absorption, or opportunistic framework migrations should remain separate decisions.
