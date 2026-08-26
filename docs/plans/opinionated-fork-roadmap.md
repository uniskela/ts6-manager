# Opinionated TS6 Manager Fork Roadmap

Continuation of `clusterzx/ts6-manager` as `uniskela/ts6-manager` — **core-focused** (no Discord/SSO/full i18n absorption).

## Phases

1. **Security baseline** — `expr-eval-fork`, dependency bumps, sidecar `SIDECAR_SECRET` auth, internal-only `:9800`, SSRF DNS fail-closed, required `ENCRYPTION_KEY` in production, LICENSE/SECURITY, fork rebrand, password UI alignment.
2. **Reliability** — BBCode URL strip, unknown escape tolerance, WebQuery test errors, auto-rank persistence, SSH reconnect on edit, music bot delete/clear-queue fixes, connection pool tear-down on refresh.
3. **Core QoL** — library filesystem scan, bot ID badges, server group membership UI, Spotify→YouTube resolve, AFK exempt channels, offline client permissions + modified-only filter, metadata encoding helpers, radio ID compact, `command_args_list`, safer temp-channel template, yt-dlp auto-update on startup.

See upstream issue/PR triage in the agent plan for explicit skip list.
