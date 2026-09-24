# Changelog

All notable changes to this opinionated fork of [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager) are documented here. See [CREDITS.md](CREDITS.md) for upstream and fork attribution.

## [1.8.0](https://github.com/uniskela/ts6-manager/compare/v1.7.1...v1.8.0) (2026-09-24)


### Features

* add !here chat command to summon music bots ([#112](https://github.com/uniskela/ts6-manager/issues/112)) ([bdcbaf3](https://github.com/uniskela/ts6-manager/commit/bdcbaf3516cb4b886e87e3019133af7cc2964b24))
* add IPTV playlist file upload ([#109](https://github.com/uniskela/ts6-manager/issues/109)) ([9778db1](https://github.com/uniskela/ts6-manager/commit/9778db15b803cc82d45a5522042be1842e91b535))
* add journal/audit column headers and audit live refresh ([#140](https://github.com/uniskela/ts6-manager/issues/140)) ([f01c407](https://github.com/uniskela/ts6-manager/commit/f01c407833a1369cde2795432fb8c42951602d02))
* add music-bot chat command presets ([#119](https://github.com/uniskela/ts6-manager/issues/119)) ([599edb3](https://github.com/uniskela/ts6-manager/commit/599edb3447d71d81204b8ee5242ada98973cf327))
* administrative audit log ([#134](https://github.com/uniskela/ts6-manager/issues/134)) ([168e820](https://github.com/uniskela/ts6-manager/commit/168e82042833cbd42841bd0d0d90d2d5e0b21740))
* appearance backgrounds and motion ([#122](https://github.com/uniskela/ts6-manager/issues/122)) ([d11065f](https://github.com/uniskela/ts6-manager/commit/d11065fa9c4d5715c8d9cd5aa820c33db6283010))
* audit channel group and permission actions ([#135](https://github.com/uniskela/ts6-manager/issues/135)) ([89c0aef](https://github.com/uniskela/ts6-manager/commit/89c0aefbc8fa97ef4e980c990a5e5fbfd4198ae7))
* bootstrap local pr-test stack with beta13 TeamSpeak ([#116](https://github.com/uniskela/ts6-manager/issues/116)) ([6abafe2](https://github.com/uniskela/ts6-manager/commit/6abafe2f81a309f1bdfe06b82abdef701b4bdbc4))
* brand status widgets and link to GitHub ([#131](https://github.com/uniskela/ts6-manager/issues/131)) ([a91fcb8](https://github.com/uniskela/ts6-manager/commit/a91fcb810e8b81d9b63bfc78feb21b542de097f8))
* custom CSS and safe-ui recovery (appearance part B) ([#128](https://github.com/uniskela/ts6-manager/issues/128)) ([2ff7736](https://github.com/uniskela/ts6-manager/commit/2ff7736ef514d8eee67ba5cbd8a73a08518fdd04))
* native TeamSpeak metrics scrape (slice 1) ([#126](https://github.com/uniskela/ts6-manager/issues/126)) ([0f0cbf4](https://github.com/uniskela/ts6-manager/commit/0f0cbf46d871308ea0891893e9270e79fefe72fa))
* server logs 2.0 paging and context ([#132](https://github.com/uniskela/ts6-manager/issues/132)) ([e01d024](https://github.com/uniskela/ts6-manager/commit/e01d024a398c25308f3a7234872000523718e6c1))
* staged TeamSpeak connection diagnostics ([#114](https://github.com/uniskela/ts6-manager/issues/114)) ([2a096bf](https://github.com/uniskela/ts6-manager/commit/2a096bf7411fe1e44e9d000d93fe1731615cff34))
* TeamSpeak activity journal ([#133](https://github.com/uniskela/ts6-manager/issues/133)) ([b56a88e](https://github.com/uniskela/ts6-manager/commit/b56a88e9033e475deb757ab3428f46802f01f473))


### Bug Fixes

* add demand-driven runtime and media diagnostics ([#153](https://github.com/uniskela/ts6-manager/issues/153)) ([aa926b5](https://github.com/uniskela/ts6-manager/commit/aa926b5dd3c84987421422d95a5630b083c12b19))
* auto-refresh activity journal history while capturing ([#136](https://github.com/uniskela/ts6-manager/issues/136)) ([092fbf8](https://github.com/uniskela/ts6-manager/commit/092fbf81935d0154d09ec82a29df13f645d7fd4c))
* bind file and draft actions to owner context ([#144](https://github.com/uniskela/ts6-manager/issues/144)) ([fe48e95](https://github.com/uniskela/ts6-manager/commit/fe48e95a98946f3ec61bee454b9fc6bec76381dc))
* bound storage summary scans and coverage labels ([#151](https://github.com/uniskela/ts6-manager/issues/151)) ([9e72b3e](https://github.com/uniskela/ts6-manager/commit/9e72b3eb2bb74e654d37b46335f326fa0c9dbfd1))
* correct server logs level filter and instance log mode ([#137](https://github.com/uniskela/ts6-manager/issues/137)) ([53b92cd](https://github.com/uniskela/ts6-manager/commit/53b92cdc60e820b38dc676332d33a3517a31ad63))
* de-noise server log timezone unknown labels ([#142](https://github.com/uniskela/ts6-manager/issues/142)) ([9bb6f75](https://github.com/uniskela/ts6-manager/commit/9bb6f751fb313fcf76f374b3349a2eac3dcefbe8))
* **docs:** use MkDocs slug for TeamSpeak 2052 troubleshooting link ([#148](https://github.com/uniskela/ts6-manager/issues/148)) ([888c3d3](https://github.com/uniskela/ts6-manager/commit/888c3d30a9567bd396ff1051cb2260c92494c0f4))
* drop git sha from sidebar version label ([#113](https://github.com/uniskela/ts6-manager/issues/113)) ([308d4b0](https://github.com/uniskela/ts6-manager/commit/308d4b031270acf2d778c8465d4b9b8d0cf1768f))
* harden server logs against TeamSpeak logview I/O errors ([#139](https://github.com/uniskela/ts6-manager/issues/139)) ([d6baafa](https://github.com/uniskela/ts6-manager/commit/d6baafa2eedfaef853ff329a9a80d5cf78707ce4))
* keep history and capture status labels honest ([#155](https://github.com/uniskela/ts6-manager/issues/155)) ([d2fcd6b](https://github.com/uniskela/ts6-manager/commit/d2fcd6b5b04a33dc0bfdb45f1e9cf722df01170a))
* keep SSH helper on human channels during music bot reconnect ([#143](https://github.com/uniskela/ts6-manager/issues/143)) ([9df08fd](https://github.com/uniskela/ts6-manager/commit/9df08fd7f2b50c3d7f3ba72dacba4989405edf3b))
* make expensive diagnostics demand-driven ([#146](https://github.com/uniskela/ts6-manager/issues/146)) ([64f98a7](https://github.com/uniskela/ts6-manager/commit/64f98a7afc35bf821295c16d3d985df4aac651a3))
* **sidecar:** stop an unreachable STUN server delaying every viewer by 5s ([48d4d16](https://github.com/uniskela/ts6-manager/commit/48d4d1648a58757b02c6fc3df4f62f281191c3dc))
* surface action-local permission and compatibility guidance ([#152](https://github.com/uniskela/ts6-manager/issues/152)) ([3a37d92](https://github.com/uniskela/ts6-manager/commit/3a37d9268da53da1ad80cdc04bc1215d7bd4285d))
* use full width for activity journal history rows ([#138](https://github.com/uniskela/ts6-manager/issues/138)) ([3ea1a54](https://github.com/uniskela/ts6-manager/commit/3ea1a54bbd0be8b97f883b12b470d5322feec45a))

## [1.7.1](https://github.com/uniskela/ts6-manager/compare/v1.7.0...v1.7.1) (2026-09-22)


### Bug Fixes

* stop Query flood from breaking Instance page ([#106](https://github.com/uniskela/ts6-manager/issues/106)) ([d9e5517](https://github.com/uniskela/ts6-manager/commit/d9e5517032a9698f8adc1d9c8f150bf667a9c24d))

## [1.7.0](https://github.com/uniskela/ts6-manager/compare/v1.6.2...v1.7.0) (2026-09-22)


### Features

* add accessible channel moves and safe server context ([#90](https://github.com/uniskela/ts6-manager/issues/90)) ([4d0899a](https://github.com/uniskela/ts6-manager/commit/4d0899adfc134b5a0e1b73aa8452e980cfe40002))
* add appearance themes and settings deep links ([#76](https://github.com/uniskela/ts6-manager/issues/76)) ([9102e71](https://github.com/uniskela/ts6-manager/commit/9102e717bd108de163e4dda1d9778f559e5c99cc))
* add installable PWA experience ([#69](https://github.com/uniskela/ts6-manager/issues/69)) ([b3541e8](https://github.com/uniskela/ts6-manager/commit/b3541e8284361d95d026057f6047e9f3b3cc476a))
* add persistent sidebar section navigation ([#77](https://github.com/uniskela/ts6-manager/issues/77)) ([c8e7fef](https://github.com/uniskela/ts6-manager/commit/c8e7fefe6d50eae9bdb85a907e75b268eb175e35))
* introduce canonical TS6 brand identity ([#75](https://github.com/uniskela/ts6-manager/issues/75)) ([9a5facb](https://github.com/uniskela/ts6-manager/commit/9a5facb3a4d2526c226d23a5d1c5252d33592cca))
* make admin actions truthful and safe ([#85](https://github.com/uniskela/ts6-manager/issues/85)) ([e2622a1](https://github.com/uniskela/ts6-manager/commit/e2622a1694076f0ac4b5425b12ac5817992876d1))
* make permission editing context safe ([#79](https://github.com/uniskela/ts6-manager/issues/79)) ([7c98f23](https://github.com/uniskela/ts6-manager/commit/7c98f238ef9804241331d8bd16783b6566ba5ee3))
* polish shared data tables ([#82](https://github.com/uniskela/ts6-manager/issues/82)) ([19bc25a](https://github.com/uniskela/ts6-manager/commit/19bc25aaf71b37334fac68f8a46369dad473b7b7))
* protect and reroute bot flows ([#80](https://github.com/uniskela/ts6-manager/issues/80)) ([aa804e1](https://github.com/uniskela/ts6-manager/commit/aa804e1dc841bc82accc002e8b32139f46df57fb))
* recompose dashboard status hierarchy ([#78](https://github.com/uniskela/ts6-manager/issues/78)) ([a4129f6](https://github.com/uniskela/ts6-manager/commit/a4129f6451537540657950e585d5388225bbb461))
* unify page headers and refresh states ([#102](https://github.com/uniskela/ts6-manager/issues/102)) ([6506132](https://github.com/uniskela/ts6-manager/commit/6506132d333d623fb1af653a2d61edf2bccea583))


### Bug Fixes

* keep close Bot Flow routes direct ([#104](https://github.com/uniskela/ts6-manager/issues/104)) ([ca9a9f4](https://github.com/uniskela/ts6-manager/commit/ca9a9f437efb860a824bc5074e0e0934d003aa1d))
* harden Docker scripts against CRLF checkouts ([#88](https://github.com/uniskela/ts6-manager/issues/88)) ([bd31836](https://github.com/uniskela/ts6-manager/commit/bd318366f9e0c55d3a5052cbbf11ae9aed8ec700))

## [1.6.2](https://github.com/uniskela/ts6-manager/compare/v1.6.1...v1.6.2) (2026-09-20)


### Bug Fixes

* pin and automate yt-dlp updates ([#66](https://github.com/uniskela/ts6-manager/issues/66)) ([95cd7ea](https://github.com/uniskela/ts6-manager/commit/95cd7ea4b740200836db86359d594d24ef4dc6f9))
* recover cleanly from TeamSpeak Query flood protection ([#67](https://github.com/uniskela/ts6-manager/issues/67)) ([6c8afbc](https://github.com/uniskela/ts6-manager/commit/6c8afbc86266bfbdc4578ca0f512dbf108d844e4))

## [1.6.1](https://github.com/uniskela/ts6-manager/compare/v1.6.0...v1.6.1) (2026-09-20)


### Bug Fixes

* add Prisma CLI config ([6673b2e](https://github.com/uniskela/ts6-manager/commit/6673b2ea306ce31588321372023769d2206d8c15))
* align v1.6 startup with immutable runtime policy ([f163349](https://github.com/uniskela/ts6-manager/commit/f1633493ff3fe58b4b2906e05f64f2c4abdb4591))
* harden all-in-one startup config ([0f4e355](https://github.com/uniskela/ts6-manager/commit/0f4e355ed7b6dedf067e4a2e024c3f0124f9cfe6))
* make backend sidecar configuration deployment-specific ([f468433](https://github.com/uniskela/ts6-manager/commit/f4684335ffa36fed950925f750ca829c6f69e850))
* make the management UI mobile friendly ([#63](https://github.com/uniskela/ts6-manager/issues/63)) ([7c10b45](https://github.com/uniskela/ts6-manager/commit/7c10b45a3362bcc0edda2babf8f2b0fac6756da5))
* make yt-dlp startup check diagnostic-only ([5411a1f](https://github.com/uniskela/ts6-manager/commit/5411a1fd214cba07fdd1c72f0ef54cff8da88bec))
* migrate Prisma seed config out of package.json ([2ecd190](https://github.com/uniskela/ts6-manager/commit/2ecd1908d184c42d22373cc9d31ab9398c478457))
* remove runtime yt-dlp self-update ([bd8fab1](https://github.com/uniskela/ts6-manager/commit/bd8fab116809e9d05e78cbf63cb7463a4670695f))
* remove yt-dlp self-update helper ([c94e4b4](https://github.com/uniskela/ts6-manager/commit/c94e4b4083ee70a73e7fdd41ac0b5774d1080e31))

## [1.6.0](https://github.com/uniskela/ts6-manager/compare/v1.5.2...v1.6.0) (2026-09-19)


### Features

* add public documentation URL ([fee8c4f](https://github.com/uniskela/ts6-manager/commit/fee8c4f6287e303cf6e311f0314006d0895aa225))
* link documentation from the web ui ([528e986](https://github.com/uniskela/ts6-manager/commit/528e986cab5d370b0946383527b2ef202424dbea))
* support TeamSpeak beta13 and harden server operations ([06af311](https://github.com/uniskela/ts6-manager/commit/06af3115c1f29d1f146c89fcee94041aca4cef17))
* support TeamSpeak beta13 and harden server operations ([a813e85](https://github.com/uniskela/ts6-manager/commit/a813e85a138ce57baa9f9e022bc8795b3d5fc0c7))


### Bug Fixes

* accept valid TeamSpeak image tags in compatibility smoke ([8dc133e](https://github.com/uniskela/ts6-manager/commit/8dc133e9288441b7c83c165682138cab3e2b62f2))
* address beta13 release review findings ([09c4714](https://github.com/uniskela/ts6-manager/commit/09c4714b15285b285a1c7d5cdf75562fafc20933))
* prune vulnerable build tooling from runtime images ([46f7303](https://github.com/uniskela/ts6-manager/commit/46f7303769cbc10573e2544d831eacc83f7133ac))
* use pnpm 9 deploy syntax ([a575737](https://github.com/uniskela/ts6-manager/commit/a57573724e0642755fe09549dbca39898c11a15d))

## [1.5.2](https://github.com/uniskela/ts6-manager/compare/v1.5.1...v1.5.2) (2026-09-17)


### Bug Fixes

* create persistent WebQuery API keys in setup guidance ([241618e](https://github.com/uniskela/ts6-manager/commit/241618e34e936a0f51bf79b39f6cd50e5b697f2c))
* document persistent WebQuery API keys ([f7a73d3](https://github.com/uniskela/ts6-manager/commit/f7a73d358c5be133504a1d402a2b9aa5f43714c0))
* prevent WebQuery API keys from expiring ([43c017d](https://github.com/uniskela/ts6-manager/commit/43c017dba1043fa7f804f52375688f460346878b))

## [1.5.1](https://github.com/uniskela/ts6-manager/compare/v1.5.0...v1.5.1) (2026-09-16)


### Bug Fixes

* back off animations on invalid WebQuery credentials ([a787cd9](https://github.com/uniskela/ts6-manager/commit/a787cd955e717be6ab503f9f2a7f879cf16130c5))
* refresh animation WebQuery clients ([d78363f](https://github.com/uniskela/ts6-manager/commit/d78363fe66e916d5409ced02802d725dca9daf03))
* reload flows after server connection refresh ([4a06f46](https://github.com/uniskela/ts6-manager/commit/4a06f4695ae05fa661dd19d25e2eda772d272c7a))
* resolve active WebQuery client for animations ([f655e45](https://github.com/uniskela/ts6-manager/commit/f655e4586895d46bb19a71af2b99fccee55ea935))
* restart affected flows after connection updates ([cc80e17](https://github.com/uniskela/ts6-manager/commit/cc80e1790135e1c04359c232dff10e316c1b76ad))
* restore current bot engine before lifecycle hardening ([0d7e706](https://github.com/uniskela/ts6-manager/commit/0d7e70641d056fb8673547f6fa1b1cc6b9871023))
* retry initial SSH handshake failures ([a847327](https://github.com/uniskela/ts6-manager/commit/a847327d0716ca2fe19a2366016fe8346d353040))
* validate restored WebQuery connections ([a438706](https://github.com/uniskela/ts6-manager/commit/a438706ca99a85fe75db8848f2d6c2249937a20f))
* validate restored WebQuery credentials without blocking startup ([9413ffd](https://github.com/uniskela/ts6-manager/commit/9413ffd7c921717dd8fd7448826d493177dd3fc0))

## [1.5.0](https://github.com/uniskela/ts6-manager/compare/v1.4.1...v1.5.0) (2026-09-16)


### Features

* add incremental local PCM streaming ([bf2b602](https://github.com/uniskela/ts6-manager/commit/bf2b602244a4413e09a0f54b05ae5128cf0385f8))


### Bug Fixes

* cache resolved voice host before UDP playback ([6c9866b](https://github.com/uniskela/ts6-manager/commit/6c9866b423db6c35e001beedd446b48d85559f85))
* carry YouTube stream headers into ffmpeg ([1478bb6](https://github.com/uniskela/ts6-manager/commit/1478bb638c12498da8262e28b54023e35b820381))
* let manual stop cancel in-flight reconnect grace ([5dc57e3](https://github.com/uniskela/ts6-manager/commit/5dc57e39597aaafa962ef0cf851494438d6e6f47))
* model reconnect attempts as pending or in-flight ([c7f7ae8](https://github.com/uniskela/ts6-manager/commit/c7f7ae81e62e6591ec3d21b6fb377c81ed31a1ff))
* pace local ffmpeg decoding at media speed ([25e3fde](https://github.com/uniskela/ts6-manager/commit/25e3fde75fb15fd1c3b65218bb26ea63e2a0c553))
* pass safe stream headers to ffmpeg ([a2049b3](https://github.com/uniskela/ts6-manager/commit/a2049b3ba0b6625a8b44e37f83c9dcc7aaf9fabf))
* preserve YouTube stream headers for ffmpeg ([3d0283a](https://github.com/uniskela/ts6-manager/commit/3d0283a157d898233cf6d3fb20bf940cd295146e))
* preserve yt-dlp stream headers ([591dc6b](https://github.com/uniskela/ts6-manager/commit/591dc6b02954ce34ae212bae048cee59006c9426))
* prevent overlapping music bot reconnect attempts ([9b739d6](https://github.com/uniskela/ts6-manager/commit/9b739d6af2c84cea931f221f1f4420e9f3473969))
* resolve voice UDP host once per connection ([049eca3](https://github.com/uniskela/ts6-manager/commit/049eca3531112bcfcdee4d5467dc41ab79fd7aa9))
* resolve voice UDP target once per connection ([d1e36ad](https://github.com/uniskela/ts6-manager/commit/d1e36adf9eec6a33332daa57bc208f86d75b172a))
* stream local music playback with bounded memory ([819f635](https://github.com/uniskela/ts6-manager/commit/819f63531a18ed23d030719179eb4225463a45cd))
* stream local music playback with bounded memory ([5f0bd7e](https://github.com/uniskela/ts6-manager/commit/5f0bd7e1a7d6161e209bdca43cbd38dab4dec57c))
* terminate local playback loop on ffmpeg errors ([b45a31d](https://github.com/uniskela/ts6-manager/commit/b45a31df12e27f45fa015dc5a5a5a8e30ed344cd))
* update vulnerable transitive dependencies ([e020a3c](https://github.com/uniskela/ts6-manager/commit/e020a3c193d6121f42498da174f5116e94c42d22))
* update vulnerable transitive dependencies ([2d8f03d](https://github.com/uniskela/ts6-manager/commit/2d8f03d49b776cabc8bc39048dd2b4946eaf5c6e))

## [1.4.1](https://github.com/uniskela/ts6-manager/compare/v1.4.0...v1.4.1) (2026-09-16)


### Bug Fixes

* keep GHCR sha tags aligned with :latest promote ([996a4e2](https://github.com/uniskela/ts6-manager/commit/996a4e2fc7ead98872e3c48ff85f7fabdcd68f80))
* rate-limit authenticated profile endpoint ([fbfc270](https://github.com/uniskela/ts6-manager/commit/fbfc270f337aa0dce5ebdba56be223b79225b1a7))
* rate-limit music library song deletion ([8d88835](https://github.com/uniskela/ts6-manager/commit/8d88835fb705935b95db4598d7e02160b9ae266f))
* rate-limit YouTube cookie settings routes ([283cf35](https://github.com/uniskela/ts6-manager/commit/283cf350c439305d4d22e29c51d0e65e03f30fa0))
* refine yt-cookie rate limiting ([a885112](https://github.com/uniskela/ts6-manager/commit/a88511263b9ea4741770ac181ae5a888490b19a6))

## [Unreleased]

### Changed

- Release Please now owns semver bumps, changelog sections, tags, and GitHub Releases on `main` (aligned with adhd-hub / codex-lb-rates)

## [1.4.0] - 2026-09-11

### Security

- Bot-flow condition expressions are no longer template-interpolated before evaluation, so untrusted event data (e.g. chat text) cannot alter expr-eval syntax (adapted from [DomeNinchen/ts6forkmanager](https://github.com/DomeNinchen/ts6forkmanager))

### Fixed

- Sidecar compose mounts now share `music-data` with the backend so pre-downloaded videos are readable by ffmpeg
- On-demand video downloads no longer loop forever; streams auto-stop after the probed clip duration
- Sidecar A/V pacing clamps anomalous RTP latency spikes that previously overflowed RTP queues
- SSH query client teardown is awaited on shutdown, and in-flight `connect()` aborts cleanly if `destroy()` races it (avoids nickname-in-use / already-member errors on fast restart)
- Video stream start/source API calls use a 120s client timeout so long downloads no longer falsely fail at 15s

### Changed

- Sidecar VP8 encode uses multi-threaded libvpx (`-threads` / `-row-mt`), default `-cpu-used 4`, and bitrate-scaled `-bufsize`
- Channels shows ServerQuery clients with a distinct Query badge (useful for spotting leftover query sessions)
- WebUI video preview supports mute/unmute while keeping autoplay-safe default mute
- Extended [CREDITS.md](CREDITS.md) with DomeNinchen fork attribution

## [1.3.9] - 2026-09-01

### Added

- IPTV / M3U playlist management with admin CRUD, channel refresh, auto-refresh scheduler, and live stream playback via the video sidecar (`!channels`, `!tv`, `!iptv` chat commands; adapted from [simardwtf/ts6-manager](https://github.com/simardwtf/ts6-manager))
- `!lyrics` music-bot command with LRCLIB lookup and lyrics.ovh fallback (adapted from [coom/ts6-manager](https://github.com/coom/ts6-manager))
- YouTube audio stream-first playback via yt-dlp direct URL resolution, with download fallback (inspired by [prankroker/ts6-manager](https://github.com/prankroker/ts6-manager))
- Client avatars and voice-state icons in Channels (talking, AFK, mute; adapted from [kytos22/ts6-manager](https://github.com/kytos22/ts6-manager))
- Per-channel file storage summary in File Manager (`GET /api/files/summary`; adapted from kytos22)
- Music bot runtime status auto-refresh (1s polling; adapted from [mqh9007/ts6-manager](https://github.com/mqh9007/ts6-manager))
- Client IP column (admin) and richer online status badges in Clients (adapted from mqh9007)
- Settings → About tab showing build version and optional git sha (adapted from mqh9007)

### Fixed

- Connection form field-help tooltips no longer clip off-screen at dialog edges (collision-aware positioning)
- YouTube playlist import edge cases: shape-based playlist URL detection, canonical `www.youtube.com` URLs, re-import already-present tracks, `!play` playlist gating, and frontend polling stop on query error (adapted from coom Aug 2026 follow-up commits)
- File Manager channel storage summary swapped file/folder counts (ftgetfilelist type convention)
- IPTV playlist fetch no longer follows unvalidated redirects (SSRF hardening)

### Changed

- Extended [CREDITS.md](CREDITS.md) with fork attribution for coom, kytos22, mqh9007, simardwtf, and prankroker

## [1.3.8] - 2026-09-01

### Added

- Connection setup guide on Settings → Connections with checklist, deployment scenarios (Docker/remote/same-host), and feature matrix (WebQuery vs SSH)
- Optional multi-step connection setup wizard with WebQuery/SSH draft testing before save
- Field-level tooltips and sectioned connection form (WebQuery required, SSH optional)
- SSH test endpoints (`POST /api/servers/test-ssh`, `POST /api/servers/:id/test-ssh`) and Test SSH buttons on connection cards
- Dashboard nudge banner for admins with no server connections (links to `/settings?tab=connections`)
- Deployment self-check in wizard step 1: probes localhost, `teamspeak`, and `host.docker.internal` from the manager backend (`GET /api/servers/deployment-check`)

### Changed

- Connections tab is minimal when empty — wizard opens from dashboard links (`?wizard=1`); detailed help in an optional dialog
- Connection setup guide card hidden until at least one connection exists
- Connection setup wizard shows setup instructions inline with each settings step (4 steps); links to official TeamSpeak 6 Server docs
- `docker-compose.pr-test.yml` includes TeamSpeak 6 on the compose network (`teamspeak` hostname) for end-to-end wizard testing

### Security

- SSRF hardening for TeamSpeak connection hosts: validate/sanitize host and port before WebQuery/SSH outbound requests; block cloud-metadata targets and URL tricks; optional DNS resolution check on draft connection tests (`TS_ALLOW_PRIVATE_HOSTS=false` to disallow private/loopback hosts)
- CodeQL request-forgery barriers for validated TeamSpeak endpoint helpers (`.github/codeql/extensions/ts6-connection-host/`)

### Fixed

- Connection edit form no longer requires re-entering the API key when unchanged
- Removed `# syntax=docker/dockerfile:1.4` from Dockerfiles to avoid Docker Hub pull failures during `docker compose` builds

## [1.3.7] - 2026-09-01

### Added

- Auth refresh single-flight with Web Lock serialization (adapted from [coom/ts6-manager@9658cfb](https://github.com/coom/ts6-manager/commit/9658cfbbe5f33867efd96b5c883a5ce8f3dc0639))
- `/auth/me` re-fetch on layout mount to fix stale admin role in sidebar
- YouTube playlist import service with background jobs, `youtubePlaylistId` / `serverConfigId` on playlists, and minimal English UI (adapted from coom Aug 2026 import series)
- Video download-then-stream via proxied yt-dlp (`bv*+ba/b`, temp files under `MUSIC_DIR`)
- Auto-stop music/video when bot channel is empty (`BOT_AUTO_STOP_EMPTY_SECONDS`, default 300)
- Video stream volume slider and max video duration setting (Settings → YouTube → Limits)
- SSH host-key fingerprint pinning on first ServerQuery SSH connect
- WebSocket broadcasts scoped by user enabled state and allowed `serverConfigId`s
- `docs/bot-flows.md` — bot flow reference (adapted from uniplayer1)

### Security

- Admin-only GET on bot flow routes (webhook secrets)
- Admin-only reads for privilege keys, widget tokens, client DB, banlist, logview
- yt-dlp URL guard: reject `-` prefixes; literal `--` before positional media URLs

### Fixed

- WebQuery boolean coercion in Clients/Messages (`Number(x) === 1` for away/read flags)
- TS3 error 2568 (insufficient permissions) no longer treated as fatal disconnect

### Changed

- Extended [CREDITS.md](CREDITS.md) with fork contributions table (coom, uniplayer1)
- Docker startup: upgrade-aware schema apply (`apply-schema.sh`) detects older DBs / version bumps and runs `prisma db push` on compose up

## [1.3.6] - 2026-08-28

### Added

- **Phase B:** Import Apple Music / YouTube playlists directly to a **running music bot queue** (`musicBotId`, optional `clearFirst`) without creating a playlist
- TS6 **Markdown** formatting for `!help`, `!np`, `!queue`, and `!radio` bot replies (headings, lists, `<details>` controls hint)
- Custom command editor documents TS6 Markdown / BBCode formatting for responses
- **TS6-style formatting toolbar** on custom command responses (bold, lists, spoilers, headings, code, math, tables, Mermaid, BBCode snippets)

### Fixed

- **Import as Playlist** no longer sends `musicBotId` when a bot is selected but queue import was not requested
- **Import to queue** available after **Load** on library and playlist URL flows
- `!np` “… and N more” queue count accounts for current track index

### Changed

- `!np` / `!nowplaying` shows track progress, up next, and expandable playback control hints (text commands — TS6 has no clickable skip/pause buttons in bot messages)

### Fixed

- **Load & Play** on stream playlists now starts playback after loading the queue (not only enqueue)
- yt-dlp YouTube downloads use flexible audio format selection (`bestaudio` fallbacks) instead of forcing opus extraction, with player-client rotation for bot-check / format errors

- Music bots can accept `!commands` in **additional channels** (channel ID list) and reply there while staying in the default playback channel
- Uses ServerQuery SSH text-channel listeners; configure under Music Bots → bot settings
- On `!play` (and `!radio <id>`), the voice bot **joins the command channel** so audio plays where the user typed the command

## [1.3.5] - 2026-08-28

### Changed

- Default **max playlist import** raised from 50 → **250** (still configurable up to 500 in Settings → Limits)

### Fixed

- Apple Music / playlist import jobs report `sourceTrackCount` and warn when capped (e.g. 259-track playlist with limit 50)
- Import progress shows `Matching X/Y of 259`; completion toast tells you to raise Settings cap when truncated

## [1.3.4] - 2026-08-28

### Added

- Background **Import as Playlist** / **Import all** for Apple Music URLs (matches YouTube on YouTube, registers on stream playlists without downloading)
- Import jobs show **matching** progress for Apple Music (`Matching 45/259 (42 hits)`) before adding tracks
- Paste Apple Music URL and import without **Load** (library tab and playlist editor)

### Fixed

- Apple Music **Load URL** no longer fails at 15s while the backend is still matching tracks — client timeout raised to 5 minutes and nginx `/api` proxy timeouts set to 300s
- Apple Music load UI shows match progress (`98 matched of 259 (first 100 searched)`) and clearer timeout error messages
- Duplicate YouTube video matches in Apple Music playlists no longer collapse selection checkboxes
- Stream playlist import registers YouTube tracks on-demand instead of bulk-downloading

## [1.3.3] - 2026-08-27

### Added

- Stream playlists: Add from URL **registers** YouTube tracks without downloading; audio is fetched on first play
- `POST /music-library/youtube/register` for URL-only song rows (empty `filePath` until played)

### Changed

- Apple Music / URL Load matching cap raised from 15 → **100** tracks (parallel YouTube search)

### Fixed

- Stream-only playlists no longer bulk-download when adding from a loaded URL

## [1.3.2] - 2026-08-27

### Fixed

- Apple Music **Load URL** matches YouTube tracks in parallel (avoids proxy timeouts on large playlists like 250+ tracks)
- `/youtube/info` returns the real error message as HTTP 502 instead of a generic 500
- Frontend Load toast shows the server error text
- `/api/health` reports backend `version` (+ optional `gitSha`) so deploys can confirm backend matches the UI

## [1.3.1] - 2026-08-27

### Added

- `!shuffle [on|off]` chat command to toggle or set queue shuffle

### Fixed

- Apple Music user playlist IDs (`pl.u-…` with hyphens) parse correctly
- Library / playlist **Load URL** resolves Apple Music links via metadata + YouTube match instead of sending them to yt-dlp (fixes `Unsupported URL: music.apple.com`)

## [1.3.0] - 2026-08-27

### Breaking Changes

- Music bot `!` command replies (built-in and custom) are sent to **channel chat** instead of a private DM

### Added

- Stream playlists: Add Songs → **URL** tab (YouTube video/playlist import into the selected playlist)
- Queue tab: **Add to queue** for songs and playlists (append, does not clear)
- Playlists: edit name and local/stream mode (YouTube-linked playlists stay stream)
- [AGENTS.md](AGENTS.md) release process: CHANGELOG sections, `vX.Y.Z` tags, GitHub Releases, GHCR publish on `v*`

### Changed

- Commands tab help text documents channel-chat replies
