# Isolated media fetcher

Remote radio PCM. The backend never joins `ts6_fetch`. The fetcher never joins the app network. Radio fails closed if this service is not running.

## Landlock (mandatory)

`ll-wrap` must report **Landlock ABI >= 4** (TCP `CONNECT`, Linux **6.7+**) plus a filesystem allow-list that excludes `/jobs` and `/ctl`. On ABI >= 9 it also handles pathname UNIX resolve (denied; no path grants it). If the wrapper is missing, the syscall is blocked, ABI is older, FS rules fail, or `LL_WRAP=0` / `MEDIA_FETCHER_DISABLE_LANDLOCK=1` is set, the fetcher **exits** and does not spawn ffmpeg. PID bind on the shim is a second layer, not a fallback. Proxy control uses a separate `/ctl/.ctl-token` Bearer secret; unauthenticated ctl requests are rejected on every supported ABI.

| Host / config | Result |
|---|---|
| Linux 6.7+ with Landlock LSM | Fetcher starts |
| Linux 6.1 LTS, 5.x, or ABI 1–3 only | Fetcher refuses to start |
| Seccomp/AppArmor denying landlock syscalls | Fetcher refuses to start |
| `unshare(CLONE_NEWNET)` | Still EPERM under default Docker; not used |
| Rootful Docker | Unverified in this environment |

Same runtime family as `Dockerfile.backend` production: `node:20-slim` + Debian ffmpeg. `ll-wrap` is compiled in-image (bookworm glibc). The overlay image tag is `ts6-media-fetcher:local`; it is not published with the GHCR backend/frontend/sidecar images.

Host token stays mode `600`. `install-token.mjs` (container uid 0 with only `CAP_DAC_OVERRIDE` + `CAP_CHOWN`) copies it to `/jobs/.token` and writes `/ctl/.ctl-token` as uid 1000 mode 600. World-readable tokens are refused. The backend never mounts `/ctl`.

## No legacy fallback

`AudioPipeline.toPcmStream` always submits to this fetcher. `MEDIA_FETCHER` unset, `0`, or `legacy` does not start in-process ffmpeg. Filename extensions and `RADIO_ALLOW_HLS` are not safety controls. Operator guide: [Radio fetcher](../../docs/public/radio-fetcher.md).
