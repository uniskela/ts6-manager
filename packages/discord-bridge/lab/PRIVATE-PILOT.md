# Bridge-D1 private production-server pilot

**Prepared, not authorised to execute.** Experimental. Opt-in.

This compose talks to a **dedicated test channel** on an existing private TeamSpeak server. It does not create, stop or reconfigure that server. It does not modify TS6 Manager compose, volumes or databases.

Do not run `up --confirm` until the operator explicitly authorises that session.

## Image

After a maintainer-approved dispatch of the **main-branch** workflow `.github/workflows/publish-discord-bridge-private-beta.yml` (infrastructure PR; not this draft):

`ghcr.io/uniskela/ts6-manager/discord-bridge:private-beta-<full-sha>`

Pin the **digest** in `D1_BRIDGE_IMAGE`:

`ghcr.io/uniskela/ts6-manager/discord-bridge@sha256:<digest>`

Set `SOURCE_COMMIT` to that same full SHA. `private-pilot.sh` refuses a missing SHA and refuses a pulled image whose `org.opencontainers.image.revision` does not match.

Create GitHub environment `discord-bridge-private-beta` with required reviewers before the first publish. The workflow is `workflow_dispatch` only. It is not called from Release Please. No `latest`, no Docker Hub.

`D1_PILOT_ENV_FILE`, if set, must be the same file as `lab/.env.pilot` (the compose `env_file`). A different path is refused.

## First validation (disposable lab)

Use [`PRIVATE-BETA.md`](PRIVATE-BETA.md) and a local or GHCR image against `d1-ts-lab`. Do not use this pilot compose for that.

## Pilot commands (do not run until authorised)

```bash
# lab/.env.pilot mode 0600 from env.private-pilot.example
# D1_BRIDGE_IMAGE=ghcr.io/uniskela/ts6-manager/discord-bridge@sha256:…
# SOURCE_COMMIT=<full 40-character SHA from PR 504>
export D1_BRIDGE_IMAGE SOURCE_COMMIT
packages/discord-bridge/scripts/private-pilot.sh check
# packages/discord-bridge/scripts/private-pilot.sh pull
# packages/discord-bridge/scripts/private-pilot.sh up --confirm
packages/discord-bridge/scripts/private-pilot.sh status
packages/discord-bridge/scripts/private-pilot.sh stop
```

`stop` removes only `d1-private-pilot-bridge`. TeamSpeak stays up. Immediate stop is that command; `restart: "no"` and no published ports.

Rollback: `stop`, then set `D1_BRIDGE_IMAGE` to the previous digest and `up --confirm` if a new session is authorised.

## GO / NO-GO

| Decision | Verdict |
|---|---|
| Prepare files and workflow | **GO** |
| First supervised **production-server** session | **NO-GO** until monitoring, privacy and recovery checks pass on the disposable lab with the published digest, and the operator authorises that session |
| Unattended 24/7, public publish, merge #504, D2–D6 | **NO-GO** |
