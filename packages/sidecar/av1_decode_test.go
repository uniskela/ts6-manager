package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A runner that answers every test decode the same way and counts them.
func av1Runner(out string, err error, calls *int32) probeRunner {
	return func(ctx context.Context, args []string) (string, error) {
		atomic.AddInt32(calls, 1)
		return out, err
	}
}

func TestAV1ProbeSampleIsAV1(t *testing.T) {
	// An IVF file: "DKIF" header, fourcc AV01.
	if len(av1ProbeSample) < 32 || string(av1ProbeSample[:4]) != "DKIF" || string(av1ProbeSample[8:12]) != "AV01" {
		t.Fatalf("av1_probe.ivf is not an AV1 IVF file (%d bytes)", len(av1ProbeSample))
	}
}

func TestAV1ProbeArgsUseTheNativeDecoderOnTheGPU(t *testing.T) {
	got := strings.Join(av1ProbeArgs(hwaccelVAAPI, "/dev/dri/renderD128", "/tmp/s.ivf"), " ")
	for _, want := range []string{"-xerror", "-init_hw_device vaapi=va:/dev/dri/renderD128 -hwaccel vaapi -hwaccel_device va -c:v av1 -i /tmp/s.ivf"} {
		if !strings.Contains(got, want) {
			t.Errorf("VAAPI test decode lacks %q: %s", want, got)
		}
	}
	got = strings.Join(av1ProbeArgs(hwaccelCUDA, "", "/tmp/s.ivf"), " ")
	if !strings.Contains(got, "-hwaccel cuda -c:v av1 -i /tmp/s.ivf") || strings.Contains(got, "vaapi") {
		t.Errorf("CUDA test decode: %s", got)
	}
}

func TestAV1ProbeResults(t *testing.T) {
	cases := []struct {
		name      string
		out       string
		err       error
		available bool
		reason    string
	}{
		{name: "decodes", available: true},
		{name: "no AV1 on this GPU", out: "Your platform doesn't support hardware accelerated AV1 decoding.\n", err: errors.New("exit status 1"),
			reason: "Your platform doesn't support hardware accelerated AV1 decoding."},
		{name: "driver crash", out: "[av1 @ 0x1] internal decoding error\n", err: errors.New("signal: segmentation fault"),
			reason: "signal: segmentation fault"},
		{name: "failed frames with a clean exit", out: "[av1 @ 0x1] internal decoding error\n", reason: "internal decoding error"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var calls int32
			r := runAV1DecodeProbe(av1Runner(c.out, c.err, &calls), hwaccelCUDA, "")
			if r.Available != c.available || !strings.Contains(r.Error, c.reason) {
				t.Errorf("want available=%v with %q, got %+v", c.available, c.reason, r)
			}
			if !strings.Contains(r.Command, "-c:v av1") {
				t.Errorf("the command run is reported: %q", r.Command)
			}
		})
	}
}

// Regression: Debian's free Intel driver lists AV1 decoding, fails every
// frame, and FFmpeg can then crash. A real crashing process must count as
// unsupported.
func TestAV1ProbeCountsACrashAsUnsupported(t *testing.T) {
	installFakeFFmpeg(t, "echo '[av1 @ 0x55] internal decoding error' >&2\nkill -SEGV $$\n")
	r := runAV1DecodeProbe(runFFmpegProbe, hwaccelCUDA, "")
	if r.Available {
		t.Fatalf("a crashed test decode must not count as AV1 decoding: %+v", r)
	}
	if !strings.Contains(r.Error, "segmentation fault") || !strings.Contains(r.Error, "internal decoding error") {
		t.Errorf("the reason must say what happened: %q", r.Error)
	}
}

func TestAV1ProbeNeedsTheVaapiDevice(t *testing.T) {
	vaapiDevice(t, false)
	var calls int32
	r := runAV1DecodeProbe(av1Runner("", nil, &calls), hwaccelVAAPI, getVaapiDevice())
	if r.Available || calls != 0 || !strings.Contains(r.Error, "not present") {
		t.Errorf("no device, no test decode: %+v (%d runs)", r, calls)
	}
}

