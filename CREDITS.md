# Credits

This fork builds on the original [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager) project and community reports.

## Upstream project

- **Author / maintainer:** [@clusterzx](https://github.com/clusterzx) and contributors to `clusterzx/ts6-manager`
- **License:** MIT (see [LICENSE](../LICENSE))

## Community issues and pull requests reflected in this fork

Ideas, bug reports, and patches from the upstream tracker that informed or were adapted into this continued version:

| Upstream | Reporter / author | What we took |
|----------|-------------------|--------------|
| [Issue #30](https://github.com/clusterzx/ts6-manager/issues/30) / [PR #39](https://github.com/clusterzx/ts6-manager/pull/39) | [@dbillai](https://github.com/dbillai), [@s3bul](https://github.com/s3bul) | Strip TS3 `[URL]` BBCode from music `!play` / queue args |
| [Issue #37](https://github.com/clusterzx/ts6-manager/issues/37) / [PR #62](https://github.com/clusterzx/ts6-manager/pull/62) | [@Albirew](https://github.com/Albirew), [@BalconyJH](https://github.com/BalconyJH) | WebQuery connection test returns real errors / version |
| [Issue #54](https://github.com/clusterzx/ts6-manager/issues/54) / [PR #56](https://github.com/clusterzx/ts6-manager/pull/56) | [@BehaveDude](https://github.com/BehaveDude) | Tolerate unknown voice-protocol escape sequences (e.g. `\H`) |
| [Issue #49](https://github.com/clusterzx/ts6-manager/issues/49) / [Issue #75](https://github.com/clusterzx/ts6-manager/issues/75) | [@pimushkin](https://github.com/pimushkin), [@crtnbr](https://github.com/crtnbr) | Auto-rank online-time persistence |
| [Issue #78](https://github.com/clusterzx/ts6-manager/issues/78) | [@StEnDi78](https://github.com/StEnDi78) | SSH settings applied on connection edit + reconnect |
| [Issue #47](https://github.com/clusterzx/ts6-manager/issues/47) | [@LennBoedd](https://github.com/LennBoedd) | Music bot delete / lifecycle cleanup |
| [Issue #57](https://github.com/clusterzx/ts6-manager/issues/57) | [@Vman1194](https://github.com/Vman1194) | Clear queue also stops current playback |
| [Issue #67](https://github.com/clusterzx/ts6-manager/issues/67) | [@Lordeisenhelm](https://github.com/Lordeisenhelm) | Password UI aligned with backend 8+ policy |
| [Issue #80](https://github.com/clusterzx/ts6-manager/issues/80) | [@bufanda](https://github.com/bufanda) | Dependency / Trivy-driven upgrades |
| [Issue #79](https://github.com/clusterzx/ts6-manager/issues/79) | [@meauxh](https://github.com/meauxh) | Music library filesystem scan |
| [PR #66](https://github.com/clusterzx/ts6-manager/pull/66) | [@ValiOff8](https://github.com/ValiOff8) | Show bot ID on music bot cards |
| [Issue #77](https://github.com/clusterzx/ts6-manager/issues/77) | [@StEnDi78](https://github.com/StEnDi78) | Add/remove clients from server groups in UI |
| [Issue #63](https://github.com/clusterzx/ts6-manager/issues/63) | [@Slipi089](https://github.com/Slipi089) | AFK mover exempt channel IDs |
| [Issue #31](https://github.com/clusterzx/ts6-manager/issues/31) / [Issue #38](https://github.com/clusterzx/ts6-manager/issues/38) | [@D3nnis3n](https://github.com/D3nnis3n), [@Albirew](https://github.com/Albirew) | Offline client permissions + “modified only” filter |
| [Issue #44](https://github.com/clusterzx/ts6-manager/issues/44) / [PR #70](https://github.com/clusterzx/ts6-manager/pull/70) | [@vinookie](https://github.com/vinookie) | Spotify link → YouTube resolve (no native Spotify playback) |
| [Issue #46](https://github.com/clusterzx/ts6-manager/issues/46) | [@TheMaxik](https://github.com/TheMaxik) | `command_args_list` for flow chat commands |
| [Issue #68](https://github.com/clusterzx/ts6-manager/issues/68) / [Issue #59](https://github.com/clusterzx/ts6-manager/issues/59) | [@UIP88](https://github.com/UIP88), [@liqinghan2000](https://github.com/liqinghan2000) | Metadata / non-UTF8 tag handling helpers |
| [Issue #58](https://github.com/clusterzx/ts6-manager/issues/58) | [@KorppuJauho](https://github.com/KorppuJauho) | Radio station ID compact / reset |
| [Issue #42](https://github.com/clusterzx/ts6-manager/issues/42) | [@vinookie](https://github.com/vinookie) | Safer temp-channel creator template defaults |
| [Issue #36](https://github.com/clusterzx/ts6-manager/issues/36) | [@vinookie](https://github.com/vinookie) | yt-dlp auto-update on startup |
| [PR #72](https://github.com/clusterzx/ts6-manager/pull/72) / [PR #76](https://github.com/clusterzx/ts6-manager/pull/76) (reliability subset only) | [@coom](https://github.com/coom) | Connection-pool refresh / self-heal ideas (no Discord/SSO/i18n absorption) |
| [PR #64](https://github.com/clusterzx/ts6-manager/pull/64) | [@joaobosconff](https://github.com/joaobosconff) | All-in-one Docker image (nginx + backend + sidecar) + first-run login → setup redirect |

## Fork contributions

Ideas and patches cherry-picked from active community forks (all MIT-licensed). See [CHANGELOG.md](CHANGELOG.md) for release notes.

| Fork | Author | Commits / area | Adopted in uniskela |
|------|--------|----------------|---------------------|
| [coom/ts6-manager](https://github.com/coom/ts6-manager) | [@coom](https://github.com/coom) | Auth refresh single-flight, WebQuery boolean fixes, YouTube playlist import, Aug 2026 security review (RBAC, yt-dlp `--`, WebSocket scoping) | Phases 1–2, 4 |
| [uniplayer1/ts6-manager](https://github.com/uniplayer1/ts6-manager) | [@uniplayer1](https://github.com/uniplayer1) | Auto-stop when channel empty, TS3 2568 not fatal, video download-then-stream, volume slider, max duration UI, bot-flow docs | Phases 1, 3, 5 |

[joshii-h/ts6-manager](https://github.com/joshii-h/ts6-manager) shares the same author line as coom — credit @coom once; SAML/Discord work intentionally not absorbed.

Earlier upstream merges that remain in this tree (already present on `main` before the fork work) also credit community contributors such as [@GingerFury6](https://github.com/GingerFury6), [@LemDog](https://github.com/LemDog), and others via the original git history.

## Not absorbed (intentionally)

Large product expansions from [PR #76](https://github.com/clusterzx/ts6-manager/pull/76) (Discord bridge, SAML SSO/MFA suite, full multi-language UI) and related requests remain out of scope for this core-focused fork. See [docs/plans/opinionated-fork-roadmap.md](plans/opinionated-fork-roadmap.md).
