package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func setHostOS(t *testing.T, goos string) {
	t.Helper()
	old := hostOS
	hostOS = goos
	t.Cleanup(func() { hostOS = old })
}

func TestBackendUnsupportedReason(t *testing.T) {
	const noVideoToolbox = "VideoToolbox is only available on macOS"
	const noAMF = "AMF is not available on macOS"
	cases := []struct {
		goos, backend, want string
	}{
		{"darwin", backendVideoToolbox, ""},
		{"linux", backendVideoToolbox, noVideoToolbox},
		{"windows", backendVideoToolbox, noVideoToolbox},
		{"windows", backendAMF, ""},
		{"linux", backendAMF, ""},
		{"darwin", backendAMF, noAMF},
		// VAAPI is decided by its device node and NVENC by its test encode, on
		// every system.
		{"linux", backendVAAPI, ""},
		{"windows", backendVAAPI, ""},
		{"darwin", backendVAAPI, ""},
		{"linux", backendNVENC, ""},
		{"windows", backendNVENC, ""},
		{"darwin", backendNVENC, ""},
		// Software encoders have no backend.
		{"darwin", "", ""},
	}
	for _, c := range cases {
		setHostOS(t, c.goos)
		if got := backendUnsupportedReason(c.backend); got != c.want {
			t.Errorf("%q on %s: got %q, want %q", c.backend, c.goos, got, c.want)
		}
	}
}

// Adding VideoToolbox must not change what a Linux (Docker) or Windows sidecar
// does with the encoders it already had: none of them is skipped for its
// operating system, so each is probed and started exactly as before.
func TestLinuxAndWindowsKeepTheirEncoders(t *testing.T) {
	for _, goos := range []string{"linux", "windows"} {
		setHostOS(t, goos)
		for _, spec := range encoderOrder {
			reason := backendUnsupportedReason(spec.Backend)
			if spec.ID == "h264_videotoolbox" {
				if reason == "" {
					t.Errorf("%s: VideoToolbox must not be offered", goos)
				}
				continue
			}
			if reason != "" {
				t.Errorf("%s: %s is now skipped: %s", goos, spec.ID, reason)
			}
		}
	}
}

func TestVideoToolboxSpecAndArgs(t *testing.T) {
	t.Setenv("VIDEO_GOP", "15")
	spec, ok := lookupEncoder("h264_videotoolbox")
	if !ok || !spec.Hardware || spec.Backend != backendVideoToolbox || spec.Codec != codecH264 || spec.FFmpeg != "h264_videotoolbox" {
		t.Fatalf("h264_videotoolbox spec = %+v (found %v)", spec, ok)
	}
	if got := uploadFilter(spec); got != "format=nv12" {
		t.Fatalf("VideoToolbox filter = %q", got)
	}
	if got := hwInitArgs(spec, true); got != nil {
		t.Fatalf("VideoToolbox needs no device or hwaccel args, got %v", got)
	}
	args := strings.Join(encoderArgs(spec, "2500k", false, 0), " ")
	for _, want := range []string{
		"-c:v h264_videotoolbox", "-profile:v high", "-bf 0", "-realtime 1", "-allow_sw 0",
		"-b:v 2500k", "-maxrate 2500k", "-g 15",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("h264_videotoolbox args missing %q: %s", want, args)
		}
	}
	// header_spacing is AMF's option and repeat-headers libx264's; FFmpeg
	// rejects an option the encoder does not have.
	for _, forbidden := range []string{"hwupload", "-low_power", "-minrate", "-init_hw_device", "header_spacing", "repeat-headers", "-preset", "-tune"} {
		if strings.Contains(args, forbidden) {
			t.Errorf("h264_videotoolbox args must not contain %q: %s", forbidden, args)
		}
	}
	// Low power is VAAPI's; asking for it changes nothing here.
	if lp := strings.Join(encoderArgs(spec, "2500k", true, 0), " "); lp != args {
		t.Errorf("low power must not change VideoToolbox args: %s", lp)
	}
	// A VideoToolbox failure keeps viewers on the codec they negotiated.
	if sw := softwareEncoderFor(spec.Codec); sw.ID != "h264" || sw.Hardware {
		t.Fatalf("VideoToolbox software fallback = %+v", sw)
	}
	// Viewers are offered what they are offered for every H.264 encoder.
	if got := codecCapability(spec.Codec).SDPFmtpLine; got != h264ConstrainedHighFmtp {
		t.Errorf("VideoToolbox must be offered as Constrained High, got %q", got)
	}
}

