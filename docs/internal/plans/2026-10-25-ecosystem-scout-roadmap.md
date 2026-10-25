# TS6 Manager — ecosystem scout release triage (2026-10-25)

> **Planning only.** Source: 2026-10-25 read-only scout report of `uniskela/ts6-manager`, `clusterzx/ts6-manager`, issues/PRs and 48 forks. It reported 24 findings: 19 fork, one PR, four issue; 11 were partially present in this fork. Source SHAs below are abbreviated identifiers from that report, not independently verified patches. Re-check current `main` and source licenses/author attribution before any implementation.

**Primary tracker:** [ADHD #508](https://github.com/uniskela/ts6-manager/issues/508).
**Related implementation epics:** [#505 reliability](https://github.com/uniskela/ts6-manager/issues/505), [#506 post-1.12 maintenance](https://github.com/uniskela/ts6-manager/issues/506), [#507 future media/flows](https://github.com/uniskela/ts6-manager/issues/507).

## Release guardrails

1. **Do not alter #460 (v1.11.2)** or make feature commits until the owner resolves its release gate. Release Please can convert its version to 1.12.0 upon a `feat:` commit.
2. **Preserve v1.12.0 scope**: [#442](https://github.com/uniskela/ts6-manager/issues/442) listener remote and [#502](https://github.com/uniskela/ts6-manager/issues/502) Discord voice. Bridge-D1 [draft #504](https://github.com/uniskela/ts6-manager/pull/504) needs authorised live proof and independent approval; this scout does not change that.
3. **No forced version numbering.** 1.11.3 is a *candidate* only if 1.11.2 is released and another 1.11.x patch makes sense. 1.12.1/1.12.2/1.15/1.16 are grouping suggestions, not release promises.
4. **No blind fork imports**; independently reproduce, check current implementation, review security/compatibility, then use small PRs with original author/commit attribution.

## Release placement and gates

| Finding | Source pointer in scout | Candidate target | Decision and entry gate |
| --- | --- | --- | --- |
| F01 Duplicate SSH listeners | FeFoX `a9af5b1` | #505, 1.11.3 candidate | Reproduce command duplication/initial timeout; one active or pending listener per key, bounded retries |
| F02 Query flood/session improvements | KorppuJauho `9cbcfd7`, `9a07ec6`, `e944912`, `93535bf` | #506, 1.12.x | Only gaps beyond cooldown/session ownership; TS6 real-server timing and shutdown tests |
| F03 SSH host-key reset | KorppuJauho `4f8ae22` | #506, 1.12.x | Explicit admin-confirmed repin with both fingerprints; never accept changed host silently |
| F04 CUDA/NVENC GPU filtering | KorppuJauho `f343bd7` | #507, 1.15 candidate | Real NVIDIA validation/benchmarks in #463, unchanged VAAPI/software fallback |
| F05 Direct video / NACK / VP9 descriptor | FeFoX `0df550d`, `961ffc8` | #507, 1.16+ research | Codec/packet-loss/security feasibility; no wholesale 5k-line adoption |
| F06 Remote video seek/pause | FeFoX `961ffc8` | #507, 1.15 candidate | Supported on-demand sources only, per-source capability & cooldown |
| F07 YouTube PO-token provider | [clusterzx PR #83](https://github.com/clusterzx/ts6-manager/pull/83), related #82/#84 | #506, 1.12.x conditional | Demonstrated present-day 403s; latency, expiry, SSRF, licensing, subprocess audit |
| F08 Android client fallback | wellbritto98 `a07d7ff` | #506, 1.12.x conditional | Prove existing client rotation (including `android_vr`) misses the needed fallback |
| F09 Playback start race | vibesoftwarecoder `d489d46` | #505, 1.11.3 candidate | Failing concurrent play/queue test; retain stop/loop generations and queue continuation |
| F10 nginx backend DNS redeploy | wellbritto98 `a05a60d` | #505, 1.11.3 candidate | Backend redeploy + WebSocket/path smoke tests in split Compose |
| F11 TS permission `failed_permid` | wellbritto98 `26584b4` | #505, 1.11.3 candidate | Surface actionable ID without unbounded or sensitive error data |
| F12 Voice reconnect listener leak | Allin-Li `42c6566` | #505, 1.11.3 candidate | Targeted `off()` and repeated timeout/reconnect tests, never `removeAllListeners()` |
| F13 Upload 400/413 + UTF-8 | coom `2d68fd8` | #505, 1.11.3 candidate | Multer error maps + non-ASCII filenames and size/malformed tests |
| F14 React Router 7 | coom `28e19e2`, [uniskela #477](https://github.com/uniskela/ts6-manager/issues/477) | #506, 1.12.x | Independent security migration/SPA routing tests; do not bundle React Router 8 |
| F15 EOL checks + `govulncheck` | coom `ebddff8`, `09acbf9` | #506, 1.12.x | Add Go scan; warnings before hard EOL release gates |
| F16 Sidecar proxy | uniplayer1 `e1f1b68` | #506, 1.12.x conditional | Respect checking proxy [#479](https://github.com/uniskela/ts6-manager/pull/479) and isolated fetcher [#476](https://github.com/uniskela/ts6-manager/issues/476); no bypass |
| F17 Connection journal/GeoIP | kytos22 `7f8ecfb` | [#297](https://github.com/uniskela/ts6-manager/issues/297), 1.13 | Privacy defaults, retention, no raw IP analytics; optional offline country lookup |
| F18 Sidecar prefetch/loss/jitter | DomeNinchen `5c8fd56`, `607aba5`, `57cdfea` | #507, 1.15 candidate | Measure start time and per-peer stats; packet-loss display already exists since #394 |
| F19 Browser cookie refresh sidecar | wellbritto98 `b3f76b8` | Do not adopt | Unnecessary Chromium/noVNC/credential attack surface |
| F20 Admin AI tool gateway | wellbritto98 `c3bc7a9` | Do not adopt | Generic MCP/OpenAPI exceeds current scope; #303 separately governs trusted integrations |
| F21 Bot Flow loop node | [clusterzx issue #48](https://github.com/clusterzx/ts6-manager/issues/48) | #507, 1.15 candidate | Bounded iterations/nesting/execution, cancellation, engine + UI regression tests |
| F22 Whisper subscriptions | [clusterzx issue #32](https://github.com/clusterzx/ts6-manager/issues/32) | #507, 1.16+ research | TS6 packet and permission feasibility, privacy/opt-in, no release guarantee |
| F23 Video shuffle/repeat | [clusterzx issue #33](https://github.com/clusterzx/ts6-manager/issues/33) | #506, 1.12.x | Independent video-queue feature, stop/skip/reconnect verification |
| F24 Video preset and DASH verification | [clusterzx issues #53](https://github.com/clusterzx/ts6-manager/issues/53), [#69](https://github.com/clusterzx/ts6-manager/issues/69) | [#442](https://github.com/uniskela/ts6-manager/issues/442), 1.12.0 verification only | Real delivered-resolution and 1080p DASH test; separate fix only if failure reproduced |

## Existing roadmap compatibility

| Release / epic | Existing owner plan | Effect of this triage |
| --- | --- | --- |
| v1.11.2 #460 | Release PR still open | **No changes** |
| v1.12.0 #442 | Listener playlists, search, votes, standalone remote; R1/R2 security gates | **Unchanged**; F24 QA only |
| v1.12.0 #502 | Optional 5+1 Discord voice bridge, Bridge-K/D1–D6 gated | **Unchanged**; D1 still draft and lacks live evidence |
| v1.12.x #464 | PIN and installable remote, subject to approval | **Unchanged** and not bundled into #506 |
| v1.13.0 #297 | Community Insights/client history | F17 evaluated within existing privacy design |
| v1.14.0 #299 | Observe-only join protection, optional enforcement | **Unchanged**; F17 country enrichment not prerequisite |
| #463 | Native and Docker hardware tests | Required evidence before F04 support claims |
| #303 | Trusted external integration providers for Bot Flows | No automatic gateway or loop-node coupling |

## How to resume

1. Resolve v1.11.2 #460 independently. Then decide whether #505 targets 1.11.3 or the next viable patch.
2. For #505, start small: F01, F10–F13. Require a failing reproduction before F09.
3. Run F24 against real stream presets and 1080p DASH without expanding #442.
4. Post-v1.12.0, stage router #477 and CI F15 before experimental network/extractor work in #506.
5. Land F17 only within #297 privacy and retention controls; use #299 only for future join-protection decisions.
6. In #507, prioritize F04 hardware verification and F21 loop budgets before experimenting with F05/F22.
7. Cross-link actual implementation PRs in [#508](https://github.com/uniskela/ts6-manager/issues/508); mark findings complete only after tests and merge or a documented disposition.

## Attribution and non-goals

This plan does not import code, change dependencies, update the runtime, change Docker/SSRF policy, merge a PR, or authorise releases. Attribute source forks, PR authors and commits in their future implementation PRs; read-only scouting is not itself proof of compatibility. Scope exclusions still include SSO/SAML, full i18n, scheduled TS-container restarts, publishing sidecar `:9800`, relaxing sidecar secrets, and importing upstream PR #76's Discord implementation.
