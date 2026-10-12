package main

import (
	"context"
	"fmt"
	"strings"
)

// ffmpegEncoderList is the set of encoders one FFmpeg binary was built with,
// from `ffmpeg -hide_banner -encoders`. A nil list means the query failed or
// printed nothing recognizable; callers then behave as if they had no list.
//
// FFmpeg lists an encoder whenever it is compiled in, whether or not the GPU or
// driver behind it exists, so a missing entry means "this build cannot do it",
// and a present entry proves nothing about the hardware. `-h encoder=<name>`
// is no substitute: for an unknown name it prints "is not recognized" and
// still exits 0.
type ffmpegEncoderList map[string]struct{}

// encoderListArgs are the arguments of the query.
var encoderListArgs = []string{"-hide_banner", "-encoders"}

// parseEncoderList reads the `-encoders` table: a legend, a "------" line, then
// one "<flags> <name> <description>" row per encoder, the flags being six
// characters starting with V, A or S. It returns nil unless it found a row.
func parseEncoderList(out string) ffmpegEncoderList {
	list := ffmpegEncoderList{}
	inTable := false
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if !inTable {
			inTable = strings.HasPrefix(line, "------")
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 || len(fields[0]) != 6 || !strings.ContainsRune("VAS", rune(fields[0][0])) {
			continue
		}
		list[fields[1]] = struct{}{}
	}
	if len(list) == 0 {
		return nil
	}
	return list
}

// queryEncoderList asks run for the encoder list; nil when it cannot be had.
func queryEncoderList(run probeRunner) ffmpegEncoderList {
	ctx, cancel := context.WithTimeout(context.Background(), encoderProbeTimeout)
	defer cancel()
	out, err := run(ctx, encoderListArgs)
	if err != nil {
		return nil
	}
	return parseEncoderList(out)
}

// lacks reports whether the list is known and does not contain name.
func (l ffmpegEncoderList) lacks(name string) bool {
	if l == nil {
		return false
	}
	_, ok := l[name]
	return !ok
}

// backendRequirement is what a hardware encoder needs besides the host's GPU.
func backendRequirement(backend string) string {
	switch backend {
	case backendAMF:
		return "AMF needs an FFmpeg built with AMF support and an AMD driver"
	case backendNVENC:
		return "NVENC needs an FFmpeg built with NVENC support and an NVIDIA driver"
	case backendVAAPI:
		return "VAAPI needs an FFmpeg built with VAAPI support"
	case backendVideoToolbox:
		return "VideoToolbox needs an FFmpeg built with VideoToolbox support, as on macOS"
	}
	return "it needs an FFmpeg built with that encoder"
}

// missingEncoderReason is the plain reason for an encoder the FFmpeg build does
// not contain, or "" when the build has it or the list is unknown. Only
// hardware encoders are checked.
func missingEncoderReason(spec EncoderSpec, list ffmpegEncoderList) string {
	if !spec.Hardware || !list.lacks(spec.FFmpeg) {
		return ""
	}
	return fmt.Sprintf("This FFmpeg build has no %s encoder (%s)", spec.FFmpeg, backendRequirement(spec.Backend))
}