// VideoToolbox encodes system-memory frames: the source is decoded and scaled
// on the CPU whatever VIDEO_HW_DECODE and the VAAPI settings say, and the
// frames never take the GPU filter chain that VAAPI decoding uses.
func TestBuildFFmpegArgsVideoToolbox(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "1")
	t.Setenv("VIDEO_GPU_FILTERS", "")
	t.Setenv("VAAPI_LOW_POWER", "1")
	s := NewSidecar()
	spec := mustEncoder(t, "h264_videotoolbox")
	if framesStayOnGPU(spec, true) {
		t.Fatal("VideoToolbox frames must not take the VAAPI GPU filter chain")
	}

	req := SourceRequest{Source: "https://example.com/v.webm", AudioSource: "https://example.com/a.webm", Width: 1280, Height: 720, Framerate: 30, Bitrate: "2500k"}
	args := strings.Join(s.buildFFmpegArgs(req, spec, false), " ")
	for _, want := range []string{
		"-vf fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=nv12",
		"-c:v h264_videotoolbox", "-allow_sw 0", "-b:v 2500k",
		"-payload_type 96", "-f rtp -pkt_size 1200",
		"-map 1:a:0", "-c:a libopus",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("VideoToolbox stream args missing %q: %s", want, args)
		}
	}
	for _, forbidden := range []string{"-hwaccel", "vaapi", "hwupload", "-init_hw_device", "-low_power", "cuda"} {
		if strings.Contains(args, forbidden) {
			t.Errorf("VideoToolbox stream args must not contain %q: %s", forbidden, args)
		}
	}

	// The idle (no source) stream still hands the encoder NV12.
	idle := strings.Join(s.buildFFmpegArgs(SourceRequest{}, spec, false), " ")
	if !strings.Contains(idle, "-vf format=nv12 -c:v h264_videotoolbox") {
		t.Errorf("idle VideoToolbox stream must convert to nv12: %s", idle)
	}

	// A source without an audio track is restarted with silence, as for any
	// other encoder.
	req.AudioSource, req.SilentAudio = "", true
	silent := strings.Join(s.buildFFmpegArgs(req, spec, false), " ")
	if !strings.Contains(silent, "-map 1:a:0") || !strings.Contains(silent, "anullsrc") {
		t.Errorf("VideoToolbox stream must take silence as its audio: %s", silent)
	}
}

func TestProbeSkipsVideoToolboxOffMacOS(t *testing.T) {
	spec, _ := lookupEncoder("h264_videotoolbox")
	for _, goos := range []string{"linux", "windows"} {
		setHostOS(t, goos)
		calls := 0
		res := probeOneEncoder(spec, true, func(ctx context.Context, args []string) (string, error) {
			calls++
			return "", nil
		})
		if calls != 0 || res.Available || len(res.Attempts) != 0 {
			t.Fatalf("%s: VideoToolbox must not be probed, got %+v after %d calls", goos, res, calls)
		}
		if res.Skipped != "VideoToolbox is only available on macOS" || res.Error != res.Skipped {
			t.Fatalf("%s: unexpected skip reason %+v", goos, res)
		}
	}
}

