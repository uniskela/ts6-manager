package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func mustEncoder(t *testing.T, id string) EncoderSpec {
	t.Helper()
	spec, ok := lookupEncoder(id)
	if !ok {
		t.Fatalf("unknown encoder %q", id)
	}
	return spec
}

// vaapiDevice points VAAPI_DEVICE at a regular file (present) or at nothing.
func vaapiDevice(t *testing.T, present bool) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "renderD128")
	if present {
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("VAAPI_DEVICE", path)
}

// The first launch uses the requested encoder unless the hardware is already
// known to be unavailable, and takes the low-power mode a probe found to work.
func TestFirstEncoderAttempt(t *testing.T) {
	probed := func(id string, available, lowPower bool, errText string) *EncoderCapabilities {
		return &EncoderCapabilities{Encoders: []EncoderProbeResult{
			{EncoderSpec: mustEncoder(t, id), Available: available, LowPower: lowPower, Error: errText},
		}}
	}
	cases := []struct {
		name          string
		encoder       string
		caps          *EncoderCapabilities
		devicePresent bool
		lowPowerEnv   string
		wantActive    string
		wantLowPower  bool
		wantReason    string
		wantToggled   bool
	}{
		{name: "software", encoder: "h264", wantActive: "h264", wantToggled: true},
		{name: "software ignores a missing device", encoder: "vp8", wantActive: "vp8", wantToggled: true},
		{name: "vaapi not probed, device present", encoder: "h264_vaapi", devicePresent: true, wantActive: "h264_vaapi"},
		{name: "vaapi not probed takes low power from the environment", encoder: "h264_vaapi", devicePresent: true, lowPowerEnv: "1", wantActive: "h264_vaapi", wantLowPower: true},
		{name: "vaapi not probed, no device", encoder: "h264_vaapi", wantActive: "h264", wantReason: "VAAPI device not present"},
		{name: "nvenc not probed has no low power to flip", encoder: "h264_nvenc", wantActive: "h264_nvenc", wantToggled: true},
		{name: "probed available keeps the probed low power", encoder: "h264_vaapi", caps: probed("h264_vaapi", true, true, ""), wantActive: "h264_vaapi", wantLowPower: true, wantToggled: true},
		{name: "probed available overrides the environment", encoder: "h264_vaapi", caps: probed("h264_vaapi", true, false, ""), lowPowerEnv: "1", wantActive: "h264_vaapi", wantToggled: true},
		{name: "probed unavailable carries the probe's reason", encoder: "vp9_vaapi", caps: probed("vp9_vaapi", false, false, "no VP9 entrypoint"), devicePresent: true, wantActive: "vp9", wantReason: "no VP9 entrypoint", wantToggled: true},
		{name: "probed unavailable without a reason", encoder: "h264_nvenc", caps: probed("h264_nvenc", false, false, ""), wantActive: "h264", wantReason: "hardware encoder unavailable", wantToggled: true},
		{name: "a probe of another encoder says nothing", encoder: "h264_vaapi", caps: probed("vp8_vaapi", false, false, "broken"), devicePresent: true, wantActive: "h264_vaapi"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vaapiDevice(t, tc.devicePresent)
			t.Setenv("VAAPI_LOW_POWER", tc.lowPowerEnv)
			s := &Sidecar{}
			s.caps.caps = tc.caps

			got := s.firstEncoderAttempt(mustEncoder(t, tc.encoder))
			if got.spec.ID != tc.wantActive || got.lowPower != tc.wantLowPower ||
				got.fallbackReason != tc.wantReason || got.triedLowPowerToggle != tc.wantToggled {
				t.Errorf("got encoder=%s lowPower=%v reason=%q toggled=%v, want encoder=%s lowPower=%v reason=%q toggled=%v",
					got.spec.ID, got.lowPower, got.fallbackReason, got.triedLowPowerToggle,
					tc.wantActive, tc.wantLowPower, tc.wantReason, tc.wantToggled)
			}
		})
	}
}