func TestAV1ProbeIsCachedPerGPU(t *testing.T) {
	var calls int32
	c := &av1DecodeCache{}
	run := av1Runner("", nil, &calls)
	c.get(run, hwaccelCUDA, "", false)
	c.get(run, hwaccelCUDA, "", false)
	if calls != 1 {
		t.Errorf("one test decode per GPU, got %d", calls)
	}
	vaapiDevice(t, true)
	c.get(run, hwaccelVAAPI, getVaapiDevice(), false)
	if calls != 2 {
		t.Errorf("another GPU is tested on its own, got %d runs", calls)
	}
	c.get(run, hwaccelCUDA, "", true)
	if calls != 3 {
		t.Errorf("refresh tests again, got %d runs", calls)
	}
}

// The capability report tests AV1 on the GPUs it found: CUDA when NVENC
// works, VAAPI when its device is present.
func TestCapabilitiesReportAV1Decoding(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "1")
	vaapiDevice(t, false)
	var calls int32
	c := &capabilityCache{run: av1Runner("", nil, &calls)}
	caps := c.get(false)
	if !caps.AV1HwDecode || len(caps.AV1Decode) != 1 || caps.AV1Decode[0].Hwaccel != hwaccelCUDA {
		t.Errorf("NVENC works, so AV1 is tested on CUDA: %+v", caps.AV1Decode)
	}

	c = &capabilityCache{run: av1Runner("Cannot load libcuda.so.1", errors.New("exit status 1"), &calls)}
	caps = c.get(false)
	if caps.AV1HwDecode || len(caps.AV1Decode) != 0 {
		t.Errorf("no GPU, no AV1 test decode: %+v", caps.AV1Decode)
	}
}

