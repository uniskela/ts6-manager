package main

import (
	"context"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
)

// TestFFmpegRTPKeyframeGate encodes a short test pattern with each software
// encoder and checks the RTP output opens the viewer keyframe gate. It needs
// a real ffmpeg, so it only runs with SIDECAR_FFMPEG_IT=1.
func TestFFmpegRTPKeyframeGate(t *testing.T) {
	if os.Getenv("SIDECAR_FFMPEG_IT") != "1" {
		t.Skip("set SIDECAR_FFMPEG_IT=1 to run against a real ffmpeg")
	}
	if _, err := exec.LookPath(getFfmpegPath()); err != nil {
		t.Skip("ffmpeg not found")
	}

	for _, id := range []string{"vp8", "vp9", "h264"} {
		t.Run(id, func(t *testing.T) {
			spec, _ := lookupEncoder(id)
			conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()

			s := NewSidecar()
			s.videoPort = conn.LocalAddr().(*net.UDPAddr).Port
			args := s.buildFFmpegArgs(SourceRequest{Width: 640, Height: 360, Framerate: 30, Bitrate: "800k", Volume: 100}, spec, false)
			// Replace the black idle input with a moving pattern for a few seconds.
			joined := strings.Join(args, "\x00")
			joined = strings.Replace(joined, "color=c=black:s=640x360:r=1", "testsrc2=s=640x360:r=30:d=3", 1)
			args = strings.Split(joined, "\x00")

			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, getFfmpegPath(), append([]string{"-hide_banner", "-v", "error"}, args...)...)
			out := &tailBuffer{}
			cmd.Stderr = out
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

			buf := make([]byte, 1500)
			packets, keyStarts := 0, 0
			_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
			for packets < 200 {
				n, err := conn.Read(buf)
				if err != nil {
					break
				}
				var pkt rtp.Packet
				if pkt.Unmarshal(buf[:n]) != nil {
					continue
				}
				packets++
				if isKeyframeStart(spec.Codec, pkt.Payload) {
					keyStarts++
				}
			}
			if packets == 0 {
				t.Fatalf("no RTP packets; ffmpeg said: %s", out.summary())
			}
			if keyStarts == 0 {
				t.Fatalf("%d packets but no key frame start detected", packets)
			}
			t.Logf("%s: %d packets, %d key frame starts", id, packets, keyStarts)
		})
	}
}

func TestFFmpegEncoderProbe(t *testing.T) {
	if os.Getenv("SIDECAR_FFMPEG_IT") != "1" {
		t.Skip("set SIDECAR_FFMPEG_IT=1 to run against a real ffmpeg")
	}
	t.Setenv("VAAPI_DEVICE", "/nonexistent/renderD128")
	caps := probeEncoders(runFFmpegProbe)
	for _, r := range caps.Encoders {
		t.Logf("%-10s available=%v err=%q", r.ID, r.Available, r.Error)
		if !r.Hardware && !r.Available {
			t.Errorf("software encoder %s should be available: %s", r.ID, r.Error)
		}
		if r.Hardware && r.Available {
			t.Errorf("hardware encoder %s cannot be available without a device", r.ID)
		}
	}
}

func TestFFmpegHardwareFailureFallsBackToSoftware(t *testing.T) {
	if os.Getenv("SIDECAR_FFMPEG_IT") != "1" {
		t.Skip("set SIDECAR_FFMPEG_IT=1 to run against a real ffmpeg")
	}
	// A regular file passes the presence check but cannot open as a VAAPI device.
	fake := t.TempDir() + "/renderD128"
	if err := os.WriteFile(fake, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VAAPI_DEVICE", fake)
	t.Setenv("VAAPI_VERIFY_MS", "3000")

	s := NewSidecar()
	if err := s.StartRTP(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		s.ffmpegLock.Lock()
		s.StopFFmpegLocked()
		s.ffmpegLock.Unlock()
	}()

	session, err := s.StartFFmpeg(SourceRequest{Width: 640, Height: 360, Framerate: 30, Bitrate: "800k", Volume: 100, Encoder: "h264_vaapi"})
	if err != nil {
		t.Fatal(err)
	}
	if session.Requested != "h264_vaapi" || session.Active != "h264" || session.Hardware {
		t.Fatalf("expected software h264 fallback, got %+v", session)
	}
	if session.FallbackReason == "" {
		t.Fatal("fallback must carry a reason")
	}
	if s.currentCodec() != codecH264 {
		t.Fatalf("fallback changed codec to %s", s.currentCodec())
	}
	t.Logf("fallback reason: %s", session.FallbackReason)
}

// TestFFmpegProgressFeedsHealth runs a deliberately slow encode (1080p60 VP8,
// best quality, one thread) and checks the tracker sees below-realtime speed.
func TestFFmpegProgressFeedsHealth(t *testing.T) {
	if os.Getenv("SIDECAR_FFMPEG_IT") != "1" {
		t.Skip("set SIDECAR_FFMPEG_IT=1 to run against a real ffmpeg")
	}
	h := newHealthTracker(modeLive, nil)
	// Bounded run: a slow encode never finishes 20s of input in 8s; the
	// progress lines seen before the deadline are what matters.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, getFfmpegPath(), "-hide_banner", "-nostdin", "-stats_period", "1",
		"-re", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=60:d=20",
		"-c:v", "libvpx", "-cpu-used", "0", "-deadline", "good", "-threads", "1", "-b:v", "8000k",
		"-f", "null", "-")
	cmd.Stderr = h
	_ = cmd.Run()
	snap := h.snapshot(0, 0)
	if snap.Frames == 0 || snap.Speed <= 0 {
		t.Fatalf("no progress parsed: %+v", snap)
	}
	if snap.Speed >= 1 {
		t.Skipf("host encoded 1080p60 VP8 best-quality in realtime (%.2fx); cannot demonstrate a slow encode here", snap.Speed)
	}
	t.Logf("slow encode observed: speed=%.2fx fps=%.1f frames=%d", snap.Speed, snap.FPS, snap.Frames)
}
