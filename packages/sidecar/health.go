package main

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Source modes decide input pacing and whether the input may loop.
const (
	modeLive = "live"
	modeVOD  = "vod"
	modeFile = "file"
)

// resolveSourceMode fills in a mode the backend did not send: local paths are
// files, remote URLs are treated as VOD (the pre-1.9 behavior).
func resolveSourceMode(requested, source string) string {
	switch requested {
	case modeLive, modeVOD, modeFile:
		return requested
	}
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		return modeVOD
	}
	return modeFile
}

// livePacedBySource reports whether live inputs skip -re. Measured on live
// HLS/CMAF, -re holds ~1.0x while reading without it bursts ~2x at startup
// (the live-edge segments) before settling, so -re stays the default.
func livePacedBySource() bool {
	return envOrDefault("VIDEO_LIVE_PACING", "re") == "source"
}

// Below-realtime warning thresholds: ignore startup, then warn only when the
// encode speed stays under the threshold for a sustained window.
const (
	healthStartupGrace    = 15 * time.Second
	healthSustainedWindow = 20 * time.Second
	healthSpeedThreshold  = 0.9
)

// StreamHealth is the encode health reported by GET /stats.
type StreamHealth struct {
	Mode              string  `json:"mode"`
	Speed             float64 `json:"speed"`
	FPS               float64 `json:"fps"`
	Frames            int64   `json:"frames"`
	DroppedFrames     int64   `json:"droppedFrames"`
	DuplicatedFrames  int64   `json:"duplicatedFrames"`
	RTPVideoDrops     uint64  `json:"rtpVideoDrops"`
	RTPAudioDrops     uint64  `json:"rtpAudioDrops"`
	BelowRealtime     bool    `json:"belowRealtime"`
	BelowRealtimeSecs float64 `json:"belowRealtimeSecs"`
	SampleAgeSecs     float64 `json:"sampleAgeSecs"`
}

// healthTracker parses ffmpeg's periodic progress lines from stderr.
type healthTracker struct {
	mu         sync.Mutex
	mode       string
	startedAt  time.Time
	lastSample time.Time
	speed      float64
	fps        float64
	frames     int64
	drop       int64
	dup        int64
	belowSince time.Time
	partial    []byte
	now        func() time.Time
}

func newHealthTracker(mode string, now func() time.Time) *healthTracker {
	if now == nil {
		now = time.Now
	}
	return &healthTracker{mode: mode, startedAt: now(), now: now}
}

var progressFields = regexp.MustCompile(`(frame|fps|drop|dup|speed)=\s*([0-9.]+)`)

// Write implements io.Writer over ffmpeg stderr; progress lines end in \r.
func (h *healthTracker) Write(p []byte) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.partial = append(h.partial, p...)
	for {
		i := strings.IndexAny(string(h.partial), "\r\n")
		if i < 0 {
			break
		}
		h.parseLocked(string(h.partial[:i]))
		h.partial = h.partial[i+1:]
	}
	if len(h.partial) > 4096 {
		h.partial = h.partial[len(h.partial)-4096:]
	}
	return len(p), nil
}

func (h *healthTracker) parseLocked(line string) {
	if !strings.Contains(line, "speed=") {
		return
	}
	matches := progressFields.FindAllStringSubmatch(line, -1)
	if len(matches) == 0 {
		return
	}
	speedSeen := false
	for _, m := range matches {
		v, err := strconv.ParseFloat(m[2], 64)
		if err != nil {
			continue
		}
		switch m[1] {
		case "frame":
			h.frames = int64(v)
		case "fps":
			h.fps = v
		case "drop":
			h.drop = int64(v)
		case "dup":
			h.dup = int64(v)
		case "speed":
			h.speed = v
			speedSeen = true
		}
	}
	if !speedSeen {
		return
	}
	now := h.now()
	h.lastSample = now
	if now.Sub(h.startedAt) < healthStartupGrace || h.speed >= healthSpeedThreshold {
		h.belowSince = time.Time{}
		return
	}
	if h.belowSince.IsZero() {
		h.belowSince = now
	}
}

func (h *healthTracker) snapshot(videoDrops, audioDrops uint64) StreamHealth {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	out := StreamHealth{
		Mode:             h.mode,
		Speed:            h.speed,
		FPS:              h.fps,
		Frames:           h.frames,
		DroppedFrames:    h.drop,
		DuplicatedFrames: h.dup,
		RTPVideoDrops:    videoDrops,
		RTPAudioDrops:    audioDrops,
	}
	if !h.lastSample.IsZero() {
		out.SampleAgeSecs = now.Sub(h.lastSample).Seconds()
	}
	if !h.belowSince.IsZero() {
		below := now.Sub(h.belowSince)
		out.BelowRealtimeSecs = below.Seconds()
		out.BelowRealtime = below >= healthSustainedWindow
	}
	return out
}