func TestProbeRunsVideoToolboxOnMacOS(t *testing.T) {
	setHostOS(t, "darwin")
	spec, _ := lookupEncoder("h264_videotoolbox")

	calls := 0
	res := probeOneEncoder(spec, false, func(ctx context.Context, args []string) (string, error) {
		calls++
		joined := strings.Join(args, " ")
		for _, want := range []string{"-f lavfi", "-vf format=nv12", "-c:v h264_videotoolbox", "-allow_sw 0"} {
			if !strings.Contains(joined, want) {
				t.Errorf("VideoToolbox probe missing %q: %s", want, joined)
			}
		}
		return "", nil
	})
	if calls != 1 || !res.Available || res.Skipped != "" || len(res.Attempts) != 1 {
		t.Fatalf("expected one passing VideoToolbox probe, got %+v after %d calls", res, calls)
	}

	// A Mac without a hardware H.264 encoder fails the test encode, once: there
	// is no second mode to try as there is for VAAPI.
	calls = 0
	res = probeOneEncoder(spec, false, func(ctx context.Context, args []string) (string, error) {
		calls++
		return "[h264_videotoolbox] Error: cannot create compression session: -12908\n", errors.New("exit status 1")
	})
	if calls != 1 || res.Available || res.Error == "" || res.Skipped != "" || len(res.Attempts) != 1 {
		t.Fatalf("expected a failed VideoToolbox probe with its reason, got %+v after %d calls", res, calls)
	}
}

func TestProbeSkipsAmfOnMacOS(t *testing.T) {
	setHostOS(t, "darwin")
	calls := 0
	res := probeOneEncoder(mustEncoder(t, "h264_amf"), false, func(ctx context.Context, args []string) (string, error) {
		calls++
		return "", nil
	})
	if calls != 0 || res.Available || res.Skipped != "AMF is not available on macOS" || res.Error != res.Skipped {
		t.Fatalf("AMF must be skipped on macOS, got %+v after %d calls", res, calls)
	}
}

// GET /encoders lists every encoder on every system; the ones the system
// cannot have are rows with a reason, and ffmpeg is never run for them.
func TestProbeEncodersReportsEveryEncoderOnEachSystem(t *testing.T) {
	t.Setenv("VAAPI_DEVICE", "/nonexistent/renderD128")
	for goos, wantRun := range map[string][]string{
		"linux":   {"libvpx", "libvpx-vp9", "libx264", "h264_nvenc", "h264_amf"},
		"windows": {"libvpx", "libvpx-vp9", "libx264", "h264_nvenc", "h264_amf"},
		"darwin":  {"libvpx", "libvpx-vp9", "libx264", "h264_nvenc", "h264_videotoolbox"},
	} {
		setHostOS(t, goos)
		caps, got := probeEncodersCountingRuns()
		if len(got) != len(wantRun) {
			t.Errorf("%s: test encodes ran for %v, want %v", goos, got, wantRun)
		}
		for _, enc := range wantRun {
			if got[enc] != 1 {
				t.Errorf("%s: want one test encode of %s, got %d (%v)", goos, enc, got[enc], got)
			}
		}
		checkOneRowPerEncoder(t, goos, caps)
	}
}

// probeEncodersCountingRuns probes every encoder with an ffmpeg that always
// succeeds, and returns how often each ffmpeg encoder was test-encoded.
func probeEncodersCountingRuns() (*EncoderCapabilities, map[string]int) {
	ran := make(chan string, len(encoderOrder)*2)
	caps := probeEncoders(func(ctx context.Context, args []string) (string, error) {
		for i, a := range args {
			if a == "-c:v" {
				ran <- args[i+1]
			}
		}
		return "", nil
	})
	close(ran)
	got := map[string]int{}
	for enc := range ran {
		got[enc]++
	}
	return caps, got
}

// checkOneRowPerEncoder checks that caps has a row for every registered
// encoder, in registry order, and that an unavailable one says why.
func checkOneRowPerEncoder(t *testing.T, goos string, caps *EncoderCapabilities) {
	t.Helper()
	if len(caps.Encoders) != len(encoderOrder) {
		t.Fatalf("%s: %d rows for %d encoders", goos, len(caps.Encoders), len(encoderOrder))
	}
	for i, row := range caps.Encoders {
		if row.ID != encoderOrder[i].ID {
			t.Errorf("%s: row %d is %s, want %s", goos, i, row.ID, encoderOrder[i].ID)
		}
		if !row.Available && row.Error == "" {
			t.Errorf("%s: unavailable %s has no reason", goos, row.ID)
		}
	}
}

