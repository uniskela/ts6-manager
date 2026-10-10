# Changelog

All notable changes to this opinionated fork of [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager) are documented here. See [CREDITS.md](CREDITS.md) for upstream and fork attribution.

## [1.11.0](https://github.com/uniskela/ts6-manager/compare/v1.10.2...v1.11.0) (2026-10-10)


### Features

* add secure listener remote backend API ([#398](https://github.com/uniskela/ts6-manager/issues/398)) ([e6fbe35](https://github.com/uniskela/ts6-manager/commit/e6fbe355a6f26be235e1e74ce6b0089c9884426e))
* add shared media command permissions and vote-skip ([#393](https://github.com/uniskela/ts6-manager/issues/393)) ([0efbfd2](https://github.com/uniskela/ts6-manager/commit/0efbfd243f604a87f314e2e2d32b9204cecab188))
* add the phone listener remote page ([#406](https://github.com/uniskela/ts6-manager/issues/406)) ([68e8666](https://github.com/uniskela/ts6-manager/commit/68e86665c9ec486d883ea6cc5f65d9726898045a))
* **console:** video Up next and Queue as video ([#405](https://github.com/uniskela/ts6-manager/issues/405)) ([14a86b5](https://github.com/uniskela/ts6-manager/commit/14a86b5a69b94254e7ae6fbdb121bf9cd9b74fe9))
* **sidecar:** keep VAAPI-decoded frames on the GPU ([#396](https://github.com/uniskela/ts6-manager/issues/396)) ([69eeff8](https://github.com/uniskela/ts6-manager/commit/69eeff83eeb1c26ff686259ddf9bafbd25f65cbb))
* **sidecar:** publish native media sidecar binaries with each release ([#253](https://github.com/uniskela/ts6-manager/issues/253) Slice 6) ([#399](https://github.com/uniskela/ts6-manager/issues/399)) ([e7769a9](https://github.com/uniskela/ts6-manager/commit/e7769a9f8c71cd925b0c0e917a7b086bbd4d5b88))
* **video:** queue videos and YouTube playlists on a running stream ([#404](https://github.com/uniskela/ts6-manager/issues/404)) ([6e826da](https://github.com/uniskela/ts6-manager/commit/6e826da002afb977d3abb927701b08c535ba4a79))


### Bug Fixes

* block cloud metadata bypasses in media egress ([#408](https://github.com/uniskela/ts6-manager/issues/408)) ([ce07b6a](https://github.com/uniskela/ts6-manager/commit/ce07b6ad4a4233ae124d42639a6518696915a3e4))
* **sidecar:** build with Go 1.26.9 and golang.org/x/net 0.61.0 ([#401](https://github.com/uniskela/ts6-manager/issues/401)) ([83b2b80](https://github.com/uniskela/ts6-manager/commit/83b2b8053cebb3fd0b1324edb429c0e09f422b77))
* **sidecar:** hold a viewer's video gate until DTLS is up and keep packet loss visible ([#394](https://github.com/uniskela/ts6-manager/issues/394)) ([3ecae0b](https://github.com/uniskela/ts6-manager/commit/3ecae0b48980c42d60887bc87c9e3674d7bf470a))
* **sidecar:** quote viewer signaling errors in logs ([#409](https://github.com/uniskela/ts6-manager/issues/409)) ([d1eb540](https://github.com/uniskela/ts6-manager/commit/d1eb54042cd946c1fb5389d697f90959f377c8eb))
* **sidecar:** stream sources without an audio track, with silence ([#397](https://github.com/uniskela/ts6-manager/issues/397)) ([2585a69](https://github.com/uniskela/ts6-manager/commit/2585a6983c2f1ab57192d159cab010ebaa97ac01))
* **ui:** keep connection pickers readable below the desktop header ([#392](https://github.com/uniskela/ts6-manager/issues/392)) ([0efbbef](https://github.com/uniskela/ts6-manager/commit/0efbbefbe26e9375687da80f0cf5d8d9152dfd1a))

## [1.10.2](https://github.com/uniskela/ts6-manager/compare/v1.10.1...v1.10.2) (2026-10-09)


### Bug Fixes

* **ci:** repair docs dispatch and frontend Trivy security gate ([#390](https://github.com/uniskela/ts6-manager/issues/390)) ([4160244](https://github.com/uniskela/ts6-manager/commit/416024405d0f1b2baa41c9c98920b97a088348c1))

## [1.10.1](https://github.com/uniskela/ts6-manager/compare/v1.10.0...v1.10.1) (2026-10-06)


### Bug Fixes

* bring back Play buttons on Media Library radio stations ([#367](https://github.com/uniskela/ts6-manager/issues/367)) ([3c58fb2](https://github.com/uniskela/ts6-manager/commit/3c58fb2430c3093734e2b4509c457eecbf8a9ee9))
* close HTTP connections for opaque and redirected HLS ([#377](https://github.com/uniskela/ts6-manager/issues/377)) ([2fbf776](https://github.com/uniskela/ts6-manager/commit/2fbf776bfbfffbdf1038ed446342b12d2b68b295))
* deliver in-channel !help without UDP fragmentation ([#371](https://github.com/uniskela/ts6-manager/issues/371)) ([b9f3a3b](https://github.com/uniskela/ts6-manager/commit/b9f3a3b66a52642157a4e441f87adef8b479c1f7))
* disable persistent HTTP for multi-host HLS ([#372](https://github.com/uniskela/ts6-manager/issues/372)) ([913ab79](https://github.com/uniskela/ts6-manager/commit/913ab79efa57877cdb8e1e55f6fdf823372de294))
* **errors:** add structured user-facing error handling ([#384](https://github.com/uniskela/ts6-manager/issues/384)) ([e3ff5a7](https://github.com/uniskela/ts6-manager/commit/e3ff5a7baac0529b8d828ad176d48cc8fd529f78))
* **streaming:** clarify Auto hardware encoder behavior ([#364](https://github.com/uniskela/ts6-manager/issues/364)) ([7548c76](https://github.com/uniskela/ts6-manager/commit/7548c76dc81e882997d2975ab1cf21d172eea57a))
* **streaming:** restore H.264 playback for WebRTC viewers ([#365](https://github.com/uniskela/ts6-manager/issues/365)) ([f3dcff2](https://github.com/uniskela/ts6-manager/commit/f3dcff228095209d372ee840291b69012735f72a))

## [1.10.0](https://github.com/uniskela/ts6-manager/compare/v1.9.3...v1.10.0) (2026-10-05)


### Features

* !play song search, unknown-command replies and Spotify playlist support ([#328](https://github.com/uniskela/ts6-manager/issues/328)) ([b77fa2f](https://github.com/uniskela/ts6-manager/commit/b77fa2f3cf414945a00d6d16578390c9913c9051))
* add AMD AMF encoding and Windows-native sidecar support ([#357](https://github.com/uniskela/ts6-manager/issues/357)) ([a09b96d](https://github.com/uniskela/ts6-manager/commit/a09b96d3d40fcb274556bbe3482aa2f83abe5a77))
* add shortcuts from the bot console tabs to the media pages ([#294](https://github.com/uniskela/ts6-manager/issues/294)) ([5d82b0a](https://github.com/uniskela/ts6-manager/commit/5d82b0aded5152c8b99791cf1778f90f5f1702c7))
* announce auto-stops in chat with a 1-minute video warning ([#274](https://github.com/uniskela/ts6-manager/issues/274)) ([b2434fd](https://github.com/uniskela/ts6-manager/commit/b2434fddc4f5b60468d0d15df2f94214696650eb))
* bot avatars ([#283](https://github.com/uniskela/ts6-manager/issues/283)) ([e0e99e2](https://github.com/uniskela/ts6-manager/commit/e0e99e20b33ff916b3fcecc8354af3b1068a2326))
* bot console page with now playing and drag-and-drop queue ([#275](https://github.com/uniskela/ts6-manager/issues/275)) ([999b7c8](https://github.com/uniskela/ts6-manager/commit/999b7c8c5dbb61fa96c9b658e766c6595f681b5e))
* Bot Hub becomes the bot list and Media Bots becomes Media Library ([#285](https://github.com/uniskela/ts6-manager/issues/285)) ([b11f73f](https://github.com/uniskela/ts6-manager/commit/b11f73f34b4a156bccb68b58d7b8852b9a2c3d04))
* console IPTV tab with groups and search ([#282](https://github.com/uniskela/ts6-manager/issues/282)) ([3649ae6](https://github.com/uniskela/ts6-manager/commit/3649ae6c45984cf69384e06b063f9013d119cd8d))
* console link tab ([#278](https://github.com/uniskela/ts6-manager/issues/278)) ([d5eeddf](https://github.com/uniskela/ts6-manager/commit/d5eeddf34e10c15d2fd59a6e4e9c7d798208b3ea))
* console music and radio tabs ([#279](https://github.com/uniskela/ts6-manager/issues/279)) ([643fba0](https://github.com/uniskela/ts6-manager/commit/643fba0768b7cd5cba2a375602efd28ea0262b9f))
* edit radio stations ([#266](https://github.com/uniskela/ts6-manager/issues/266)) ([8f96de3](https://github.com/uniskela/ts6-manager/commit/8f96de3a09137a366e69ea5225c08a64677dd6b1))
* filter IPTV channels by country and language ([#293](https://github.com/uniskela/ts6-manager/issues/293)) ([0b5a58b](https://github.com/uniskela/ts6-manager/commit/0b5a58baf44126002217ae24b36dfe9c4ccbaf67))
* host channel banner images in the manager ([#287](https://github.com/uniskela/ts6-manager/issues/287)) ([24d5c03](https://github.com/uniskela/ts6-manager/commit/24d5c036d1e32a1828fd7276eb066b2bc8f476b0))
* IPTV favourites and recent channels ([#286](https://github.com/uniskela/ts6-manager/issues/286)) ([92a9da9](https://github.com/uniskela/ts6-manager/commit/92a9da992ec9477ff1d61622af482b4451a97cbb))
* let one bot answer chat commands in a shared channel ([#311](https://github.com/uniskela/ts6-manager/issues/311)) ([29a753a](https://github.com/uniskela/ts6-manager/commit/29a753a1750ebec7c11e13b70e9baf27ed27fa7f))
* **media-library:** now-playing pill in header and page-level Add songs ([#330](https://github.com/uniskela/ts6-manager/issues/330)) ([6c6adc7](https://github.com/uniskela/ts6-manager/commit/6c6adc796d116baad36e5db202b0ae885faf0b1c))
* move chat commands to Bot Flows with clash warnings ([#281](https://github.com/uniskela/ts6-manager/issues/281)) ([caaf263](https://github.com/uniskela/ts6-manager/commit/caaf26306d2196e3f64cd68f2ce01b0d642f90da))
* polish the bot console to match the 1.10.0 mockup ([#290](https://github.com/uniskela/ts6-manager/issues/290)) ([eed82c2](https://github.com/uniskela/ts6-manager/commit/eed82c282f3e3cf5fa14035629f2fd1cd8cc4558))
* search and import stations from Community Radio Browser ([#315](https://github.com/uniskela/ts6-manager/issues/315)) ([f0e9a7d](https://github.com/uniskela/ts6-manager/commit/f0e9a7db08697c8f77751b187efeac4f5eb86154))
* share playlists across all bots on a server ([#273](https://github.com/uniskela/ts6-manager/issues/273)) ([c824ef0](https://github.com/uniskela/ts6-manager/commit/c824ef03f722977703bd9cb590f67b12b72c29e7))
* show ffmpeg output for every encoder capability check ([#331](https://github.com/uniskela/ts6-manager/issues/331)) ([ba1268f](https://github.com/uniskela/ts6-manager/commit/ba1268f7e5e35e2e03d324810cc82d80f0085ae0))
* **streaming:** H.264 hardware encoding on NVIDIA (NVENC) ([#238](https://github.com/uniskela/ts6-manager/issues/238)) ([1ea4eda](https://github.com/uniskela/ts6-manager/commit/1ea4eda7d2fadf9a6bf640a8f98f39c82010fc7b))
* **streaming:** stream YouTube videos directly instead of downloading first ([#270](https://github.com/uniskela/ts6-manager/issues/270)) ([08c8128](https://github.com/uniskela/ts6-manager/commit/08c8128334dd1168fb39e631c92b4b5b5a84d1c2))


### Bug Fixes

* align widget Up Next with shuffled bot queue ([#319](https://github.com/uniskela/ts6-manager/issues/319)) ([af5a60b](https://github.com/uniskela/ts6-manager/commit/af5a60b4a4bd4d09b0ecfef5651e0954f62ad835))
* **bot-hub:** let an IPTV deep link return to all channels ([#307](https://github.com/uniskela/ts6-manager/issues/307)) ([08f9099](https://github.com/uniskela/ts6-manager/commit/08f90996db72335b506b59781f59fded03c56a61))
* clear the music queue on !stop and stop-playback ([#321](https://github.com/uniskela/ts6-manager/issues/321)) ([7b85101](https://github.com/uniskela/ts6-manager/commit/7b8510152ed22ea9112fd869f4aa055c504573d8))
* **deps:** bump serialize-javascript and uuid via overrides ([#314](https://github.com/uniskela/ts6-manager/issues/314)) ([dd85c20](https://github.com/uniskela/ts6-manager/commit/dd85c20fc80698502423d34915b91c2a9fbb7f2d))
* keep streamed YouTube music playing until the track ends ([#308](https://github.com/uniskela/ts6-manager/issues/308)) ([2f05c29](https://github.com/uniskela/ts6-manager/commit/2f05c29d8dcdd5423e1253dd0f1a7c40072900a2))
* keep the Bot Hub console inside a phone screen ([#327](https://github.com/uniskela/ts6-manager/issues/327)) ([f68ba6d](https://github.com/uniskela/ts6-manager/commit/f68ba6d7d4d4e06df52b5c61aa386af50d035307))
* keep the Up next queue on shuffle drags and radio stop ([#334](https://github.com/uniskela/ts6-manager/issues/334)) ([1437ea1](https://github.com/uniskela/ts6-manager/commit/1437ea14f1fabacea55b843a9d8a31b4a1be282c))
* let bot streams inherit saved defaults ([#295](https://github.com/uniskela/ts6-manager/issues/295)) ([f6dae0a](https://github.com/uniskela/ts6-manager/commit/f6dae0a7c7d32949e770124456f9a55cb7a98982))
* make the Add to Music URL flow one load, pick and add step ([#309](https://github.com/uniskela/ts6-manager/issues/309)) ([94bc345](https://github.com/uniskela/ts6-manager/commit/94bc345a0d1f6e2fc813e19735299cb2a92e8aa3))
* **media:** send queue options with YouTube playlist imports ([#268](https://github.com/uniskela/ts6-manager/issues/268)) ([650d0e7](https://github.com/uniskela/ts6-manager/commit/650d0e7b508083cb4cea78df9885f6dbaad1e831))
* **media:** share volume across music, video, and IPTV ([#251](https://github.com/uniskela/ts6-manager/issues/251)) ([1bf31b2](https://github.com/uniskela/ts6-manager/commit/1bf31b2f182c93f22e92002dd0f5a58dd2d1c8f1))
* show a plain reason when NVENC has no NVIDIA runtime ([#306](https://github.com/uniskela/ts6-manager/issues/306)) ([bc02093](https://github.com/uniskela/ts6-manager/commit/bc020937e298f242ea9fd9c08c1ecc6884867691))
* show the long-video refusal instead of Internal server error ([#333](https://github.com/uniskela/ts6-manager/issues/333)) ([69d99cf](https://github.com/uniskela/ts6-manager/commit/69d99cf7be0b5d1b4bf39641189c5c57dd9a2523))
* show video straight away and keep it in sync after switching a stream's source ([#332](https://github.com/uniskela/ts6-manager/issues/332)) ([428d812](https://github.com/uniskela/ts6-manager/commit/428d81273643447d7c97356f47f3c0c8abf14ad1))
* shrink bot avatars to fit TeamSpeak 6 before uploading ([#312](https://github.com/uniskela/ts6-manager/issues/312)) ([f6bc137](https://github.com/uniskela/ts6-manager/commit/f6bc1378f62070e6b7f1232b56c2315b6688eb53))
* **sidecar:** measure A/V latency at arrival so the pacer aligns any skew ([#269](https://github.com/uniskela/ts6-manager/issues/269)) ([819ae27](https://github.com/uniskela/ts6-manager/commit/819ae27b551934ac554d888b2514ccee777c1480))
* split multi-tag radio genres into separate mood chips ([#329](https://github.com/uniskela/ts6-manager/issues/329)) ([9e924c9](https://github.com/uniskela/ts6-manager/commit/9e924c9a5e18297a0fa6310e79949e65ef759e6e))
* **ui:** keep Bot Hub Now playing controls on screen on phones ([#318](https://github.com/uniskela/ts6-manager/issues/318)) ([bd6a70b](https://github.com/uniskela/ts6-manager/commit/bd6a70bf003d419c9ffee46332552685dc80bb86))
* **voice:** make TS client cleanup idempotent ([#347](https://github.com/uniskela/ts6-manager/issues/347)) ([e42ed57](https://github.com/uniskela/ts6-manager/commit/e42ed572d5f5168ad69f7add7889955e73afdbd4))

## [1.9.3](https://github.com/uniskela/ts6-manager/compare/v1.9.2...v1.9.3) (2026-10-01)


### Bug Fixes

* **frontend:** hide app version on login and setup ([#234](https://github.com/uniskela/ts6-manager/issues/234)) ([9344180](https://github.com/uniskela/ts6-manager/commit/9344180ccf044240215cc0de0f03886eb0f92f3d))
* **media:** accurate key-fetch errors, first stop toast, single playback command ([#247](https://github.com/uniskela/ts6-manager/issues/247)) ([ea5eb34](https://github.com/uniskela/ts6-manager/commit/ea5eb34c5087ff12c0d8b0807a6785dd1b2c6883))
* **sidecar:** keep video RTP packets under the MTU ([#230](https://github.com/uniskela/ts6-manager/issues/230)) ([e4bd82f](https://github.com/uniskela/ts6-manager/commit/e4bd82f09647dd119b4334c5bc7937dc5cbf8d36))
* **sidecar:** say when TeamSpeak viewers cannot reach the offered address ([#246](https://github.com/uniskela/ts6-manager/issues/246)) ([7737c20](https://github.com/uniskela/ts6-manager/commit/7737c20b4e9295d1040c04581ae022d8b74b0203))
* **streaming:** let the web UI preview play H.264 streams ([#240](https://github.com/uniskela/ts6-manager/issues/240)) ([719f86d](https://github.com/uniskela/ts6-manager/commit/719f86deb9bd4fe8e3128863186ad17bc9a2b950))
* **streaming:** say when a YouTube video is over the duration limit ([#235](https://github.com/uniskela/ts6-manager/issues/235)) ([cfda184](https://github.com/uniskela/ts6-manager/commit/cfda184ce9c74a88116d040b12a71ec130b0db51))
* **streaming:** start chat !stream at Auto quality for YouTube and Twitch links ([#241](https://github.com/uniskela/ts6-manager/issues/241)) ([bbd8ad5](https://github.com/uniskela/ts6-manager/commit/bbd8ad5ab09a219f83286418172fe04dd4ec84fd))
* **ui:** move IPTV local hosts into header dialog ([#242](https://github.com/uniskela/ts6-manager/issues/242)) ([379de02](https://github.com/uniskela/ts6-manager/commit/379de02e77c860f296a7aa661aa31fe2938a1a65))
* **voice:** clear stale Live mode before YouTube sources are ready ([#239](https://github.com/uniskela/ts6-manager/issues/239)) ([540ebd7](https://github.com/uniskela/ts6-manager/commit/540ebd7ecd8b17603b3f4769138fc30caa4a6698))
* **voice:** fail fast when TeamSpeak refuses a bot's clientinit ([#245](https://github.com/uniskela/ts6-manager/issues/245)) ([d2e3b95](https://github.com/uniskela/ts6-manager/commit/d2e3b95c639247c463483260d2f665404b5c2c81))
* **voice:** give a new bot an identity the server accepts ([#236](https://github.com/uniskela/ts6-manager/issues/236)) ([2d9909d](https://github.com/uniskela/ts6-manager/commit/2d9909d45aa275c036e534d25664360836c41e16))
* **voice:** read every client of a connect-time enter-view ([#232](https://github.com/uniskela/ts6-manager/issues/232)) ([0bc9f14](https://github.com/uniskela/ts6-manager/commit/0bc9f141276638e655de1c8fd3ee4b1e123fca6a))

## [1.9.2](https://github.com/uniskela/ts6-manager/compare/v1.9.1...v1.9.2) (2026-10-01)


### Bug Fixes

* close stale webui-preview peer before offer ([#202](https://github.com/uniskela/ts6-manager/issues/202)) ([#222](https://github.com/uniskela/ts6-manager/issues/222)) ([e6da0a0](https://github.com/uniskela/ts6-manager/commit/e6da0a0301cf6478a373b1a61f9c62ca83d8f786))
* keep watched video streams alive on channel-empty auto-stop ([#215](https://github.com/uniskela/ts6-manager/issues/215)) ([#225](https://github.com/uniskela/ts6-manager/issues/225)) ([6f0bc1f](https://github.com/uniskela/ts6-manager/commit/6f0bc1f12c7bfc8a251ae630b677f6a91afaddcd))
* prefer SDR VP9 over AV1 for YouTube video streams ([#226](https://github.com/uniskela/ts6-manager/issues/226)) ([8f4afe8](https://github.com/uniskela/ts6-manager/commit/8f4afe8a910d8c57cca2b39f522411bb9dfd47b7))

## [1.9.1](https://github.com/uniskela/ts6-manager/compare/v1.9.0...v1.9.1) (2026-09-30)


### Bug Fixes

* preview ICE timeout and loopback NAT misconfig ([#202](https://github.com/uniskela/ts6-manager/issues/202)) ([88932f5](https://github.com/uniskela/ts6-manager/commit/88932f57df8657df7f9e89139f4a3ff31df8dd4b))

## [1.9.0](https://github.com/uniskela/ts6-manager/compare/v1.8.5...v1.9.0) (2026-09-30)


### Features

* 1.9.0 media — Bot Hub, single media session, [#150](https://github.com/uniskela/ts6-manager/issues/150) streaming, [#72](https://github.com/uniskela/ts6-manager/issues/72) diagnostics ([#192](https://github.com/uniskela/ts6-manager/issues/192)) ([cb8f9d8](https://github.com/uniskela/ts6-manager/commit/cb8f9d8494a077d16aa2fa7a3bf07964db26d625))
* allow LAN IPTV hosts and harden stream start (ICE, refusals, flood hold) ([#199](https://github.com/uniskela/ts6-manager/issues/199)) ([32ff88a](https://github.com/uniskela/ts6-manager/commit/32ff88acea1442fdb03cdc89d364489152dc1450))
* Media Bot UX and encode profiles ([#209](https://github.com/uniskela/ts6-manager/issues/209)) ([407ac97](https://github.com/uniskela/ts6-manager/commit/407ac97f02041d89a66c34842a847a122066fc7a))
* Media Bots Requests tab for !play history ([#211](https://github.com/uniskela/ts6-manager/issues/211)) ([ca35af6](https://github.com/uniskela/ts6-manager/commit/ca35af6f60cf2a3ece25443538f888681f280f91))


### Bug Fixes

* clearer stream errors and media-start Bot Hub toast ([#214](https://github.com/uniskela/ts6-manager/issues/214)) ([bcc8a68](https://github.com/uniskela/ts6-manager/commit/bcc8a6868d0457b9ceb8621d18c2c6bc20629d86))
* publish WebRTC UDP mux for Docker browser preview ([#208](https://github.com/uniskela/ts6-manager/issues/208)) ([7f181be](https://github.com/uniskela/ts6-manager/commit/7f181be72ea9cc9daa8733a0911b095f6e36f655))
* say media bots in Bot Hub and Media Bots copy ([#213](https://github.com/uniskela/ts6-manager/issues/213)) ([384beba](https://github.com/uniskela/ts6-manager/commit/384beba036d8c16008cc2c8971061ad2cff31e48))
* Twitch live URLs ([#203](https://github.com/uniskela/ts6-manager/issues/203)) and browser preview ICE ([#202](https://github.com/uniskela/ts6-manager/issues/202)) ([#204](https://github.com/uniskela/ts6-manager/issues/204)) ([1d5c220](https://github.com/uniskela/ts6-manager/commit/1d5c2206684f715b3c15bfe1bebfd026091cec3c))

## [1.8.5](https://github.com/uniskela/ts6-manager/compare/v1.8.4...v1.8.5) (2026-09-29)


### Bug Fixes

* ship Deno for yt-dlp YouTube n-challenge solving ([#187](https://github.com/uniskela/ts6-manager/issues/187)) ([30a8dc6](https://github.com/uniskela/ts6-manager/commit/30a8dc670addabd1c26c0008f4f468c434350c12))
* surface native metrics failures and soften scrape race ([#190](https://github.com/uniskela/ts6-manager/issues/190)) ([2415dc0](https://github.com/uniskela/ts6-manager/commit/2415dc0cfd453d2062fb88b2df2f197562336c40))

## [1.8.4](https://github.com/uniskela/ts6-manager/compare/v1.8.3...v1.8.4) (2026-09-27)


### Bug Fixes

* sidebar fit, badge contrast, and tab overflow follow-ups to [#177](https://github.com/uniskela/ts6-manager/issues/177) ([aae476d](https://github.com/uniskela/ts6-manager/commit/aae476d130962951d44499ea7fb55efde4594efe))
* UI/UX audit follow-ups for navigation, mobile chrome, and accessibility ([512ff44](https://github.com/uniskela/ts6-manager/commit/512ff44825ab914681031aba836a5490bfd0dca1))

## [1.8.3](https://github.com/uniskela/ts6-manager/compare/v1.8.2...v1.8.3) (2026-09-27)


### Bug Fixes

* re-resolve WebQuery host after keep-alive peer death ([#173](https://github.com/uniskela/ts6-manager/issues/173)) ([8fe807b](https://github.com/uniskela/ts6-manager/commit/8fe807b10479e564d6fa3641471cf6d64d0429d4)), closes [#166](https://github.com/uniskela/ts6-manager/issues/166)
* show hidden sidebar destinations and resolve server context before guidance ([ab75757](https://github.com/uniskela/ts6-manager/commit/ab75757616941c44a4dc680d832c3738ce3e1209))
* UI/UX audit follow-ups for empty states and onboarding ([#174](https://github.com/uniskela/ts6-manager/issues/174)) ([42eb3cd](https://github.com/uniskela/ts6-manager/commit/42eb3cde076c54ec7d35ef9b96e47522e902df75))

## [1.8.2](https://github.com/uniskela/ts6-manager/compare/v1.8.1...v1.8.2) (2026-09-25)


### Bug Fixes

* defer WebQuery channel edits until EventBridge ready ([#171](https://github.com/uniskela/ts6-manager/issues/171)) ([7d5ec10](https://github.com/uniskela/ts6-manager/commit/7d5ec10d0df1ca12adf60e719d0dab18c6861942))
* harden Activity Journal leave capture and status ([#169](https://github.com/uniskela/ts6-manager/issues/169)) ([2355bfd](https://github.com/uniskela/ts6-manager/commit/2355bfd1aa68de4bf76141046a8a8f26e75cbf10))
* stop Files summary scan from flooding Query ([#168](https://github.com/uniskela/ts6-manager/issues/168)) ([6e2171a](https://github.com/uniskela/ts6-manager/commit/6e2171a3927b05e2839103c4ed1ed8db6ffeb258))

## [1.8.1](https://github.com/uniskela/ts6-manager/compare/v1.8.0...v1.8.1) (2026-09-25)


### Bug Fixes

* clear server selection on logout ([#158](https://github.com/uniskela/ts6-manager/issues/158)) ([c70af91](https://github.com/uniskela/ts6-manager/commit/c70af913a491e38e145acc5f33b17ca231cc9225))
* map fatal SSH auth to non-retryable Files error ([#161](https://github.com/uniskela/ts6-manager/issues/161)) ([ffc45af](https://github.com/uniskela/ts6-manager/commit/ffc45af8ce8662eb7054739a2f504e18d673156c))
* recover Files browser after SSH flood disconnect ([#159](https://github.com/uniskela/ts6-manager/issues/159)) ([ad919d1](https://github.com/uniskela/ts6-manager/commit/ad919d1d421e7f738c8cd12dac24f6f3927c6888))

## [1.8.0](https://github.com/uniskela/ts6-manager/compare/v1.7.1...v1.8.0) (2026-09-24)


### Features

* appearance backgrounds and motion ([#122](https://github.com/uniskela/ts6-manager/issues/122)) ([d11065f](https://github.com/uniskela/ts6-manager/commit/d11065fa9c4d5715c8d9cd5aa820c33db6283010))
* custom CSS and safe-ui recovery ([#128](https://github.com/uniskela/ts6-manager/issues/128)) ([2ff7736](https://github.com/uniskela/ts6-manager/commit/2ff7736ef514d8eee67ba5cbd8a73a08518fdd04))
* native TeamSpeak metrics scrape ([#126](https://github.com/uniskela/ts6-manager/issues/126)) ([0f0cbf4](https://github.com/uniskela/ts6-manager/commit/0f0cbf46d871308ea0891893e9270e79fefe72fa))
* staged TeamSpeak connection diagnostics ([#114](https://github.com/uniskela/ts6-manager/issues/114)) ([2a096bf](https://github.com/uniskela/ts6-manager/commit/2a096bf7411fe1e44e9d000d93fe1731615cff34))
* server logs 2.0 with paging, filters, and logview I/O hardening ([#132](https://github.com/uniskela/ts6-manager/issues/132), [#137](https://github.com/uniskela/ts6-manager/issues/137), [#139](https://github.com/uniskela/ts6-manager/issues/139), [#142](https://github.com/uniskela/ts6-manager/issues/142)) ([e01d024](https://github.com/uniskela/ts6-manager/commit/e01d024a398c25308f3a7234872000523718e6c1))
* administrative audit log with channel/permission coverage and live refresh ([#134](https://github.com/uniskela/ts6-manager/issues/134), [#135](https://github.com/uniskela/ts6-manager/issues/135), [#140](https://github.com/uniskela/ts6-manager/issues/140)) ([168e820](https://github.com/uniskela/ts6-manager/commit/168e82042833cbd42841bd0d0d90d2d5e0b21740))
* TeamSpeak activity journal with capture auto-refresh and clearer history layout ([#133](https://github.com/uniskela/ts6-manager/issues/133), [#136](https://github.com/uniskela/ts6-manager/issues/136), [#138](https://github.com/uniskela/ts6-manager/issues/138)) ([b56a88e](https://github.com/uniskela/ts6-manager/commit/b56a88e9033e475deb757ab3428f46802f01f473))
* add !here chat command to summon music bots ([#112](https://github.com/uniskela/ts6-manager/issues/112)) ([bdcbaf3](https://github.com/uniskela/ts6-manager/commit/bdcbaf3516cb4b886e87e3019133af7cc2964b24))
* add music-bot chat command presets ([#119](https://github.com/uniskela/ts6-manager/issues/119)) ([599edb3](https://github.com/uniskela/ts6-manager/commit/599edb3447d71d81204b8ee5242ada98973cf327))
* add IPTV playlist file upload ([#109](https://github.com/uniskela/ts6-manager/issues/109)) ([9778db1](https://github.com/uniskela/ts6-manager/commit/9778db15b803cc82d45a5522042be1842e91b535))
* brand status widgets and link to GitHub ([#131](https://github.com/uniskela/ts6-manager/issues/131)) ([a91fcb8](https://github.com/uniskela/ts6-manager/commit/a91fcb810e8b81d9b63bfc78feb21b542de097f8))
* bootstrap local pr-test stack with beta13 TeamSpeak ([#116](https://github.com/uniskela/ts6-manager/issues/116)) ([6abafe2](https://github.com/uniskela/ts6-manager/commit/6abafe2f81a309f1bdfe06b82abdef701b4bdbc4))


### Bug Fixes

* bind file and draft actions to owner context ([#144](https://github.com/uniskela/ts6-manager/issues/144)) ([fe48e95](https://github.com/uniskela/ts6-manager/commit/fe48e95a98946f3ec61bee454b9fc6bec76381dc))
* make expensive diagnostics demand-driven ([#146](https://github.com/uniskela/ts6-manager/issues/146)) ([64f98a7](https://github.com/uniskela/ts6-manager/commit/64f98a7afc35bf821295c16d3d985df4aac651a3))
* bound storage summary scans and coverage labels ([#151](https://github.com/uniskela/ts6-manager/issues/151)) ([9e72b3e](https://github.com/uniskela/ts6-manager/commit/9e72b3eb2bb74e654d37b46335f326fa0c9dbfd1))
* surface action-local permission and compatibility guidance ([#152](https://github.com/uniskela/ts6-manager/issues/152)) ([3a37d92](https://github.com/uniskela/ts6-manager/commit/3a37d9268da53da1ad80cdc04bc1215d7bd4285d))
* add demand-driven runtime and media diagnostics ([#153](https://github.com/uniskela/ts6-manager/issues/153)) ([aa926b5](https://github.com/uniskela/ts6-manager/commit/aa926b5dd3c84987421422d95a5630b083c12b19))
* keep history and capture status labels honest ([#155](https://github.com/uniskela/ts6-manager/issues/155)) ([d2fcd6b](https://github.com/uniskela/ts6-manager/commit/d2fcd6b5b04a33dc0bfdb45f1e9cf722df01170a))
* keep SSH helper on human channels during music bot reconnect ([#143](https://github.com/uniskela/ts6-manager/issues/143)) ([9df08fd](https://github.com/uniskela/ts6-manager/commit/9df08fd7f2b50c3d7f3ba72dacba4989405edf3b))
* drop git sha from sidebar version label ([#113](https://github.com/uniskela/ts6-manager/issues/113)) ([308d4b0](https://github.com/uniskela/ts6-manager/commit/308d4b031270acf2d778c8465d4b9b8d0cf1768f))
* **sidecar:** stop an unreachable STUN server delaying every viewer by 5s ([48d4d16](https://github.com/uniskela/ts6-manager/commit/48d4d1648a58757b02c6fc3df4f62f281191c3dc))

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
