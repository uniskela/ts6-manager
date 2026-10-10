package main

import "runtime"

// hostOS is the operating system the sidecar runs on; tests replace it.
var hostOS = runtime.GOOS

// backendUnsupportedReason says why a GPU backend cannot exist on this
// operating system, or "" when it can. VAAPI is a Linux API and VideoToolbox a
// macOS framework, so elsewhere their probes are skipped with this reason
// rather than reporting ffmpeg's "Unknown encoder". NVENC and AMF have drivers
// on more than one system and are left to their test encodes.
func backendUnsupportedReason(backend string) string {
	switch backend {
	case backendVAAPI:
		if hostOS != "linux" {
			return "VAAPI is only available on Linux"
		}
	case backendVideoToolbox:
		if hostOS != "darwin" {
			return "VideoToolbox is only available on macOS"
		}
	}
	return ""
}