func TestVideoCodecIsValidated(t *testing.T) {
	for _, ok := range []string{"", "av1", "vp9", "h264"} {
		if err := validVideoCodec(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"AV1", "av01.0.08M.08", "-c:v", "hevc"} {
		if validVideoCodec(bad) == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
}

// stubLocalCodec answers the local file probe with codec (video stream 0)
// and counts it.
func stubLocalCodec(t *testing.T, codec string) *int32 {
	t.Helper()
	var calls int32
	prev := localVideo
	localVideo = func(string) sourceVideo { atomic.AddInt32(&calls, 1); return sourceVideo{codec: codec} }
	t.Cleanup(func() { localVideo = prev })
	return &calls
}

func TestParseProbedVideo(t *testing.T) {
	for out, want := range map[string]sourceVideo{
		"0,av1\n":  {codec: "av1", stream: 0},
		"1,av1\n":  {codec: "av1", stream: 1},
		"2,vp9":    {codec: "vp9", stream: 2},
		"":         {},
		"av1\n":    {},
		"x,av1\n":  {},
		"-1,av1\n": {},
	} {
		if got := parseProbedVideo(out); got != want {
			t.Errorf("%q: want %+v, got %+v", out, want, got)
		}
	}
}

// Only the video stream's decode errors count: the file's own audio failing
// must not take the GPU decoder away.
func TestAV1DecodeFailedMatchesTheVideoStreamOnly(t *testing.T) {
	audio := &tailBuffer{}
	_, _ = audio.Write([]byte("Error while decoding stream #0:1: Invalid data found when processing input\n"))
	if av1DecodeFailed(audio, 0) {
		t.Error("an audio decode error (stream #0:1) is not the video failing")
	}
	if !av1DecodeFailed(audio, 1) {
		t.Error("with the video as stream 1, its errors count")
	}
	video10 := &tailBuffer{}
	_, _ = video10.Write([]byte("Error while decoding stream #0:10: Invalid data found when processing input\n"))
	if av1DecodeFailed(video10, 1) {
		t.Error("stream #0:10 is not stream #0:1")
	}
}

func TestAV1GPUDecoderDecision(t *testing.T) {
	vaapiDevice(t, true)
	const remote = "https://example.com/v.webm"
	const local = "/data/music/videos/v.webm"
	cases := []struct {
		name        string
		encoder     string
		hwDecode    string
		source      string
		videoCodec  string
		localCodec  string
		probeOK     bool
		wantHwaccel string
		wantAV1     bool
		wantFFprobe bool
	}{
		{name: "vaapi, AV1 named by the backend", encoder: "h264_vaapi", hwDecode: "1", source: remote, videoCodec: "av1", probeOK: true, wantHwaccel: "vaapi", wantAV1: true},
		{name: "nvenc decodes on cuda", encoder: "h264_nvenc", hwDecode: "1", source: remote, videoCodec: "av1", probeOK: true, wantHwaccel: "cuda", wantAV1: true},
		{name: "local AV1 file", encoder: "h264_vaapi", hwDecode: "1", source: local, localCodec: "av1", probeOK: true, wantHwaccel: "vaapi", wantAV1: true, wantFFprobe: true},
		{name: "test decode failed", encoder: "h264_vaapi", hwDecode: "1", source: remote, videoCodec: "av1", wantAV1: true},
		{name: "VP9 source", encoder: "h264_vaapi", hwDecode: "1", source: remote, videoCodec: "vp9", probeOK: true},
		{name: "local VP9 file", encoder: "h264_vaapi", hwDecode: "1", source: local, localCodec: "vp9", probeOK: true, wantFFprobe: true},
		{name: "remote source of unknown codec is not probed", encoder: "h264_vaapi", hwDecode: "1", source: remote, probeOK: true},
		{name: "decoding on the CPU", encoder: "h264_vaapi", source: remote, videoCodec: "av1", probeOK: true},
		{name: "software encoder", encoder: "h264", hwDecode: "1", source: local, localCodec: "av1", probeOK: true},
		{name: "amf has no GPU decoding", encoder: "h264_amf", hwDecode: "1", source: local, localCodec: "av1", probeOK: true},
		{name: "videotoolbox has no GPU decoding", encoder: "h264_videotoolbox", hwDecode: "1", source: local, localCodec: "av1", probeOK: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("VIDEO_HW_DECODE", c.hwDecode)
			ffprobes := stubLocalCodec(t, c.localCodec)
			var probes int32
			out, err := "", error(nil)
			if !c.probeOK {
				out, err = "Your platform doesn't support hardware accelerated AV1 decoding.", errors.New("exit status 1")
			}
			s := NewSidecar()
			s.caps.run = av1Runner(out, err, &probes)
			hwaccel, isAV1, _ := s.av1GPUDecoder(SourceRequest{Source: c.source, VideoCodec: c.videoCodec}, mustEncoder(t, c.encoder))
			if hwaccel != c.wantHwaccel || isAV1 != c.wantAV1 {
				t.Errorf("want (%q, %v), got (%q, %v)", c.wantHwaccel, c.wantAV1, hwaccel, isAV1)
			}
			if (*ffprobes > 0) != c.wantFFprobe {
				t.Errorf("local codec probe run %d times, want it: %v", *ffprobes, c.wantFFprobe)
			}
			if probes > 0 && !c.wantAV1 {
				t.Errorf("no AV1 test decode for a stream that cannot use it (%d runs)", probes)
			}
		})
	}
}

// FFmpeg's own AV1 decoder goes on the video input only, next to the GPU
// decoding, and only for a hardware encoder decoding on the GPU.
func TestAV1DecoderIsForcedOnTheVideoInputOnly(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "1")
	s := NewSidecar()
	req := SourceRequest{Source: "https://example.com/v.webm", AudioSource: "https://example.com/a.webm", Volume: 100, av1Hwaccel: hwaccelVAAPI}

	got := strings.Join(s.buildFFmpegArgs(req, mustEncoder(t, "h264_vaapi"), false), " ")
	if strings.Count(got, "-c:v av1") != 1 {
		t.Fatalf("one forced AV1 decoder, got: %s", got)
	}
	video := strings.Index(got, "-i https://example.com/v.webm")
	audio := strings.Index(got, "-i https://example.com/a.webm")
	forced := strings.Index(got, "-c:v av1")
	if !(strings.Index(got, "-hwaccel vaapi") < forced && forced < video && video < audio) {
		t.Errorf("the AV1 decoder must belong to the video input: %s", got)
	}

	if got := strings.Join(s.buildFFmpegArgs(req, mustEncoder(t, "h264"), false), " "); strings.Contains(got, "-c:v av1") {
		t.Errorf("a software encode decodes on the CPU: %s", got)
	}
	t.Setenv("VIDEO_HW_DECODE", "")
	if got := strings.Join(s.buildFFmpegArgs(req, mustEncoder(t, "h264_vaapi"), false), " "); strings.Contains(got, "-c:v av1") {
		t.Errorf("without VIDEO_HW_DECODE=1 nothing decodes on the GPU: %s", got)
	}
}

