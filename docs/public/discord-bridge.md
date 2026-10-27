# Discord bridge

The Discord voice bridge is **not** a released TS6 Manager feature. It is not in stable `v1.11.2`, it is not in manager beta images, and it is not a published container.

TS6 Manager remains an opinionated continuation of [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager). This page describes status only so testers do not confuse laboratory work with a product.

## Released

Stable TS6 Manager (`v1.11.x`) has no Discord voice integration. There is nothing to install for Discord on a production host.

## Manager beta

[Beta releases](beta.md) publish the same four manager images (backend, frontend, sidecar, all-in-one) from a later commit. They still do not start a Discord bot and do not accept Discord tokens. Do not add a Discord service to `docker-compose.beta.yml`.

## Bridge-D1 laboratory

A laboratory (`packages/discord-bridge`) lives on draft PR [#504](https://github.com/uniskela/ts6-manager/pull/504) and is not on `main`. It can join one Discord voice channel and one TeamSpeak channel for fail-closed DAVE / audio experiments.

That program is not a deployment contract:

- the lab image default command is a dependency smoke; live runs are stdin/stdout, not an HTTP service
- it does not listen on a published port
- secrets stay in an operator-supplied env file that is gitignored
- evidence JSON is local and must not be committed or attached to issues
- Discord tokens, guild ids, and TeamSpeak addresses must never appear in docs, PRs, or logs you share

Do not rename the laboratory image and treat it as preview or production. A standalone GHCR/Docker Hub “bridge preview” is **NO-GO** until a later phase ships a runtime that has a supported start/stop API, documented secret handling, health checks, and a compose contract. SHA tags used on a lab host stay on that host.

Setup, permissions, and troubleshooting for a live lab run belong in that package’s README and are operator-only. This site does not reproduce them.

## Planned D2–D6

Later phases (setup UI, persistence, manager integration, and a supported operator workflow) are planned work. They are not available in beta images and are not scheduled by this page. Until those phases land and pass review, the manager and the laboratory remain separate products.

## Security

- Use a private testing Discord guild and the smallest bot permissions the lab README lists. Do not add the bot to a public guild.
- Use a disposable TeamSpeak server. Do not use a production TeamSpeak server.
- If a token or address appears in a log, rotate the token and treat the log as secret.

If you came here looking for a installable Discord bridge, stop. Use [Installation](installation.md) for TS6 Manager, and [Beta releases](beta.md) only for manager prereleases.