// A failed hardware encoder is tried once more in the other low-power mode,
// and only then replaced by the software encoder of the same codec.
func TestAfterHardwareFailureFlipsLowPowerThenFallsBack(t *testing.T) {
	first := encoderAttempt{spec: mustEncoder(t, "vp9_vaapi")}

	second := first.afterHardwareFailure("no entrypoint")
	if second.spec.ID != "vp9_vaapi" || !second.lowPower || !second.triedLowPowerToggle || second.fallbackReason != "" {
		t.Fatalf("second attempt must be the same encoder in the other low-power mode, got %+v", second)
	}
	if first.lowPower || first.triedLowPowerToggle {
		t.Errorf("the failed attempt itself must not change, got %+v", first)
	}

	third := second.afterHardwareFailure("still no entrypoint")
	if third.spec.ID != "vp9" || third.spec.Hardware || third.fallbackReason != "still no entrypoint" {
		t.Fatalf("third attempt must be software vp9 with the last reason, got %+v", third)
	}
}

func TestAfterHardwareFailureWithoutLowPowerToFlip(t *testing.T) {
	a := encoderAttempt{spec: mustEncoder(t, "h264_nvenc"), triedLowPowerToggle: true}
	got := a.afterHardwareFailure("")
	if got.spec.ID != "h264" || got.lowPower || got.fallbackReason != "hardware encoder exited during startup" {
		t.Errorf("want software h264 with the default reason, got %+v", got)
	}
}

// failingHardwareFFmpeg installs an ffmpeg whose VAAPI encodes exit at once
// and whose other encodes keep running. Each run's arguments are one line of
// the returned log file.
func failingHardwareFFmpeg(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs a POSIX shell")
	}
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" | tr -d '\\r' | tr '\\n' ' ' >> " + calls + "\necho >> " + calls + "\n" +
		"case \"$*\" in *_vaapi*) echo 'Failed to initialise VAAPI connection' >&2; exit 1 ;; esac\n" +
		"exec sleep 30\n"
	bin := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", bin)
	t.Setenv("SIDECAR_EGRESS_PROXY", "off")
	return calls
}

// StartFFmpeg answers only once the fallback has settled, and reports it.
func TestHardwareFailureTriesLowPowerThenSoftware(t *testing.T) {
	calls := failingHardwareFFmpeg(t)
	vaapiDevice(t, true)
	t.Setenv("VAAPI_LOW_POWER", "")
	t.Setenv("VAAPI_VERIFY_MS", "2000")
	s := NewSidecar()
	defer s.Stop()

	session, err := s.StartFFmpeg(SourceRequest{Encoder: "h264_vaapi", Volume: 100})
	if err != nil {
		t.Fatal(err)
	}
	if session.Requested != "h264_vaapi" || session.Active != "h264" || session.Hardware || session.State != "running" {
		t.Errorf("want a running software h264 fallback, got %+v", session)
	}
	if !strings.Contains(session.FallbackReason, "Failed to initialise VAAPI connection") {
		t.Errorf("fallback reason must be ffmpeg's error, got %q", session.FallbackReason)
	}
	if s.currentCodec() != codecH264 {
		t.Errorf("fallback changed the codec to %s", s.currentCodec())
	}

	lines := waitForCalls(t, calls, 3)
	if len(lines) != 3 {
		t.Fatalf("want 3 ffmpeg runs, got %d:\n%s", len(lines), strings.Join(lines, "\n"))
	}
	for i, want := range []struct {
		encoder  string
		lowPower bool
	}{{"h264_vaapi", false}, {"h264_vaapi", true}, {"libx264", false}} {
		if !strings.Contains(lines[i], "-c:v "+want.encoder) || strings.Contains(lines[i], "-low_power 1") != want.lowPower {
			t.Errorf("run %d: want encoder %s, low power %v:\n%s", i+1, want.encoder, want.lowPower, lines[i])
		}
	}

	// Each launch is its own generation; the session is the last one's.
	if gen := s.encoderSession().gen; gen != atomic.LoadUint64(&s.ffmpegGen) {
		t.Errorf("session generation %d is not the running ffmpeg's %d", gen, atomic.LoadUint64(&s.ffmpegGen))
	}
}

