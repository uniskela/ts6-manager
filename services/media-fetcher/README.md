# Isolated media fetcher

Remote radio PCM. The backend never joins `ts6_fetch`. The fetcher never joins the app network. Radio fails closed if this service is not running.

## Landlock (mandatory)

`ll-wrap` must report **Landlock ABI >= 4** (TCP `CONNECT`, Linux **6.7+**) and apply a CONNECT-only rule to that job’s loopback shim port. If the wrapper is missing, the syscall is blocked, ABI is older, or `LL_WRAP=0` / `MEDIA_FETCHER_DISABLE_LANDLOCK=1` is set, the fetcher **exits** and does not spawn ffmpeg. PID bind on the shim is a second layer, not a fallback.

| Host / config | Result |
|---|---|
| Linux 6.7+ with Landlock LSM | Fetcher starts |
| Linux 6.1 LTS, 5.x, or ABI 1–3 only | Fetcher refuses to start |
| Seccomp/AppArmor denying landlock syscalls | Fetcher refuses to start |
| `unshare(CLONE_NEWNET)` | Still EPERM under default Docker; not used |
| Rootful Docker | Unverified in this environment |

Same runtime family as `Dockerfile.backend` production: `node:20-slim` + Debian ffmpeg. `ll-wrap` is compiled in-image (bookworm glibc).

## No legacy fallback

`AudioPipeline.toPcmStream` always submits to this fetcher. `MEDIA_FETCHER` unset, `0`, or `legacy` does not start in-process ffmpeg. Filename extensions and `RADIO_ALLOW_HLS` are not safety controls. Operator guide: [Radio fetcher](../../docs/public/radio-fetcher.md).
