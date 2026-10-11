package main

import "runtime"

// hostOS is the operating system the sidecar runs on; tests replace it.
var hostOS = runtime.GOOS

// backendUnsupportedReason says why a GPU backend cannot exist on this
// operating system, or "" when it can. Such an encoder is neither test-encoded
// nor launched: its row in GET /encoders carries this reason instead of
// ffmpeg's "Unknown encoder", and a stream that asks for it starts on the
// software encoder of the same codec.
//
// VideoToolbox is a macOS framework. AMF has drivers for Windows and Linux but
// none for macOS. VAAPI and NVENC are left as they were: VAAPI is decided by
// its device node and NVENC by its test encode, so what a Linux or Windows
// sidecar reports for the encoders it already had does not change.
func backendUnsupportedReason(backend string) string {
	switch backend {
	case backendVideoToolbox:
		if hostOS != "darwin" {
			return "VideoToolbox is only available on macOS"
		}
	case backendAMF:
		if hostOS == "darwin" {
			return "AMF is not available on macOS"
		}
	}
	return ""
}
