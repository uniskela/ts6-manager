package main

import (
	"strings"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func progress(speed string) string {
	return "frame= 1234 fps= 18 q=10.0 size=    5120kB time=00:01:00.00 bitrate=1000.0kbits/s dup=3 drop=7 speed=" + speed + "x    \r"
}

func TestHealthParsesProgressAcrossWrites(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	h := newHealthTracker(modeLive, clock.now)
	line := progress("0.62")
	// ffmpeg writes progress in arbitrary chunks.
	_, _ = h.Write([]byte(line[:20]))
	_, _ = h.Write([]byte(line[20:]))
	snap := h.snapshot(4, 1)
	if snap.Speed != 0.62 || snap.FPS != 18 || snap.Frames != 1234 || snap.DroppedFrames != 7 || snap.DuplicatedFrames != 3 {
		t.Fatalf("unexpected parse: %+v", snap)
	}
	if snap.RTPVideoDrops != 4 || snap.RTPAudioDrops != 1 || snap.Mode != modeLive {
		t.Fatalf("unexpected counters: %+v", snap)
	}
}

func TestHealthIgnoresStartupAndShortDips(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	h := newHealthTracker(modeLive, clock.now)

	// Startup transient: slow but inside the grace period.
	_, _ = h.Write([]byte(progress("0.40")))
	clock.advance(10 * time.Second)
	_, _ = h.Write([]byte(progress("0.50")))
	if h.snapshot(0, 0).BelowRealtimeSecs != 0 {
		t.Fatal("startup must not count as below realtime")
	}

	// After grace: a short dip that recovers never warns.
	clock.advance(10 * time.Second)
	_, _ = h.Write([]byte(progress("0.80")))
	clock.advance(10 * time.Second)
	_, _ = h.Write([]byte(progress("0.99")))
	if s := h.snapshot(0, 0); s.BelowRealtime || s.BelowRealtimeSecs != 0 {
		t.Fatalf("recovered dip must clear: %+v", s)
	}
}

func TestHealthWarnsWhenSustained(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	h := newHealthTracker(modeLive, clock.now)
	clock.advance(healthStartupGrace)
	for i := 0; i < 6; i++ {
		_, _ = h.Write([]byte(progress("0.55")))
		clock.advance(5 * time.Second)
	}
	s := h.snapshot(0, 0)
	if !s.BelowRealtime || s.BelowRealtimeSecs < healthSustainedWindow.Seconds() {
		t.Fatalf("expected sustained warning, got %+v", s)
	}
	if s.SampleAgeSecs != 5 {
		t.Fatalf("sample age = %v", s.SampleAgeSecs)
	}
}

func TestAudioTimestampDiscontinuityDoesNotStall(t *testing.T) {
	s := NewSidecar()
	now := time.Unix(1_000, 0)
	// Both tracks have started, so audio is not being held for video.
	s.recordFrame("video", 0, now)
	held := func(ts uint32, at time.Time) time.Duration {
		return s.sendTime("audio", s.recordFrame("audio", ts, at), at, at).Sub(at)
	}
	if first := held(0, now); first > s.syncBuffer {
		t.Fatalf("first packet delay = %s, want <= sync buffer %s", first, s.syncBuffer)
	}
	if steady := held(960, now.Add(20*time.Millisecond)); steady > 100*time.Millisecond {
		t.Fatalf("steady 20ms step stalled: %s", steady)
	}
	// 30s of RTP time in one step. Without a rebase this waits at maxTrackDelay.
	if jumped := held(960+30*48000, now.Add(40*time.Millisecond)); jumped > 150*time.Millisecond {
		t.Fatalf("forward discontinuity stalled playout: %s", jumped)
	}
	if back := held(960, now.Add(60*time.Millisecond)); back > 150*time.Millisecond {
		t.Fatalf("backward discontinuity stalled playout: %s", back)
	}
}

func TestSourceModeDrivesPacingAndLooping(t *testing.T) {
	s := NewSidecar()
	spec, _ := lookupEncoder("vp8")
	args := func(req SourceRequest) string { return strings.Join(s.buildFFmpegArgs(req, spec, false), " ") }

	if got := resolveSourceMode("", "https://x/live.m3u8"); got != modeVOD {
		t.Fatalf("remote default = %s, want vod (no .m3u8 guessing)", got)
	}
	if got := resolveSourceMode("", "/data/music/a.mp4"); got != modeFile {
		t.Fatalf("local default = %s", got)
	}

	live := args(SourceRequest{Source: "https://x/opaque", Mode: modeLive, Loop: true, Volume: 40})
	if !strings.Contains(live, "-re -i https://x/opaque") || strings.Contains(live, "stream_loop") {
		t.Fatalf("live keeps -re by default and never loops: %s", live)
	}
	if !strings.Contains(live, "+genpts+igndts+discardcorrupt") {
		t.Fatalf("live must ignore broken DTS: %s", live)
	}
	if !strings.Contains(live, "aresample=async=1000:first_pts=0,volume=0.40") {
		t.Fatalf("live audio must compensate timestamps then apply volume: %s", live)
	}
	t.Setenv("VIDEO_LIVE_PACING", "source")
	if a := args(SourceRequest{Source: "https://x/opaque", Mode: modeLive}); strings.Contains(a, "-re ") {
		t.Fatalf("VIDEO_LIVE_PACING=source must drop -re for live: %s", a)
	}
	vod := args(SourceRequest{Source: "https://x/clip.mp4", Mode: modeVOD, Volume: 40})
	if !strings.Contains(vod, "-re -i") {
		t.Fatalf("vod must stay paced: %s", vod)
	}
	if strings.Contains(vod, "igndts") || strings.Contains(vod, "aresample=async") {
		t.Fatalf("vod must not take live audio compensation: %s", vod)
	}
	if !strings.Contains(vod, "volume=0.40") {
		t.Fatalf("vod volume filter missing: %s", vod)
	}
	if a := args(SourceRequest{Source: "/data/music/bg.mp4", Mode: modeFile, Loop: true}); !strings.Contains(a, "-stream_loop -1") || !strings.Contains(a, "-re -i") {
		t.Fatalf("looping file: %s", a)
	}
	if a := args(SourceRequest{Source: "/data/music/bg.mp4"}); !strings.HasPrefix(a, "-stats_period 2") {
		t.Fatalf("progress stats must be enabled: %s", a)
	}
	if a := args(SourceRequest{Source: "https://iptv.example/live.m3u8"}); !strings.Contains(a, "-stats -loglevel warning") {
		t.Fatalf("live sources must not log info-level segment chatter: %s", a)
	}
}
