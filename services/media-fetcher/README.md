# Isolated media fetcher

Radio PCM for `MEDIA_FETCHER=1`. Backend never joins `ts6_fetch`. Fetcher never joins the app network.

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

## Legacy radio (not the default yet)

With `MEDIA_FETCHER` unset, `AudioPipeline.toPcmStream` still uses in-process ffmpeg + the checking proxy. That path does not close the Debian HLS `httpproxy` SSRF. `RADIO_ALLOW_HLS=0` only rejects `.m3u8` suffixes and is **not** comprehensive HLS prevention. A fail-closed default (radio requires the fetcher) is proposed; it is **not** enabled in this change.
