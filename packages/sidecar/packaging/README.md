# TS6 Manager native media sidecar

This archive holds the optional native build of the TS6 Manager media sidecar.
Docker remains the recommended way to run TS6 Manager; use this build when the
sidecar needs the host's GPU encoders (AMF, NVENC, VAAPI, VideoToolbox).

The binary must come from the same release as the backend it serves. Check it
with `ts6-media-sidecar --version`.

FFmpeg and ffprobe are not included. Install a build that has the encoders you
want and point `FFMPEG_PATH` / `FFPROBE_PATH` at it.

Setup, service installation, networking and security are documented at
<https://github.com/uniskela/ts6-manager/blob/main/docs/public/native-sidecar.md>.

Files:

- `sidecar.env.example`: settings to copy to `sidecar.env` and edit.
- Linux: `ts6-media-sidecar.service` (systemd unit).
- macOS: `com.uniskela.ts6-media-sidecar.plist` (launchd daemon).
- Windows: `Start-Sidecar.ps1` (runs the sidecar with `sidecar.env`) and
  `Register-SidecarTask.ps1` (starts it in the background with Task Scheduler).