// A forced AV1 decoder that fails is dropped first, on the same encoder; only
// a failure after that falls back the encoder.
func TestAfterHardwareFailureDropsTheAV1DecoderFirst(t *testing.T) {
	a := encoderAttempt{spec: mustEncoder(t, "h264_vaapi"), av1Hwaccel: hwaccelVAAPI, av1Source: true}
	a = a.afterHardwareFailure("Failed to get HW surface format")
	if a.av1Hwaccel != "" || a.spec.ID != "h264_vaapi" || a.triedLowPowerToggle || a.decoderFallbackReason != "Failed to get HW surface format" {
		t.Errorf("first failure: back to libdav1d on the same encoder, got %+v", a)
	}
	a.av1SoftwareDecoder = "libdav1d"
	if decoderLabel(a) != "libdav1d" {
		t.Errorf("decoder label: %q", decoderLabel(a))
	}
	a = a.afterHardwareFailure("again")
	if !a.triedLowPowerToggle || a.spec.ID != "h264_vaapi" {
		t.Errorf("then the encoder's own fallback: %+v", a)
	}
}

// End to end with a fake ffmpeg: the test decode passes, but this source
// fails with FFmpeg's AV1 decoder (another profile, say). The stream starts
// again on libdav1d with the same hardware encoder, and says so.
func TestAV1SourceFallsBackToLibdav1d(t *testing.T) {
	calls := installFakeFFmpeg(t, "case \"$*\" in\n"+
		"*av1-probe*) exit 0 ;;\n"+
		"*'-c:v av1 '*) echo \"Your platform doesn't support hardware accelerated AV1 decoding.\" >&2; exit 1 ;;\n"+
		"esac\nexec sleep 30\n")
	t.Setenv("VIDEO_HW_DECODE", "1")
	t.Setenv("VAAPI_VERIFY_MS", "300")
	s := NewSidecar()
	defer s.Stop()

	session, err := s.StartFFmpeg(SourceRequest{Source: "https://example.com/v.webm", VideoCodec: "av1", Encoder: "h264_nvenc", Volume: 100})
	if err != nil {
		t.Fatal(err)
	}
	if session.Active != "h264_nvenc" || session.FallbackReason != "" {
		t.Errorf("the encoder is not at fault: %+v", session)
	}
	if session.Decoder != "libdav1d" || !strings.Contains(session.DecoderFallbackReason, "hardware accelerated AV1") {
		t.Errorf("the stream state must show the decoder fallback: %+v", session)
	}

	var runs []string
	for _, l := range waitForCalls(t, calls, 3) {
		if !strings.Contains(l, "av1-probe") {
			runs = append(runs, l)
		}
	}
	if len(runs) != 2 || !strings.Contains(runs[0], "-hwaccel cuda") || !strings.Contains(runs[0], "-c:v av1 -i https://example.com/v.webm") || strings.Contains(runs[1], "-c:v av1 ") || !strings.Contains(runs[1], "h264_nvenc") {
		t.Errorf("want one run with the AV1 decoder, then one without on NVENC:\n%s", strings.Join(runs, "\n"))
	}
}

// With a real ffmpeg (no GPU in CI): the sample is valid AV1, and the test
// decode on a GPU that is not there fails cleanly.
func TestFFmpegAV1ProbeSample(t *testing.T) {
	if os.Getenv("SIDECAR_FFMPEG_IT") != "1" {
		t.Skip("set SIDECAR_FFMPEG_IT=1 to run against a real ffmpeg")
	}
	sample, err := writeAV1ProbeSample()
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(sample)
	out, err := exec.Command(getFfmpegPath(), "-hide_banner", "-v", "error", "-xerror", "-i", sample, "-f", "null", "-").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "" {
		t.Fatalf("the sample must decode with FFmpeg's default AV1 decoder: %v %s", err, out)
	}
	if v := probeLocalVideo(sample); v.codec != "av1" || v.stream != 0 {
		t.Errorf("ffprobe reads the sample as %+v", v)
	}

	t.Setenv("VAAPI_DEVICE", "/nonexistent/renderD128")
	if r := runAV1DecodeProbe(runFFmpegProbe, hwaccelCUDA, ""); r.Available {
		t.Logf("CUDA decodes AV1 on this host: %+v", r)
	} else {
		t.Logf("no AV1 decoding on CUDA here: %s", r.Error)
	}
	if r := runAV1DecodeProbe(runFFmpegProbe, hwaccelVAAPI, getVaapiDevice()); r.Available {
		t.Errorf("no VAAPI device, no AV1 decoding: %+v", r)
	}
}

