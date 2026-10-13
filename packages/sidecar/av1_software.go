package main

import (
	"context"
	"log"
	"strings"
	"sync"
)

// av1SoftwareDecoderCache is the software AV1 decoder of the ffmpeg at path,
// asked for once per build like the encoder list. It has its own lock, so the
// query never blocks GET /encoders or cached encoder reads.
type av1SoftwareDecoderCache struct {
	mu            sync.Mutex
	asked         bool
	path, decoder string
}

// get returns the decoder to name on the video input, or "" to leave the
// choice to FFmpeg: the list could not be read, or names no decoder known
// to decode AV1 on the CPU.
func (c *av1SoftwareDecoderCache) get(run probeRunner, path string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.asked && c.path == path {
		return c.decoder
	}
	ctx, cancel := context.WithTimeout(context.Background(), encoderProbeTimeout)
	defer cancel()
	out, err := run(ctx, []string{"-hide_banner", "-decoders"})
	if err != nil {
		// Not cached: the next AV1 stream asks again.
		log.Printf("[Probe] Could not list FFmpeg's decoders: %v; FFmpeg chooses the AV1 decoder", err)
		return ""
	}
	c.path, c.asked, c.decoder = path, true, softwareAV1Decoder(out)
	if c.decoder == "" {
		log.Printf("[Probe] FFmpeg lists neither libdav1d nor libaom-av1; AV1 sources may not decode on the CPU")
	}
	return c.decoder
}

// Match decoder names in the video column, never descriptive text or the
// native av1 decoder, which has no software path in supported FFmpeg builds.
func softwareAV1Decoder(out string) string {
	foundAOM := false
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || len(f[0]) != 6 || f[0][0] != 'V' {
			continue
		}
		if f[1] == "libdav1d" {
			return "libdav1d"
		}
		if f[1] == "libaom-av1" {
			foundAOM = true
		}
	}
	if foundAOM {
		return "libaom-av1"
	}
	return ""
}