// An encoder the operating system cannot have starts in software at once, with
// or without a capability check behind it; on macOS an unprobed VideoToolbox is
// tried, and a probed one follows its probe.
func TestFirstEncoderAttemptFollowsThePlatform(t *testing.T) {
	probed := func(id string, available bool, errText string) *EncoderCapabilities {
		return &EncoderCapabilities{Encoders: []EncoderProbeResult{
			{EncoderSpec: mustEncoder(t, id), Available: available, Error: errText},
		}}
	}
	const noVideoToolbox = "VideoToolbox is only available on macOS"
	cases := []struct {
		name, goos, encoder string
		caps                *EncoderCapabilities
		wantActive          string
		wantReason          string
	}{
		{name: "videotoolbox on linux, not probed", goos: "linux", encoder: "h264_videotoolbox", wantActive: "h264", wantReason: noVideoToolbox},
		{name: "videotoolbox on windows, not probed", goos: "windows", encoder: "h264_videotoolbox", wantActive: "h264", wantReason: noVideoToolbox},
		{name: "videotoolbox on linux, probed", goos: "linux", encoder: "h264_videotoolbox", caps: probed("h264_videotoolbox", false, noVideoToolbox), wantActive: "h264", wantReason: noVideoToolbox},
		{name: "videotoolbox on macos, not probed", goos: "darwin", encoder: "h264_videotoolbox", wantActive: "h264_videotoolbox"},
		{name: "videotoolbox on macos, probed available", goos: "darwin", encoder: "h264_videotoolbox", caps: probed("h264_videotoolbox", true, ""), wantActive: "h264_videotoolbox"},
		{name: "videotoolbox on macos, probed unavailable", goos: "darwin", encoder: "h264_videotoolbox", caps: probed("h264_videotoolbox", false, "cannot create compression session"), wantActive: "h264", wantReason: "cannot create compression session"},
		{name: "amf on macos", goos: "darwin", encoder: "h264_amf", wantActive: "h264", wantReason: "AMF is not available on macOS"},
		{name: "amf on windows, not probed", goos: "windows", encoder: "h264_amf", wantActive: "h264_amf"},
		{name: "amf on linux, not probed", goos: "linux", encoder: "h264_amf", wantActive: "h264_amf"},
		{name: "nvenc on macos is left to ffmpeg", goos: "darwin", encoder: "h264_nvenc", wantActive: "h264_nvenc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setHostOS(t, tc.goos)
			s := &Sidecar{}
			s.caps.run = fullFFmpegBuild
			s.caps.caps = tc.caps
			got := s.firstEncoderAttempt(mustEncoder(t, tc.encoder))
			// None of these has a low-power mode to flip before the fallback.
			if got.spec.ID != tc.wantActive || got.fallbackReason != tc.wantReason || got.lowPower || !got.triedLowPowerToggle {
				t.Errorf("got encoder=%s reason=%q lowPower=%v toggled=%v, want encoder=%s reason=%q",
					got.spec.ID, got.fallbackReason, got.lowPower, got.triedLowPowerToggle, tc.wantActive, tc.wantReason)
			}
		})
	}
}

// failingVideoToolboxFFmpeg installs an ffmpeg whose VideoToolbox encodes exit
// at once, as on a Mac without a hardware H.264 encoder, and whose other
// encodes keep running.
func failingVideoToolboxFFmpeg(t *testing.T) string {
	t.Helper()
	return installFakeFFmpeg(t, "case \"$*\" in *h264_videotoolbox*) echo 'Error: cannot create compression session: -12908' >&2; exit 1 ;; esac\n"+
		"exec sleep 30\n")
}

