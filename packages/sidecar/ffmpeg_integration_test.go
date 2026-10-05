package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
)

// Exercise actual FFmpeg requests, including HTTPS CONNECT through the proxy.
// Argument-string tests cannot detect connection reuse or demuxer rejection.
func TestFFmpegHTTPConnections(t *testing.T) {
	if os.Getenv("SIDECAR_FFMPEG_IT") != "1" {
		t.Skip("set SIDECAR_FFMPEG_IT=1 to run against a real ffmpeg")
	}
	t.Setenv("FFMPEG_EXTRA_OUTPUT_ARGS", "")
	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", `-headers "X-Review: IPTV\r\nConnection: keep-alive\r\n"`)
	dir := t.TempDir()
	gen := exec.Command(getFfmpegPath(), "-hide_banner", "-v", "error",
		"-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=4",
		"-c:v", "mpeg2video", "-g", "10", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0",
		filepath.Join(dir, "index.m3u8"))
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("generate HLS: %v %s", err, out)
	}
	gen = exec.Command(getFfmpegPath(), "-hide_banner", "-v", "error",
		"-i", filepath.Join(dir, "index0.ts"), "-c:v", "mpeg4", filepath.Join(dir, "clip.mp4"))
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("generate MP4: %v %s", err, out)
	}
	playlist, err := os.ReadFile(filepath.Join(dir, "index.m3u8"))
	if err != nil {
		t.Fatal(err)
	}

	for _, tls := range []bool{false, true} {
		t.Run(fmt.Sprintf("TLS=%v", tls), func(t *testing.T) {
			var mu sync.Mutex
			var connections map[string]int
			var segments map[string]bool
			var kept int
			var origins [2]*countingServer
			files := http.FileServer(http.Dir(dir))
			for i := range origins {
				origins[i] = startServerOn(t, allowedTestIP, tls, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("X-Review") != "IPTV" {
						http.Error(w, "missing custom header", http.StatusForbidden)
						return
					}
					mu.Lock()
					connections[fmt.Sprintf("%d/%s", i, r.RemoteAddr)]++
					if strings.HasSuffix(r.URL.Path, ".ts") {
						segments[r.URL.Path] = true
					}
					if !r.Close {
						kept++
					}
					mu.Unlock()
					switch r.URL.Path {
					case "/redirect":
						http.Redirect(w, r, origins[0].URL+"/get.php", http.StatusFound)
					case "/index.m3u8", "/get.php":
						body := string(playlist)
						for n := 0; n < 4; n++ {
							segment := fmt.Sprintf("index%d.ts", n)
							body = strings.ReplaceAll(body, segment, origins[n%2].URL+"/"+segment)
						}
						w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
						fmt.Fprint(w, body)
					default:
						files.ServeHTTP(w, r)
					}
				}))
			}
			for _, tc := range []struct {
				path, persistence, sourceMode string
				direct                        bool
			}{
				{"index.m3u8", "auto", modeLive, false},
				{"get.php", "auto", modeLive, false},
				{"redirect", "auto", modeVOD, false},
				{"get.php", "0", modeLive, false},
				{"index0.ts", "0", modeLive, false},
				{"clip.mp4", "0", modeVOD, false},
				{"get.php", "1", modeLive, false},
				{"get.php", "auto", modeLive, true},
			} {
				t.Run(fmt.Sprintf("%s/%s/direct=%v", tc.path, tc.persistence, tc.direct), func(t *testing.T) {
					t.Setenv("FFMPEG_HTTP_PERSISTENT", tc.persistence)
					mu.Lock()
					connections, kept = map[string]int{}, 0
					segments = map[string]bool{}
					mu.Unlock()
					proxy := startTestProxy(t, testPolicy(allowedTestIP))
					s := NewSidecar()
					if !tc.direct {
						s.egress = proxy
					}
					spec, _ := lookupEncoder("vp8")
					args := s.buildFFmpegArgs(SourceRequest{Source: origins[0].URL + "/" + tc.path, Mode: tc.sourceMode, Volume: 100}, spec, false)
					// Keep production input options, but skip real-time pacing and RTP.
					for n, arg := range args {
						if arg == "-i" {
							args = append(args[:n+2], "-map", "0:v:0", "-f", "null", "-")
							break
						}
					}
					unpaced := args[:0]
					for _, arg := range args {
						if arg != "-re" {
							unpaced = append(unpaced, arg)
						}
					}
					args = unpaced
					ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
					defer cancel()
					cmd := exec.CommandContext(ctx, getFfmpegPath(), args...)
					cmd.Env = egressCommandEnv()
					if out, err := cmd.CombinedOutput(); err != nil {
						t.Fatalf("playback failed: %v %s", err, out)
					}
					mu.Lock()
					defer mu.Unlock()
					if len(connections) == 0 {
						t.Fatal("origin was not reached")
					}
					if tc.path != "index0.ts" && tc.path != "clip.mp4" && len(segments) != 4 {
						t.Fatalf("read %d of 4 HLS segments", len(segments))
					}
					if tc.persistence == "1" {
						if kept == 0 {
							t.Fatal("persistence override did not restore keep-alive")
						}
						return
					}
					if kept != 0 {
						t.Fatalf("%d requests still used keep-alive", kept)
					}
					for conn, requests := range connections {
						if requests != 1 {
							t.Errorf("connection %s reused for %d requests", conn, requests)
						}
					}
				})
			}
			t.Run("probe", func(t *testing.T) {
				t.Setenv("FFMPEG_HTTP_PERSISTENT", "auto")
				mu.Lock()
				connections, kept = map[string]int{}, 0
				segments = map[string]bool{}
				mu.Unlock()
				if _, err := probeRemoteSource(context.Background(), origins[0].URL+"/get.php", testPolicy(allowedTestIP)); err != nil {
					t.Fatal(err)
				}
				mu.Lock()
				defer mu.Unlock()
				if len(connections) == 0 || kept != 0 {
					t.Fatalf("probe connections=%d keep-alive requests=%d", len(connections), kept)
				}
			})
		})
	}
}

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
		if r.Backend == backendVAAPI && r.Available {
			t.Errorf("VAAPI encoder %s cannot be available without a VAAPI device", r.ID)
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
