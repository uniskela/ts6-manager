# Third-Party Provenance Notes

This file records where material in this repository came from and how external reports, patches, and fork implementations were incorporated.

It is a factual provenance and attribution record for maintainers. It is not a legal opinion, does not assign motives to external authors, and does not make claims about the present-day licensing of external repositories beyond the specific evidence noted below.

The licence for this repository is in [LICENSE](LICENSE). Existing copyright history and notices from the original project and contributors are also preserved through Git history and [CREDITS.md](CREDITS.md).

## Provenance categories

We use three descriptions deliberately:

- **Inherited** — code already present in the project history this fork was created from.
- **Adapted** — implementation details or source code from another revision were intentionally used and then integrated into this fork.
- **Informed by** — an issue, bug report, finding, or feature request influenced an implementation, without implying that the reporter's source code was copied.

These categories should not be used interchangeably.

## Original upstream project

uniskela/ts6-manager was created as a continuation of [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager).

- Fork base reviewed during this provenance audit: [dd26e57](https://github.com/clusterzx/ts6-manager/commit/dd26e57954feca794fcceac0fb982243897d9114)
- The upstream README at that revision designated the project as **MIT**.
- This repository's [LICENSE](LICENSE) retains attribution to clusterzx and contributors of the original project.

Earlier upstream contributors remain credited through the inherited Git history. [CREDITS.md](CREDITS.md) additionally calls out community issues and pull requests that materially informed later work in this continuation.

## Community reports and upstream pull requests

The table in [CREDITS.md](CREDITS.md#community-issues-and-pull-requests-reflected-in-this-fork) records issue reporters and pull-request authors whose reports, findings, or patches influenced this fork.

An issue reference by itself should be read as **informed by**, not as a claim that the issue author's code was copied. Where an external implementation was directly adapted, the fork/source is recorded separately below or in the associated Uniskela pull request.

## Fork implementation provenance

The following entries cover the major fork-derived implementations currently documented in this repository.

| Source | Incorporated through | Material | Licence/provenance evidence recorded |
|---|---|---|---|
| [coom/ts6-manager](https://github.com/coom/ts6-manager) | Uniskela [PR #10](https://github.com/uniskela/ts6-manager/pull/10), later PR #28 work | Auth refresh, WebQuery fixes, security hardening, playlist import, lyrics and related fixes | PR #10 contemporaneously records the adoption as under MIT terms; the public fork README also designates MIT. Exact external source SHAs were not reconstructed in this audit. |
| [uniplayer1/ts6-manager](https://github.com/uniplayer1/ts6-manager) | Uniskela [PR #10](https://github.com/uniskela/ts6-manager/pull/10) | Video download-then-stream, channel-empty auto-stop, media controls/limits and related work | PR #10 contemporaneously records the adoption as under MIT terms; the public fork README also designates MIT. Exact external source SHAs were not reconstructed in this audit. |
| [kytos22/ts6-manager](https://github.com/kytos22/ts6-manager) | Uniskela [PR #28](https://github.com/uniskela/ts6-manager/pull/28) | Client avatars/voice state and per-channel file summaries | PR #28 records the source and attribution; the public fork README designates MIT. |
| mqh9007/ts6-manager | Uniskela [PR #28](https://github.com/uniskela/ts6-manager/pull/28) | Music-bot status refresh, client IP/status visibility, Settings About/version | PR #28 and CREDITS preserve the historical source attribution. The source repository no longer publicly resolves, so its historical licence text could not be independently re-verified during this audit. Do not make new direct imports from this source unless an archived revision and its terms can be verified. |
| [simardwtf/ts6-manager](https://github.com/simardwtf/ts6-manager) | Uniskela [PR #28](https://github.com/uniskela/ts6-manager/pull/28) | IPTV/M3U support | PR #28 records the source and attribution; the public fork README designates MIT. |
| [prankroker/ts6-manager](https://github.com/prankroker/ts6-manager) | Uniskela [PR #28](https://github.com/uniskela/ts6-manager/pull/28) | YouTube stream-first playback ideas/implementation | PR #28 records the source and attribution; the public fork README designates MIT. |
| [DomeNinchen/ts6forkmanager](https://github.com/DomeNinchen/ts6forkmanager) | Uniskela [PR #30](https://github.com/uniskela/ts6-manager/pull/30), merged 2026-09-11 | Condition-expression hardening, video/sidecar tuning, SSH teardown guards, ServerQuery visibility, preview controls and timeout work | The external README at [12705a4](https://github.com/DomeNinchen/ts6forkmanager/commit/12705a4b18eb53586ca9f966f7b65c300684e251) on 2026-09-10 designated the project as MIT immediately before the Uniskela adoption. This record intentionally describes the source state observed at incorporation and makes no statement about later external licensing changes. |
| [bro-network/ts6-manager](https://github.com/bro-network/ts6-manager) | Uniskela [PR #41](https://github.com/uniskela/ts6-manager/pull/41) | Resolve TeamSpeak UDP target once per connection | Source commit [49abef5](https://github.com/bro-network/ts6-manager/commit/49abef5); the README at that exact revision designated MIT. The implementation was reworked around this fork's existing transport seam. |
| [bro-network/ts6-manager](https://github.com/bro-network/ts6-manager) | Uniskela [PR #42](https://github.com/uniskela/ts6-manager/pull/42) | Incremental local playback and reconnect-state ideas | Source commit [11bb242](https://github.com/bro-network/ts6-manager/commit/11bb242); the README at that exact revision designated MIT. The implementation was substantially adapted for bounded buffering, FFmpeg pacing, and the current playback architecture. |
| [LgnRorooo/ts6-manager](https://github.com/LgnRorooo/ts6-manager) | Uniskela [PR #55](https://github.com/uniskela/ts6-manager/pull/55) | Playlist/repeat/seek/remove controls and download-progress ideas | Source commit [4c734a6](https://github.com/LgnRorooo/ts6-manager/commit/4c734a62ec65f28a96b134ff56e24bb2b091e773); the README at that exact revision designated MIT. The implementation was selectively adapted to this fork's server/user scoping and playback architecture. |

The purpose of the final column is to record the evidence relied on when the material was incorporated. It is not a general statement about every revision or the current licensing of those external projects.

## Reverted or non-current external work

Some external work may remain visible in Git history without being part of the current net source tree.

For example, Uniskela PR #45 selectively adapted a media-header transport change from upstream clusterzx/ts6-manager PR #83. Uniskela PR #49 later reverted that change. Historical commits and their attribution remain in Git history, but the reverted implementation is not treated as a current third-party component here.

## Material intentionally not absorbed

Reviewing another fork or pull request does not mean its code was incorporated.

Large Discord/SAML/i18n work from upstream PR #76 and other deferred changes listed in the project roadmap were intentionally not absorbed. CREDITS and individual pull requests should continue to say when only a subset or an idea was used.

## Maintainer provenance policy

For future external work:

1. Prefer an exact source commit, tag, or pull-request revision.
2. Record the external author/source and what was actually incorporated.
3. Record the licence designation or other permission evidence observed for that source revision before adapting source code.
4. Use **informed by** for issue reports, findings, and independently implemented ideas; use **adapted from** when implementation/source material was actually used.
5. Preserve notices and attribution required by the applicable source terms.
6. Do not directly import code when the source terms are unknown or appear incompatible; resolve provenance first.
7. If an external source later changes its licensing, keep this record tied to the revision actually reviewed rather than rewriting history around the source's current state.
8. Keep licensing-policy changes for this repository separate from routine attribution/provenance updates.

## Scope of this file

This file records **inputs into this repository**. It intentionally does not catalogue or characterize downstream projects that reuse TS6 Manager. Keeping those questions separate avoids turning a maintainer attribution record into a dispute log.