// A VideoToolbox encoder that exits during startup is replaced by libx264: one
// hardware launch (no low-power retry), then software H.264, and the reason is
// ffmpeg's. A restart at another size, which is what an automatic quality
// change sends, settles the same way.
func TestVideoToolboxStartupFailureFallsBackToSoftware(t *testing.T) {
	calls := failingVideoToolboxFFmpeg(t)
	setHostOS(t, "darwin")
	t.Setenv("VAAPI_VERIFY_MS", "2000")
	s := NewSidecar()
	defer s.Stop()

	for i, size := range [][2]int{{1920, 1080}, {1280, 720}} {
		session, err := s.StartFFmpeg(SourceRequest{Encoder: "h264_videotoolbox", Width: size[0], Height: size[1], Volume: 100})
		if err != nil {
			t.Fatal(err)
		}
		if session.Requested != "h264_videotoolbox" || session.Active != "h264" || session.Codec != codecH264 || session.Hardware || session.State != "running" {
			t.Fatalf("start %d: want a running software h264 fallback, got %+v", i+1, session)
		}
		if !strings.Contains(session.FallbackReason, "cannot create compression session") {
			t.Errorf("start %d: fallback reason must be ffmpeg's error, got %q", i+1, session.FallbackReason)
		}
		if s.currentCodec() != codecH264 {
			t.Errorf("start %d: fallback changed the codec to %s", i+1, s.currentCodec())
		}
		// Let the fallback's ffmpeg log its run before the next start stops it.
		waitForCalls(t, calls, 2*(i+1))
	}

	lines := waitForCalls(t, calls, 4)
	if len(lines) != 4 {
		t.Fatalf("want 4 ffmpeg runs, got %d:\n%s", len(lines), strings.Join(lines, "\n"))
	}
	for i, want := range []string{"-c:v h264_videotoolbox", "-c:v libx264", "-c:v h264_videotoolbox", "-c:v libx264"} {
		if !strings.Contains(lines[i], want) {
			t.Errorf("run %d: want %s:\n%s", i+1, want, lines[i])
		}
	}
	if !strings.Contains(lines[1], "s=1920x1080") || !strings.Contains(lines[3], "s=1280x720") {
		t.Errorf("each fallback must keep the size it was asked for:\n%s\n%s", lines[1], lines[3])
	}
}

// Off macOS, and on a Mac whose capability check failed, VideoToolbox is never
// launched: the stream starts on libx264 with the reason.
func TestUnavailableVideoToolboxStartsInSoftware(t *testing.T) {
	cases := []struct {
		name, goos string
		caps       *EncoderCapabilities
		wantReason string
	}{
		{name: "linux", goos: "linux", wantReason: "VideoToolbox is only available on macOS"},
		{name: "windows", goos: "windows", wantReason: "VideoToolbox is only available on macOS"},
		{
			name: "macos after a failed check", goos: "darwin",
			caps: &EncoderCapabilities{Encoders: []EncoderProbeResult{
				{EncoderSpec: mustEncoder(t, "h264_videotoolbox"), Error: "cannot create compression session"},
			}},
			wantReason: "cannot create compression session",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := failingVideoToolboxFFmpeg(t)
			setHostOS(t, tc.goos)
			s := NewSidecar()
			defer s.Stop()
			s.caps.caps = tc.caps

			session, err := s.StartFFmpeg(SourceRequest{Encoder: "h264_videotoolbox", Volume: 100})
			if err != nil {
				t.Fatal(err)
			}
			if session.Requested != "h264_videotoolbox" || session.Active != "h264" || session.Hardware || session.FallbackReason != tc.wantReason {
				t.Errorf("want software h264 with reason %q, got %+v", tc.wantReason, session)
			}
			lines := waitForCalls(t, calls, 1)
			if b, _ := os.ReadFile(calls); strings.Count(string(b), "\n") != 1 || !strings.Contains(lines[0], "-c:v libx264") || strings.Contains(lines[0], "videotoolbox") {
				t.Errorf("want one libx264 run, got:\n%s", b)
			}
		})
	}
}
