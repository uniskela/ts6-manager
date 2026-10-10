# Native media sidecar

TS6 Manager is deployed with Docker, and the Docker media sidecar is the recommended way to stream video. The native sidecar is an optional companion for one case: the sidecar has to run directly on a host to reach that host's GPU encoder. The usual examples are AMD AMF on Windows and Apple VideoToolbox on macOS, which a Linux container cannot use.

Only the sidecar runs natively. The frontend and backend stay in Docker, and the backend's `SIDECAR_URL` points at the native process. This is the same sidecar program as the Docker image, built from the same source.

If Docker already gives you the encoder you want, stay on Docker. [VAAPI](video-streaming.md#enabling-vaapi-intel--amd-gpus) and [NVENC](video-streaming.md#enabling-nvenc-nvidia-gpus) in the Docker sidecar are unchanged.

## Downloads

Each [GitHub Release](https://github.com/uniskela/ts6-manager/releases) from 1.11.0 onwards carries sidecar archives built by CI from that release's tag:

| Platform | Asset |
|---|---|
| Windows x64 | `ts6-media-sidecar_<version>_windows_amd64.zip` |
| Linux x64 | `ts6-media-sidecar_<version>_linux_amd64.tar.gz` |
| Linux ARM64 | `ts6-media-sidecar_<version>_linux_arm64.tar.gz` |
| macOS Intel | `ts6-media-sidecar_<version>_macos_amd64.tar.gz` |
| macOS Apple Silicon | `ts6-media-sidecar_<version>_macos_arm64.tar.gz` |
| Checksums | `SHA256SUMS` |

Each archive contains the binary, `sidecar.env.example`, the service files for that platform and the licence notices. FFmpeg is not included.

Download and verify on Linux or macOS:

```bash
VERSION=1.11.0   # the release your backend runs
ASSET="ts6-media-sidecar_${VERSION}_linux_amd64.tar.gz"
BASE="https://github.com/uniskela/ts6-manager/releases/download/v${VERSION}"
curl -fsSLO "$BASE/$ASSET"
curl -fsSLO "$BASE/SHA256SUMS"
grep " $ASSET\$" SHA256SUMS | sha256sum --check   # macOS: shasum -a 256 --check
tar -xzf "$ASSET"
```

On Windows, in PowerShell:

```powershell
$Version = "1.11.0"   # the release your backend runs
$Asset = "ts6-media-sidecar_${Version}_windows_amd64.zip"
$Base = "https://github.com/uniskela/ts6-manager/releases/download/v$Version"
Invoke-WebRequest "$Base/$Asset" -OutFile $Asset
Invoke-WebRequest "$Base/SHA256SUMS" -OutFile SHA256SUMS
$expected = (Select-String -Path SHA256SUMS -Pattern ([regex]::Escape($Asset))).Line.Split(' ')[0]
if ((Get-FileHash $Asset -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch" }
Expand-Archive $Asset -DestinationPath C:\ts6-sidecar
```

The binaries are not code-signed or notarized. Windows SmartScreen and macOS Gatekeeper may warn about a file downloaded with a browser; on macOS, `xattr -d com.apple.quarantine ts6-media-sidecar` clears the quarantine flag after you have verified the checksum.

No binaries are stored in the Git repository. To build from source instead, see [Building from source](#building-from-source).

## Version compatibility

Run the sidecar from the **same release** as the backend. The two are built from one tag and their HTTP contract changes between releases, so no other pairing is tested.

| Backend | Sidecar | Status |
|---|---|---|
| X.Y.Z | X.Y.Z (release archive or Docker image of the same tag) | Supported |
| X.Y.Z | Any other release, including a different patch | Not supported. It may work; diagnostics report the mismatch |
| 1.11.0 or newer | 1.10.x or older (reports no version) | Not supported. Shown as `unversioned` |
| Any | Source build without a version (`dev`) | Cannot be checked. Shown as `dev` |

Docker deployments always match when backend and sidecar use the same image tag. A native sidecar is installed separately, so it stays behind when you pull new images. Replace it as part of every upgrade.

To check a pairing:

- `ts6-media-sidecar --version` prints the binary's release, operating system and architecture.
- `GET /health` on the sidecar returns `version`, `os` and `arch`.
- In the web UI, the **Runtime / media** panel (Settings, and Media Library → Streaming defaults) shows the sidecar's version and says when it differs from the backend's.

A mismatch does not block streaming. It is a warning that the pair is untested.

## Requirements

- A backend of the same release, reachable over a private network.
- FFmpeg and ffprobe on the sidecar host, from a build that includes the encoders you want. Software encoding needs `libvpx` and `libx264`.
- A directory holding the same media files the backend sees (see [Shared media](#shared-media)).
- A UDP port that TeamSpeak clients and browsers can reach on the sidecar host.

## Configuration

Copy `sidecar.env.example` to `sidecar.env` and edit it. The file holds a secret, so keep it readable only by the account that runs the sidecar.

| Variable | Set it to |
|---|---|
| `SIDECAR_SECRET` | The same value as the backend's `SIDECAR_SECRET`. Required: without it the sidecar refuses every request except `/health` |
| `SIDECAR_HOST` | The address the HTTP API listens on. Empty means every interface |
| `SIDECAR_PORT` | HTTP API port, default `9800` |
| `WEBRTC_UDP_PORT` | UDP port for media, for example `10000` |
| `WEBRTC_NAT1TO1_IP` | IPv4 address or addresses viewers use to reach this host, comma-separated |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Full paths. Background services do not inherit your shell's `PATH` |
| `MUSIC_DIR` | The shared media directory as this host sees it |

All sidecar variables are listed under [Environment variables](environment-variables.md#media-sidecar).

On the backend, set `SIDECAR_URL` to the sidecar's private address and `SIDECAR_SECRET` to the same secret. In production the backend refuses to start with `SIDECAR_URL` set and no secret.

### Shared media

Local files and downloaded clips must be visible to both processes. Mount the directory into the backend at its `MUSIC_DIR` (for example `/data/music`) and set the sidecar's `MUSIC_DIR` to the same files as the host sees them. The backend sends a portable `music://filename` reference, which the sidecar resolves under its own directory and rejects if it escapes it. HTTP and HTTPS sources need no shared directory.

## Running as a background service

The archives ship one small service file per platform. None of them is a full installer: each starts the binary with the settings in `sidecar.env`.

### Linux (systemd)

```bash
sudo install -m 0755 ts6-media-sidecar /usr/local/bin/ts6-media-sidecar
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ts6-sidecar
sudo install -d -m 0750 /etc/ts6-media-sidecar
sudo install -m 0600 sidecar.env.example /etc/ts6-media-sidecar/sidecar.env
sudoedit /etc/ts6-media-sidecar/sidecar.env
sudo install -m 0644 ts6-media-sidecar.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ts6-media-sidecar
journalctl -u ts6-media-sidecar -f
```

The unit runs as an unprivileged `ts6-sidecar` user with a read-only system. Two settings usually need attention:

- **VAAPI** opens `/dev/dri/renderD*`. Uncomment `SupplementaryGroups=` in the unit and keep the groups that exist on your distribution (`render`, sometimes `video`).
- **Media under `/home`** is hidden by `ProtectHome=true`. Keep `MUSIC_DIR` elsewhere, such as `/srv/ts6/music`, or change the setting to `read-only`.

The `ts6-sidecar` user must be able to read `MUSIC_DIR`.

### macOS (launchd)

```bash
sudo install -m 0755 ts6-media-sidecar /usr/local/bin/ts6-media-sidecar
sudo install -d -m 0750 /usr/local/etc/ts6-media-sidecar
sudo install -m 0600 sidecar.env.example /usr/local/etc/ts6-media-sidecar/sidecar.env
sudo nano /usr/local/etc/ts6-media-sidecar/sidecar.env
sudo install -m 0644 com.uniskela.ts6-media-sidecar.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/com.uniskela.ts6-media-sidecar.plist
tail -f /var/log/ts6-media-sidecar.log
```

launchd has no environment file, so the daemon starts a shell that loads `sidecar.env` and then becomes the sidecar. It runs as root unless you add a `UserName` key to the plist. Homebrew's FFmpeg is at `/opt/homebrew/bin/ffmpeg` on Apple Silicon and `/usr/local/bin/ffmpeg` on Intel; put the full path in `FFMPEG_PATH`.

Stop and remove it with `sudo launchctl bootout system/com.uniskela.ts6-media-sidecar`.

### Windows (Task Scheduler)

The sidecar is a console program and does not register as a Windows service. Task Scheduler runs it in the background instead. From an elevated PowerShell in the extracted folder, after creating `sidecar.env`:

```powershell
.\Register-SidecarTask.ps1                    # start when you sign in (default)
.\Register-SidecarTask.ps1 -Trigger Startup   # start at boot, with nobody signed in
```

The script restricts `sidecar.env` to the task's user, SYSTEM and Administrators, registers a task named **TS6 Media Sidecar** that restarts on failure, and starts it. The default trigger runs the sidecar in your own session, where GPU encoders are available. A task started at boot runs without a desktop session and GPU encoders may not initialise there, so run **Check encoders** after choosing `-Trigger Startup`.

To run it in the foreground for a first test, use `.\Start-Sidecar.ps1`. Remove the task with `Unregister-ScheduledTask -TaskName 'TS6 Media Sidecar' -Confirm:$false`.

If you need a true Windows service, wrap `Start-Sidecar.ps1` with a service wrapper of your choice. The project does not ship or test one.

## Network and security

The sidecar's HTTP API is a private control channel between the backend and the sidecar. It is not designed to face the Internet.

- **`SIDECAR_SECRET` is mandatory.** Every endpoint that starts, stops or inspects a stream requires it as a bearer token, and a sidecar without a secret rejects them all. Generate it with `openssl rand -base64 32`, give the same value to the backend, and never reuse `JWT_SECRET` or `ENCRYPTION_KEY`. Store it in `sidecar.env` or your service manager's secret store, not on a command line.
- **`/health` is unauthenticated.** It returns the status, media ports, version and platform. This is one reason the API must stay on a trusted network even with a strong secret.
- **The secret travels in clear text over HTTP.** Keep the backend-to-sidecar path on the same host, a private LAN segment you control, or an encrypted overlay such as Tailscale or WireGuard. Across untrusted networks, put the API behind an HTTPS reverse proxy or a tunnel.
- **Bind narrowly.** Set `SIDECAR_HOST` to the single address the backend uses. `127.0.0.1` is right when the backend runs on the same host outside Docker.
- **Firewall the HTTP port.** Allow TCP `9800` only from the backend's address. Allow the WebRTC UDP port from the networks your viewers are on. Do not disable the firewall to troubleshoot.
- **Never publish TCP `9800` to the Internet,** and do not port-forward it.

### Backend in Docker, sidecar on the same host

A container cannot reach the host's `127.0.0.1`, so `SIDECAR_HOST=127.0.0.1` does not work here.

- **Docker Desktop (Windows, macOS):** set `SIDECAR_URL=http://host.docker.internal:9800`. Leave `SIDECAR_HOST` empty and restrict TCP `9800` with the host firewall as described above.
- **Linux:** add `extra_hosts: ["host.docker.internal:host-gateway"]` to the backend service, set `SIDECAR_URL=http://host.docker.internal:9800`, and set `SIDECAR_HOST` to the Docker bridge gateway address on the host (often `172.17.0.1`; check `docker network inspect`). Rootless Docker routes host access differently and has not been tested.

The WebRTC UDP port belongs to the native process. It needs no Docker port mapping, and the compose-only `WEBRTC_BIND_IP` setting does not apply. The TeamSpeak client does not use loopback, even on the same machine, so `WEBRTC_NAT1TO1_IP` must include a LAN or Tailscale IPv4 address.

## Hardware encoders

The sidecar never assumes an encoder exists. **Check encoders** (Media Library → Streaming defaults) runs a short real encode for each one with the configured FFmpeg, and only encoders that pass are treated as available. If a hardware encoder fails while starting a stream, the sidecar restarts with the software encoder of the same codec and the stream panel shows why.

| Host | Hardware encoders | Software fallback |
|---|---|---|
| Windows | H.264 AMF (AMD), H.264 NVENC (NVIDIA) | VP8, VP9, H.264 |
| Linux | H.264 / VP8 / VP9 VAAPI (Intel, AMD), H.264 NVENC (NVIDIA) | VP8, VP9, H.264 |
| macOS | H.264 VideoToolbox (Apple Silicon, and Intel Macs with a hardware H.264 encoder) | VP8, VP9, H.264 |

Encoders that cannot exist on the host's operating system are skipped without running FFmpeg: VAAPI off Linux, VideoToolbox off macOS. Only codecs the TeamSpeak client renders are selectable. HEVC and AV1 are not offered even when FFmpeg lists them.

Setup for each encoder is under [Video streaming → Encoders](video-streaming.md#encoders). For a native sidecar the Docker-specific steps (device passthrough, the NVIDIA compose override) do not apply; the host driver and an FFmpeg build with that encoder are what matter.

## What has and has not been verified

Release archives are compiled for every platform in the table above, and CI runs the sidecar's tests, including real FFmpeg software encodes, on Linux x64. Beyond that, the project has **not** verified the following. Treat them as expected to work, and report results.

| Combination | Status |
|---|---|
| Linux x64, software encoders | Tested in CI |
| Linux x64 native, VAAPI or NVENC | Not verified natively. The same encoder code runs in the Docker sidecar |
| Linux ARM64, any encoder | Compiled only. Not run on ARM hardware |
| Windows x64, software encoders | Compiled only in CI |
| Windows x64, AMF | Not verified on AMD hardware by the project, including TeamSpeak playback and late joins ([#361](https://github.com/uniskela/ts6-manager/issues/361)) |
| Windows x64, NVENC | Not verified |
| macOS Intel and Apple Silicon, software encoders | Compiled only. Not run on macOS |
| macOS, H.264 VideoToolbox | Unit-tested arguments only. Not run on Apple hardware; TeamSpeak playback unconfirmed |
| VideoToolbox from a launchd daemon (no user session) | Not verified |
| systemd unit, launchd plist, Windows scheduled task | Written from each platform's documentation. Not exercised on real hosts |
| Windows task with `-Trigger Startup` and a GPU encoder | Not verified |
| Docker Desktop backend reaching a native sidecar | Described for Windows in [Video streaming](video-streaming.md#amd-amf-windows). Not verified on macOS |
| Rootless Docker backend reaching a native sidecar | Not verified |

## Upgrading

1. Download the archive for the release you are upgrading to and verify its checksum.
2. Stop the sidecar service, replace the binary, and start it again.
3. Upgrade the backend and frontend images to the same release.
4. Open **Runtime / media** and confirm the sidecar version matches, then run **Check encoders**.

## Building from source

Use Go 1.26.9 or newer and a checkout of the release tag your backend runs:

```bash
git checkout v1.11.0
cd packages/sidecar
go build -ldflags "-X main.version=1.11.0" -o ts6-media-sidecar .
```

Without the `-ldflags` option the binary reports `dev` and the version check cannot confirm it. `scripts/sidecar/build-release.sh <version>` builds the same archives CI publishes, into the git-ignored `dist/sidecar/`.
