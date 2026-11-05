# PR #601 — CI findings disposition (2026-11-05)

## Fixed in code (this batch)

| Source | Finding | Disposition |
|--------|---------|-------------|
| Repo hygiene | `docker-compose.media-fetcher.yml` validated alone → invalid project | **Fixed** — layered on `docker-compose.yml` like nvidia overlay |
| Sonar S5443 (high) | `world.mjs` wrote `/tmp/ca.crt` and read `/tmp/cross-target` | **Fixed** — private mkdtemp paths; validate-local discovers `/tmp/world-*` |
| Sonar S4036 (low) | openssl/ffmpeg via mutable PATH | **Fixed** — fixed absolute candidate paths |
| Sonar S1313 (low) | Hardcoded denylist CIDRs in `policy.mjs` | **Fixed** — moved to `reserved-networks.json` (still deny-by-default) |
| Sonar S5144 (medium) | SSRF taint into `http.request` in egress proxy | **Hardened** — request host is DNS-pinned IP only after allowlist + `net.isIP` check |
| CodeQL | Incomplete URL substring sanitization in smoke test | **Fixed** — hostname parse via `URL` |
| CodeQL | Missing rate limiting on test auth routes | **Fixed** — test limiter + production Discord interactions limiter |
| Sonar shell:S7688 | `[` vs `[[` in lab scripts | **Fixed** — converted flagged scripts |
| TypeScript CI | `!again` unavailable mark/reply never ran after `request.discard()` | **Fixed** — identity checks use `sameBot()` after discard; replies restored |
| TypeScript CI | `bot.stopAudio is not a function` on radio supersede in history fixture | **Fixed** — fixture provides `stopAudio`; production VoiceBot already had it |
| TypeScript CI | `!again` during `!radio` station lookup still started radio | **Fixed** — `beginChatMediaRequest` bumps intent; radio aborts lookup on intent change |
| Sonar S9383 (reply awaits) | Floating `context.reply` MAJOR reliability on shared voice code | **Fixed** — selected `queue.ts` / `playback.ts` replies use `void` (preserves prior fire-and-forget timing) |

## Manual disposition (do not weaken controls)

| Finding | Why leave / review |
|---------|-------------------|
| Residual Sonar S5144 on egress proxy | Proxy is a controlled allowlisted egress gateway (job token, host allowlist, port allowlist, DNS pin, path ASCII rebuild, private-net refusal). If S5144 remains after `sanitizeProxyPath` + `pinnedHttpRequest`, mark **Safe** in Sonar: “intentional media egress proxy with pinMediaAddresses”. |
| Residual S1313 if JSON still scanned | Denylist CIDRs are security controls aligned with `egress-policy.ts`. Prefer **False positive** / Safe over deleting denials. |
| Cognitive-complexity / nested-ternary smells | Maintainability only; not security. |
| Sonar S2699 on delivery tests | Likely false positive on assertion-heavy suites; re-check after reanalysis. |

## Not modified

- Production Discord application / global slash registration
- PR #504 / D1 lab infrastructure
- No rule suppressions (`NOSONAR`) added