// installAV1FailingFFmpeg installs an ffmpeg whose AV1 test decode passes and
// whose stream with the forced AV1 decoder fails every frame of the video
// stream, as NVDEC does with AV1 4:4:4. Without the forced decoder it
// streams. With gate, the failure waits until the test calls release, so
// the test decides whether it comes inside or after the startup check. With
// exit, ffmpeg stops after the error instead of running on.
func installAV1FailingFFmpeg(t *testing.T, gate, exit bool) (calls string, release func()) {
	t.Helper()
	wait := ""
	if gate {
		wait = "while [ ! -f \"${0%/*}/gate\" ]; do sleep 0.02; done; "
	}
	after := "exec sleep 30"
	if exit {
		after = "exit 1"
	}
	calls = installFakeFFmpeg(t, "case \"$*\" in\n"+
		"*av1-probe*) exit 0 ;;\n"+
		"*'-c:v av1 '*) "+wait+"echo 'Error while decoding stream #0:0: Invalid data found when processing input' >&2; "+after+" ;;\n"+
		"esac\nexec sleep 30\n")
	release = func() {
		gateFile := filepath.Join(filepath.Dir(os.Getenv("FFMPEG_PATH")), "gate")
		if err := os.WriteFile(gateFile, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return calls, release
}

func streamRuns(t *testing.T, calls string, n int) []string {
	t.Helper()
	var runs []string
	for _, l := range waitForCalls(t, calls, n+1) {
		if !strings.Contains(l, "av1-probe") {
			runs = append(runs, l)
		}
	}
	return runs
}

// Failed frames inside the startup check count like an exit: the stream
// starts again on libdav1d before StartFFmpeg answers.
func TestAV1DecodeErrorsAtStartupFallBackToLibdav1d(t *testing.T) {
	calls, _ := installAV1FailingFFmpeg(t, false, false)
	t.Setenv("VIDEO_HW_DECODE", "1")
	t.Setenv("VAAPI_VERIFY_MS", "500")
	s := NewSidecar()
	defer s.Stop()

	session, err := s.StartFFmpeg(SourceRequest{Source: "https://example.com/v.webm", VideoCodec: "av1", Encoder: "h264_nvenc", Volume: 100})
	if err != nil {
		t.Fatal(err)
	}
	if session.Active != "h264_nvenc" || session.Decoder != "libdav1d" || !strings.Contains(session.DecoderFallbackReason, "Invalid data") {
		t.Errorf("want NVENC on libdav1d with the decode error as the reason: %+v", session)
	}
	runs := streamRuns(t, calls, 2)
	if len(runs) != 2 || !strings.Contains(runs[0], "-c:v av1 ") || strings.Contains(runs[1], "-c:v av1 ") {
		t.Errorf("want one run with the AV1 decoder, then one without:\n%s", strings.Join(runs, "\n"))
	}
}

// Failed frames after the startup check (a remote source that is slow to
// open) restart the stream on libdav1d too, and the session says so.
func TestLateAV1DecodeErrorsRestartOnLibdav1d(t *testing.T) {
	calls, release := installAV1FailingFFmpeg(t, true, false)
	t.Setenv("VIDEO_HW_DECODE", "1")
	t.Setenv("VAAPI_VERIFY_MS", "200")
	s := NewSidecar()
	defer s.Stop()

	session, err := s.StartFFmpeg(SourceRequest{Source: "https://example.com/v.webm", VideoCodec: "av1", Encoder: "h264_nvenc", Volume: 100})
	if err != nil {
		t.Fatal(err)
	}
	if session.Decoder != "av1 (cuda)" {
		t.Fatalf("the startup check passed on the GPU decoder: %+v", session)
	}
	release()
	runs := streamRuns(t, calls, 2)
	if len(runs) != 2 || strings.Contains(runs[1], "-c:v av1 ") || !strings.Contains(runs[1], "h264_nvenc") {
		t.Errorf("want a second run on libdav1d with NVENC:\n%s", strings.Join(runs, "\n"))
	}
	deadline := time.Now().Add(3 * time.Second)
	for s.encoderSession().Decoder != "libdav1d" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := s.encoderSession(); got.Decoder != "libdav1d" || !strings.Contains(got.DecoderFallbackReason, "Invalid data") {
		t.Errorf("the session must report the fallback: %+v", got)
	}
	time.Sleep(500 * time.Millisecond)
	if runs := streamRuns(t, calls, 2); len(runs) != 2 {
		t.Errorf("libdav1d is not retried on the GPU:\n%s", strings.Join(runs, "\n"))
	}
}

// Fatal-exit, EOF, cancellation and watcher scheduling are covered without
// sleeps in av1_lifecycle_test.go.
