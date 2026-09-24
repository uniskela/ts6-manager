# TS6 Manager documentation

TS6 Manager is a web-based management interface for TeamSpeak servers. This fork is an opinionated continuation of `clusterzx/ts6-manager`, focused on core TeamSpeak administration, reliability, security, music/video features, and automation.

The application uses TeamSpeak **WebQuery HTTP** for management operations. Optional authenticated SSH Query is used for features that need event or file-transfer access.

## Start here

- [Installation](installation.md) — deploy the split stack or all-in-one image
- [Install as an app](pwa.md) — iPhone/iPad, Android and desktop installation, updates and offline limits
- [Configuration](configuration.md) — required secrets, TeamSpeak connection setup, and application settings
- [Environment variables](environment-variables.md) — backend, frontend, and sidecar settings
- [Upgrading](upgrading.md) — update containers without losing credentials or database state

## Use TS6 Manager

- [Server management](server-management.md) — virtual servers, channels, clients, permissions, files, logs, and widgets
- [Music bots](music-bots.md) — queues, radio, local media, yt-dlp, chat commands, and progress jobs
- [Bot flows](bot-flows.md) — triggers, conditions, actions, variables, and temporary-channel ownership
- [Video streaming](video-streaming.md) — WebRTC sidecar and streaming behavior

## Deploy and operate

- [Reverse proxy](reverse-proxy.md) — Coolify and reverse-proxy deployment notes
- [Security](security.md) — security controls and deployment expectations
- [TeamSpeak compatibility](teamspeak-compatibility.md) — beta13 Query settings and compatibility testing
- [Troubleshooting](troubleshooting.md) — common connection, media, sidecar, and upgrade problems

## Project

- [Architecture](architecture.md) — service and package layout
- [Roadmap](roadmap.md) — implemented phases and public follow-up direction
- [1.8 acceptance evidence](plans/91-slice-6-acceptance.md) — #91 / #101 shipped-status vs demonstrated behavior

The source repository remains the canonical implementation. Hosted docs at [uniskela.com/docs/ts6-manager](https://uniskela.com/docs/ts6-manager/) are generated from these reviewed Markdown pages.