// An encoder the capability probe found unavailable is not launched at all.
func TestProbedUnavailableEncoderStartsInSoftware(t *testing.T) {
	calls := failingHardwareFFmpeg(t)
	vaapiDevice(t, true)
	s := NewSidecar()
	defer s.Stop()
	s.caps.caps = &EncoderCapabilities{Encoders: []EncoderProbeResult{
		{EncoderSpec: mustEncoder(t, "vp8_vaapi"), Error: "no VP8 entrypoint"},
	}}

	session, err := s.StartFFmpeg(SourceRequest{Encoder: "vp8_vaapi", Volume: 100})
	if err != nil {
		t.Fatal(err)
	}
	if session.Active != "vp8" || session.FallbackReason != "no VP8 entrypoint" {
		t.Errorf("want software vp8 with the probe's reason, got %+v", session)
	}
	lines := waitForCalls(t, calls, 1)
	time.Sleep(200 * time.Millisecond)
	if b, _ := os.ReadFile(calls); strings.Count(string(b), "\n") != 1 || strings.Contains(lines[0], "_vaapi") {
		t.Errorf("want one software run, got:\n%s", b)
	}
}

// A request that cannot start leaves the running stream alone.
func TestRejectedRequestKeepsTheRunningStream(t *testing.T) {
	failingHardwareFFmpeg(t)
	s := NewSidecar()
	defer s.Stop()
	if _, err := s.StartFFmpeg(SourceRequest{Encoder: "vp8", Volume: 100}); err != nil {
		t.Fatal(err)
	}
	gen := atomic.LoadUint64(&s.ffmpegGen)

	if _, err := s.StartFFmpeg(SourceRequest{Encoder: "no-such-encoder"}); err == nil {
		t.Fatal("an unknown encoder must be rejected")
	}
	if now := atomic.LoadUint64(&s.ffmpegGen); now != gen || s.encoderSession().State != "running" {
		t.Errorf("a rejected request must not stop the stream: gen %d -> %d, session %+v", gen, now, s.encoderSession())
	}
}

// A viewer is sent video only while it is active on the stream's codec and
// its gate is open; a gate cannot open before media can be sent.
func TestVideoGateHoldsBackViewersThatCannotTakeThePacket(t *testing.T) {
	track, err := webrtc.NewTrackLocalStaticRTP(codecCapability(codecH264), "video", "ts6-stream")
	if err != nil {
		t.Fatal(err)
	}
	keyframe := &rtp.Packet{Header: rtp.Header{Timestamp: 1000}, Payload: h264Params}
	cases := []struct {
		name      string
		peer      *Peer
		wantTrack bool
	}{
		{"open gate", &Peer{Active: true, Started: true, Codec: codecH264, VideoTrack: track}, true},
		{"open gate without a track", &Peer{Active: true, Started: true, Codec: codecH264}, false},
		{"not active", &Peer{Started: true, Codec: codecH264, VideoTrack: track}, false},
		{"another codec", &Peer{Active: true, Started: true, Codec: codecVP8, VideoTrack: track}, false},
		{"keyframe before media can be sent", &Peer{Active: true, Codec: codecH264, VideoTrack: track}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			started := tc.peer.Started
			got, opening := tc.peer.videoGate(codecH264, keyframe)
			if (got != nil) != tc.wantTrack || opening {
				t.Errorf("got track=%v opening=%v, want track=%v opening=false", got != nil, opening, tc.wantTrack)
			}
			if tc.peer.Started != started {
				t.Errorf("gate state changed to Started=%v", tc.peer.Started)
			}
		})
	}
}

// Only the packet that opens an H.264 viewer's gate gets the parameter sets
// in front of it.
func TestVideoBatchPrefixesOnlyAnOpeningH264Keyframe(t *testing.T) {
	s := NewSidecar()
	s.h264Params.observe(h264Params)
	peer := &Peer{ID: "viewer"}
	idr := &rtp.Packet{Header: rtp.Header{SequenceNumber: 7, Timestamp: 1000}, Payload: h264IDR}

	for _, tc := range []struct {
		name    string
		codec   string
		opening bool
		want    int
	}{
		{"h264 opening", codecH264, true, 3},
		{"h264 already open", codecH264, false, 1},
		{"vp8 opening", codecVP8, true, 1},
	} {
		batch := s.videoBatch(peer, tc.codec, idr, tc.opening)
		if len(batch) != tc.want || batch[len(batch)-1] != idr {
			t.Errorf("%s: got %d packets (last is the packet: %v), want %d ending in the packet",
				tc.name, len(batch), batch[len(batch)-1] == idr, tc.want)
		}
	}
}
