# Community beta strategy for v1.12.0 (internal)

**Status:** Planning only. No publish, public connect, #609 merge, or Bridge-K amendment from this document.  
**Owner constraint:** Full v1.12.0 scope retained (Bridge D1–D6 5+1, Commands & Radio, Listener Remote, security gates). Cannot rely on four personal friends for D1 A–D. Prefer community volunteers, then an opt-in public beta.  
**Continuity:** [#648](https://github.com/uniskela/ts6-manager/issues/648). Related: [#504](https://github.com/uniskela/ts6-manager/pull/504), [#563](https://github.com/uniskela/ts6-manager/pull/563), [#601](https://github.com/uniskela/ts6-manager/pull/601), [#609](https://github.com/uniskela/ts6-manager/pull/609).

## What already exists (D1 lab)

| Piece | Role | Trust / gate |
|-------|------|----------------|
| `lab/ACCEPTANCE.md` | Operator stdin marks for A–D | Evidence only; NO-GO until all four PASS |
| `lab/PRIVATE-BETA.md` | Restricted private-beta runtime on **disposable** `d1-ts-lab` | Phase 1 supervised **GO**; public / unattended / merge / publish **NO-GO** |
| `lab/PRIVATE-PILOT.md` | Same image class against a dedicated channel on an **existing** private TS | Prepared; first production-server session **NO-GO** until disposable-lab recovery + monitoring pass |
| `scripts/private-beta.sh` / `private-pilot.sh` | check / build / up `--confirm` / status / stop / rollback | Presence prints SET/MISSING only; `restart: "no"`; no published bridge ports |
| Host `host-status.json` | Privacy-safe health (`ok` / `degraded` / `parked` / `fail-closed` / `stale`) | No usernames, uniqueIds, tokens, audio |
| GHCR workflow on `main` | `publish-discord-bridge-private-beta.yml` + [trust model](../discord-bridge-private-beta-publish.md) | Manual dispatch; private package; reduced-trust; **not** Release Please; do not dispatch without maintainer + environment approval |
| One-person live smoke | Bidirectional DAVE smoke PASS | Not A–D |

**Do not confuse:** private-beta usage counters ≠ A–D mark evidence. Private-pilot ≠ public beta. GHCR private-beta tag ≠ stable `v1.12.0` image.

## Recruiting volunteers for A–D (without distributing the unfinished bridge)

### Principle

Volunteers bring **TeamSpeak and Discord clients only**. The unfinished Node 24 bridge, tokens, and `lab/.env` stay on **operator-controlled** hosts. No volunteer needs production TS6 Manager, production TeamSpeak, or GHCR pull access for A–D.

### Session model: “Community lab night”

1. **Operator** runs disposable `d1-ts-lab` + private Discord **test guild/channel** (not production Uniskela app; not production TS).
2. Publish a short call for testers (Discord/forum/GitHub Discussion) with consent text below.
3. Schedule a **supervised** window (operator present entire time).
4. Volunteers join via **private path only** (existing Tailscale / invite-only Discord / one-time TS password for the disposable lab). No wild public `0.0.0.0` TS advertise for acceptance.
5. Run A–D per `ACCEPTANCE.md` (or serialize across nights if fewer than four people).
6. Collect counters + operator-attested hear notes only. Volunteers file bugs with the privacy template below.

### Concurrent humans (hard floor)

| Scenario | Concurrent roles | Can serialize? |
|----------|------------------|----------------|
| A | 2 TS speakers + 2 Discord listeners | No (must speak simultaneously) |
| B | 2 Discord speakers + ≥1 TS listener | No (simultaneous Discord speech) |
| C | 1 Discord talker through kill | Yes |
| D | 1 established + 1 join/leave | Mostly (two people) |

**Minimum for A in one sitting: four people.** With community volunteers that is realistic; with one operator alone it is not. Same people may cover B later the same night by swapping rooms (nobody in both rooms during a single scenario).

### What volunteers receive

- Calendar invite + join instructions for disposable TS + private Discord test voice channel.
- Headset requirement; “do not sit in both rooms during A/B”.
- Consent / disclosure blurb (below).
- Bug report template (below).

### What volunteers must **not** receive

- Bot tokens, `lab/.env`, GHCR credentials, production hostnames, raw logs, audio recordings.
- Unpublished bridge images (unless a later, separately approved pilot uses digest-pinned private GHCR for **operators only**).
- Ability to Start the bridge themselves.

## Consent, disclosure, privacy-safe reporting

### Disclosure (show before join; repeat in channel)

> This is an **experimental** Discord ↔ TeamSpeak voice bridge under active development. Audio from the mapped Discord voice channel and TeamSpeak channel is processed by operator-run software and may be delayed, drop, fail closed, or stop without notice. Do **not** share secrets, personal data, or illegal content. Sessions may be stopped immediately. This is not a production service. Participation is voluntary and unpaid.

### Consent checklist (operator records yes/no only — no PII in repo)

- [ ] Volunteer is 18+ (or guardian consent per local law — operator policy).
- [ ] Read disclosure; agrees audio crosses platforms.
- [ ] Agrees not to record/redistribute other participants’ audio without their consent.
- [ ] Knows how to leave and how to signal stop.
- [ ] Knows bug reports must omit tokens, IPs, exact usernames if not essential, and never attach `.env` / raw logs / audio.

### Privacy-safe bug template

```text
Scenario: A / B / C / D / other
Time (UTC):
What you expected:
What you heard / did not hear (no audio files):
Approx duration before issue:
Client: Discord desktop/web / TeamSpeak version (no IPs)
Counters (if operator pastes): daveReady / duplicateReceivers / framesSent — redacted only
```

## Gates before a **public, opt-in** bridge pre-release

All required. None are satisfied by Sonar QG alone.

| # | Gate | Owner |
|---|------|--------|
| 1 | D1 A–D LIVE PASS with evidence on a known SHA | Operator + volunteers |
| 2 | Independent security/lifecycle review of that SHA | Independent reviewer |
| 3 | Disposable-lab Phase 1+2 private-beta recovery observed live (`PRIVATE-BETA.md`) | Operator |
| 4 | Bridge remains **disabled by default**; no ports on worker; DAVE fail-closed; token redaction | Engineering |
| 5 | Secrets: write-only tokens, encrypted at rest once D2 lands; GET never returns secrets | Engineering |
| 6 | Emergency stop: documented `stop` / compose down / revoke Discord tokens / leave mapped channels | Operator |
| 7 | Monitoring: `host-status.json`-class health only for shared dashboards; no audio/PII | Engineering |
| 8 | Rollback: previous image digest/tag recorded; `restart: "no"` until recovery approved | Engineering |
| 9 | Legal/comms: disclosure in UI + channel; beta ToS/privacy pointer; age policy | Owner |
| 10 | P10 disposition + additional v1.12.0 security workstream + P1-A/P1-B independent review | Security |
| 11 | Commands & Radio: no global slash on production app; guild-only INT-TEST until approved | Engineering |
| 12 | Explicit owner GO for any GHCR visibility change, public invite, or prerelease tag | Owner |

**Still NO-GO for public beta:** unfinished A–D, distributing unfinished worker without D2 packaging + default-off, production TS as the acceptance lab, merging #609 as stable `v1.12.0`.

## Implemented vs still to build (Bridge)

| Stage | Implemented today | Still required |
|-------|-------------------|----------------|
| **D1** | Isolated package, 5+1 runtime, DAVE fence, lab + private-beta + private-pilot scripts, evidence harness, reduced-trust GHCR workflow on `main` | A–D LIVE PASS; post-PASS security review; merge `#504` as `chore:` only after GO |
| **D2** | Draft contract decisions in `#563` (not applied) | Apply Bridge-K D2 text after owner GO; Node 24 official `Dockerfile.discord-bridge`; compose profile `discord-bridge` default-off; encrypted token store; Prisma identity gen; first-wins lease; Start/Stop API + bearer secret |
| **D3** | Slot router / nick rules in lab | Persistent `uniqueId→slot` in product control plane; rename/reconnect hold; nick rate-limit behaviour in shipped worker |
| **D4** | Overflow mixer in lab | Product overflow idle/`[TS] Others` presence rules proven in D6 matrix |
| **D5** | Plan doc only (`bridge-d5-setup-wizard`) | Admin UI: six apps, invites, mapping, profile hint, write-only tokens, disclosure, Start/Stop, redacted diagnostics |
| **D6** | Contract matrix empty | Real TS6 + Discord desktop (+ claimed consoles); failover; idle overflow; both directions; recovery; CPU/RSS; no plaintext fallback |
| **Presence-1** | Gated on Prisma identity | Separate lane after D2 identity persistence |
| **Commands & Radio** | Draft `#601` (CONFLICTING w/ tip) | Reconcile `main`; full-registry supervised live; no production global register |
| **Listener Remote** | On `main`; C5/C6/F2–F7 owner PASS | Broader release matrix still open |

Do **not** shrink 5+1 to a single-bot public beta.

## Fastest dependency-safe path to a usable public beta

Keep architecture; compress calendar by parallelising non-blocked work.

```text
Now          Community volunteer A–D nights (operator-hosted lab)
             ║  rebuild ts6-discord-bridge-lab for tip SHA
             ║  docs: volunteer call + consent (this plan)
             ▼
D1 GO        A–D PASS → independent security/lifecycle review → merge #504 (chore)
             ║  parallel: reconcile Commands #601; finish security workstreams
             ▼
D2 MVP       Official worker image + compose profile default-off + encrypted tokens
             + Start/Stop + lease (no D5 polish required for first opt-in)
             ║  apply #563 only with owner GO
             ▼
Beta cut     git prerelease / GH prerelease `v1.12.0-beta.1` (experimental label)
             ║  NOT #609 stable merge; NOT `latest` stable
             ║  bridge profile off; disclosure in UI/docs; private or carefully limited GHCR
             ▼
Opt-in beta  Volunteers enable profile + mapping on **their** disposable/test stacks
             ║  emergency stop + rollback digests published
             ▼
D3–D5 polish Persistent slots, overflow product rules, admin wizard
             ▼
D6 + stable  Full matrix → curate #609 → owner GO → `v1.12.0`
```

**Why this is fastest without cheating:** A–D cannot be skipped; community volunteers remove the “four friends” bottleneck. D2 packaging is the first shippable default-off surface. D5 wizard can lag the first opt-in beta if operators follow documented CLI/compose onboarding (Bridge-K still requires the admin page before **stable** D6/release — track that as beta→stable gap, do not delete the requirement).

### `v1.12.0-beta.1` shape (when authorised)

- Label: **experimental**, **opt-in**, **disabled by default**.
- Includes: Listener Remote (as on tip), Commands & Radio (once accepted), bridge worker behind compose profile / unset URL.
- Excludes: claiming D6 complete; production Discord global commands; `latest` stable tags.
- Release Please `#609` stays open for the eventual stable cut; beta uses an explicit prerelease path approved separately (do not merge `#609` to mint beta).

## Monitoring, rollback, emergency shutdown

| Control | Action |
|---------|--------|
| Monitor | `private-beta.sh status` / `host-status.json`; alert on `fail-closed`, duplicate receiver, process exit |
| Soft stop | `private-beta.sh stop` or product Stop; confirm bots leave voice |
| Hard stop | Compose down; revoke/regenerate Discord bot tokens; remove guild invites; stop disposable TS |
| Rollback | Prior local SHA (`private-beta.sh rollback`) or prior GHCR digest for pilot |
| Incident | No audio/PII in public issues; open private maintainer channel; pause invites |

## Immediate next development task

1. **Rebuild** local lab image for `#504` tip (`46ce40c9` or current HEAD) and confirm `d1-ts-lab.sh start` + presence SET/MISSING (no `--confirm`).
2. **Publish a volunteer call draft** (text only — owner posts) + schedule first **Community lab night** aimed at scenario **A**.
3. Keep `#609` / public GHCR dispatch / Bridge-K edits blocked until explicit GO.

Do not start live A–D, publish images, or open public TS from this plan alone.
