package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestSoftwareFallbackKeepsCodecFamily(t *testing.T) {
	for _, spec := range encoderOrder {
		sw := softwareEncoderFor(spec.Codec)
		if sw.Hardware {
			t.Fatalf("fallback for %s is hardware", spec.ID)
		}
		if sw.Codec != spec.Codec {
			t.Fatalf("fallback for %s changed codec %s -> %s", spec.ID, spec.Codec, sw.Codec)
		}
	}
}

func TestH264OffersConstrainedHigh(t *testing.T) {
	c := codecCapability(codecH264)
	if c.MimeType != webrtc.MimeTypeH264 {
		t.Fatalf("mime = %s", c.MimeType)
	}
	if !strings.Contains(c.SDPFmtpLine, "profile-level-id=640c") {
		t.Fatalf("H.264 must be offered as Constrained High, got %q", c.SDPFmtpLine)
	}
	if !strings.Contains(c.SDPFmtpLine, "packetization-mode=1") {
		t.Fatalf("ffmpeg sends FU-A, so packetization-mode=1 is required: %q", c.SDPFmtpLine)
	}
}

func TestEncoderArgsHardwareUsesUploadAndLowPower(t *testing.T) {
	spec, _ := lookupEncoder("h264_vaapi")
	args := strings.Join(encoderArgs(spec, "4500k", true, 0), " ")
	for _, want := range []string{"-c:v h264_vaapi", "-profile:v high", "-bf 0", "-low_power 1", "-b:v 4500k"} {
		if !strings.Contains(args, want) {
			t.Errorf("h264_vaapi args missing %q: %s", want, args)
		}
	}
	if uploadFilter(spec) != "format=nv12,hwupload" {
		t.Errorf("hardware filter = %q", uploadFilter(spec))
	}
	sw, _ := lookupEncoder("vp9")
	swArgs := strings.Join(encoderArgs(sw, "2500k", true, 0), " ")
	if strings.Contains(swArgs, "low_power") {
		t.Errorf("software encoder must not get -low_power: %s", swArgs)
	}
	if !strings.Contains(swArgs, "-strict experimental") {
		t.Errorf("VP9 RTP packetization needs -strict experimental: %s", swArgs)
	}
}

func TestEncoderArgsHonorsCpuUsed(t *testing.T) {
	spec, _ := lookupEncoder("vp8")
	args := strings.Join(encoderArgs(spec, "2500k", false, 6), " ")
	if !strings.Contains(args, "-cpu-used 6") {
		t.Fatalf("expected cpu-used 6, got %s", args)
	}
	def := strings.Join(encoderArgs(spec, "2500k", false, 0), " ")
	if !strings.Contains(def, "-cpu-used 4") {
		t.Fatalf("cpuUsed 0 should keep env/default 4, got %s", def)
	}
}

func TestH264EncoderArgsRepeatParameterSets(t *testing.T) {
	t.Setenv("VIDEO_GOP", "15")
	sw, _ := lookupEncoder("h264")
	swArgs := strings.Join(encoderArgs(sw, "2500k", false, 0), " ")
	for _, want := range []string{"-c:v libx264", "-profile:v high", "-bf 0", "-x264-params repeat-headers=1"} {
		if !strings.Contains(swArgs, want) {
			t.Errorf("libx264 args missing %q: %s", want, swArgs)
		}
	}
	amf, _ := lookupEncoder("h264_amf")
	amfArgs := strings.Join(encoderArgs(amf, "2500k", false, 0), " ")
	for _, want := range []string{"-c:v h264_amf", "-header_spacing 15", "-g 15"} {
		if !strings.Contains(amfArgs, want) {
			t.Errorf("h264_amf args missing %q: %s", want, amfArgs)
		}
	}
	// NVENC repeats SPS/PPS for RTP when global_header is off; do not invent flags.
	nv, _ := lookupEncoder("h264_nvenc")
	nvArgs := strings.Join(encoderArgs(nv, "2500k", false, 0), " ")
	if strings.Contains(nvArgs, "header_spacing") || strings.Contains(nvArgs, "repeat-headers") {
		t.Errorf("nvenc must keep its own repeat behaviour: %s", nvArgs)
	}
}

// h264_amf takes a -header_spacing of at most 1000 frames and fails to start
// on a larger one, which drops the stream to software encoding. A GOP that
// long keeps AMF running and leaves the headers to the sidecar's cache.
func TestAmfHeaderSpacingStaysWithinWhatFFmpegAccepts(t *testing.T) {
	amf, _ := lookupEncoder("h264_amf")
	cases := []struct {
		gop  string
		want string // "" for no -header_spacing at all
	}{
		{"1", "-header_spacing 1"},
		{"1000", "-header_spacing 1000"},
		{"1001", ""},
		{"3000", ""},
		{"0", ""},
	}
	for _, tc := range cases {
		t.Setenv("VIDEO_GOP", tc.gop)
		args := strings.Join(encoderArgs(amf, "2500k", false, 0), " ")
		if !strings.Contains(args, "-g "+tc.gop) {
			t.Errorf("VIDEO_GOP=%s: GOP not passed on: %s", tc.gop, args)
		}
		switch {
		case tc.want == "" && strings.Contains(args, "header_spacing"):
			t.Errorf("VIDEO_GOP=%s: header_spacing must be left out: %s", tc.gop, args)
		case tc.want != "" && !strings.Contains(args, tc.want+" "):
			t.Errorf("VIDEO_GOP=%s: args missing %q: %s", tc.gop, tc.want, args)
		}
	}
}

func TestLibvpxHoldsBitrateWithMinrate(t *testing.T) {
	for _, id := range []string{"vp8", "vp9"} {
		spec, _ := lookupEncoder(id)
		args := strings.Join(encoderArgs(spec, "5500k", false, 0), " ")
		if !strings.Contains(args, "-minrate 5500k") {
			t.Errorf("%s needs -minrate to hold its bitrate: %s", id, args)
		}
	}
	for _, id := range []string{"h264", "vp9_vaapi", "h264_vaapi", "h264_nvenc", "h264_amf"} {
		spec, _ := lookupEncoder(id)
		if args := strings.Join(encoderArgs(spec, "5500k", false, 0), " "); strings.Contains(args, "-minrate") {
			t.Errorf("%s holds -maxrate on its own and must not get -minrate: %s", id, args)
		}
	}
}

func TestBuildFFmpegArgsSoftwareKeepsVP8Contract(t *testing.T) {
	s := NewSidecar()
	s.videoPort, s.audioPort = 5000, 5002
	spec, _ := lookupEncoder("vp8")
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{
		Source: "https://example.com/live.m3u8", Width: 1920, Height: 1080, Framerate: 30, Bitrate: "4500k", Volume: 100,
	}, spec, false), " ")
	for _, want := range []string{
		"-reconnect 1", "-re -i https://example.com/live.m3u8",
		"scale=1920:1080:force_original_aspect_ratio=decrease", "format=yuv420p",
		"-c:v libvpx", "rtp://127.0.0.1:5000", "-c:a libopus", "rtp://127.0.0.1:5002",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q: %s", want, args)
		}
	}
	if strings.Contains(args, "init_hw_device") {
		t.Errorf("software encode must not open a VAAPI device: %s", args)
	}
}

func TestBuildFFmpegArgsVaapiOpensDevice(t *testing.T) {
	t.Setenv("VAAPI_DEVICE", "/dev/dri/renderD129")
	t.Setenv("VIDEO_HW_DECODE", "1")
	s := NewSidecar()
	spec, _ := lookupEncoder("h264_vaapi")
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://example.com/a.mp4", Width: 3840, Height: 2160}, spec, false), " ")
	for _, want := range []string{"-init_hw_device vaapi=va:/dev/dri/renderD129", "-filter_hw_device va", "-hwaccel vaapi", "hwupload"} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q: %s", want, args)
		}
	}
	if strings.Index(args, "-init_hw_device") > strings.Index(args, "-i https://") {
		t.Errorf("hardware init must precede the input: %s", args)
	}
}

func TestProbeSkipsHardwareWithoutDevice(t *testing.T) {
	calls := 0
	run := func(ctx context.Context, args []string) (string, error) {
		calls++
		return "", nil
	}
	spec, _ := lookupEncoder("vp8_vaapi")
	res := probeOneEncoder(spec, false, run)
	if res.Available || calls != 0 {
		t.Fatalf("expected skip without device, got available=%v calls=%d", res.Available, calls)
	}
	if res.Error == "" {
		t.Fatal("expected a reason for the unavailable hardware encoder")
	}
}

func TestProbeRetriesHardwareWithLowPower(t *testing.T) {
	t.Setenv("VAAPI_LOW_POWER", "")
	run := func(ctx context.Context, args []string) (string, error) {
		if strings.Contains(strings.Join(args, " "), "-low_power 1") {
			return "", nil
		}
		return "[h264_vaapi] No usable encoding entrypoint found for profile VAProfileH264High\n", errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264_vaapi")
	res := probeOneEncoder(spec, true, run)
	if !res.Available || !res.LowPower {
		t.Fatalf("expected low-power success, got %+v", res)
	}
}

func TestProbeReportsFailureReason(t *testing.T) {
	run := func(ctx context.Context, args []string) (string, error) {
		return "Unknown encoder 'libx264'\n", errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264")
	res := probeOneEncoder(spec, true, run)
	if res.Available || res.Error != "Unknown encoder 'libx264'" {
		t.Fatalf("unexpected result %+v", res)
	}
}

// A host without the NVIDIA runtime fails the NVENC probe while loading the
// driver; the row says so plainly and keeps ffmpeg's text as the detail.
func TestProbeNvencWithoutDriver(t *testing.T) {
	run := func(ctx context.Context, args []string) (string, error) {
		return "[h264_nvenc @ 0x564b2539c3c0] Cannot load libcuda.so.1\n" +
				"[vost#0:0/h264_nvenc @ 0x1] Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height\n",
			errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264_nvenc")
	res := probeOneEncoder(spec, false, run)
	if res.Available || res.Error != "NVIDIA GPU/runtime not present" {
		t.Fatalf("unexpected result %+v", res)
	}
	if !strings.Contains(res.Detail, "Cannot load libcuda.so.1") {
		t.Fatalf("raw ffmpeg reason should be kept as detail, got %q", res.Detail)
	}
}

// Other NVENC failures (a GPU that is present but rejects the settings) keep
// ffmpeg's own reason.
func TestProbeNvencOtherFailureKeepsReason(t *testing.T) {
	run := func(ctx context.Context, args []string) (string, error) {
		return "[h264_nvenc @ 0x1] Driver does not support the required nvenc API version\n", errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264_nvenc")
	res := probeOneEncoder(spec, false, run)
	if !strings.Contains(res.Error, "nvenc API version") || res.Detail != "" {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestSummarizeFFmpegErrorRedactsURLs(t *testing.T) {
	out := "noise\r\nhttps://user:pass@iptv.example/live/1.ts: Server returned 403 Forbidden\nError opening input files: Server returned 403 Forbidden\n"
	got := summarizeFFmpegError(out)
	if strings.Contains(got, "pass@") || strings.Contains(got, "iptv.example") {
		t.Fatalf("URL leaked into reason: %q", got)
	}
	if !strings.Contains(got, "<source> Server returned 403") || !strings.Contains(got, "Error opening input files") {
		t.Fatalf("unexpected summary: %q", got)
	}
}

// FFmpeg's default RTP packet is 1472 bytes; with SRTP added it no longer fits
// a 1500-byte MTU and is fragmented on the way to the viewer.
func TestVideoRTPPacketsFitTheMTU(t *testing.T) {
	s := NewSidecar()
	for _, key := range []string{"vp8", "vp9", "h264", "h264_vaapi", "h264_nvenc", "h264_amf"} {
		spec, ok := lookupEncoder(key)
		if !ok {
			t.Fatalf("no %s encoder", key)
		}
		args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "/data/music/clip.mp4"}, spec, false), " ")
		const want = "-f rtp -pkt_size 1200 rtp://127.0.0.1:"
		if !strings.Contains(args, want) {
			t.Errorf("%s: video output must cap the packet size (%q): %s", key, want, args)
		}
	}
}

// NVENC takes NV12 frames from system memory: no VAAPI device, no hwupload,
// and no -low_power, which only VAAPI knows.
func TestBuildFFmpegArgsNvenc(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "")
	s := NewSidecar()
	spec, ok := lookupEncoder("h264_nvenc")
	if !ok || !spec.Hardware || spec.Backend != backendNVENC || spec.Codec != codecH264 {
		t.Fatalf("h264_nvenc spec = %+v (found %v)", spec, ok)
	}
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "/data/music/clip.mp4", Width: 1920, Height: 1080, Bitrate: "4500k"}, spec, true), " ")
	for _, want := range []string{
		"-c:v h264_nvenc", "-profile:v high", "-preset p4", "-tune ll", "-rc cbr", "-zerolatency 1", "-bf 0",
		"-b:v 4500k", "-maxrate 4500k", ",format=nv12 ",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("h264_nvenc args missing %q: %s", want, args)
		}
	}
	for _, not := range []string{"hwupload", "-init_hw_device", "vaapi", "-low_power", "-hwaccel"} {
		if strings.Contains(args, not) {
			t.Errorf("h264_nvenc args must not contain %q: %s", not, args)
		}
	}
}

func TestNvencDecodesOnCudaWhenHwDecodeIsOn(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "1")
	s := NewSidecar()
	spec, _ := lookupEncoder("h264_nvenc")
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "/data/music/clip.mp4"}, spec, false), " ")
	if !strings.Contains(args, "-hwaccel cuda") {
		t.Fatalf("VIDEO_HW_DECODE=1 must decode on the GPU: %s", args)
	}
	if strings.Index(args, "-hwaccel cuda") > strings.Index(args, "-i /data/music/clip.mp4") {
		t.Errorf("-hwaccel must precede the input: %s", args)
	}
	// Frames must come back to system memory for the filter chain and NVENC.
	if strings.Contains(args, "hwaccel_output_format") {
		t.Errorf("decoded frames must stay in system memory: %s", args)
	}
}

// The VAAPI render node says nothing about NVENC: it is probed whether or not
// one is present, and once, since it has no low-power mode to retry with.
func TestProbeRunsNvencWithoutVaapiDevice(t *testing.T) {
	calls := 0
	run := func(ctx context.Context, args []string) (string, error) {
		calls++
		if strings.Contains(strings.Join(args, " "), "low_power") {
			t.Errorf("NVENC probe must not use -low_power: %v", args)
		}
		return "", nil
	}
	spec, _ := lookupEncoder("h264_nvenc")
	res := probeOneEncoder(spec, false, run)
	if !res.Available || calls != 1 {
		t.Fatalf("expected one successful probe, got available=%v calls=%d err=%q", res.Available, calls, res.Error)
	}

	calls = 0
	fail := func(ctx context.Context, args []string) (string, error) {
		calls++
		return "[h264_nvenc] Cannot load libnvidia-encode.so.1\n", errors.New("exit status 1")
	}
	res = probeOneEncoder(spec, true, fail)
	if res.Available || calls != 1 || res.Error != "NVIDIA GPU/runtime not present" || !strings.Contains(res.Detail, "libnvidia-encode") {
		t.Fatalf("expected one failed probe with its reason, got %+v after %d calls", res, calls)
	}
}

func TestHardwareEncodersNameTheirBackend(t *testing.T) {
	for _, spec := range encoderOrder {
		switch {
		case !spec.Hardware && spec.Backend != "":
			t.Errorf("software encoder %s has backend %q", spec.ID, spec.Backend)
		case spec.Hardware && spec.Backend != backendVAAPI && spec.Backend != backendNVENC && spec.Backend != backendAMF:
			t.Errorf("hardware encoder %s has backend %q", spec.ID, spec.Backend)
		}
	}
}

func TestBuildFFmpegArgsAmf(t *testing.T) {
	// AMF encoding is independent of VAAPI and VIDEO_HW_DECODE. In particular,
	// the decode flag must not enable CUDA (or Windows hardware decoding).
	t.Setenv("VAAPI_DEVICE", "/nonexistent/renderD128")
	t.Setenv("VIDEO_HW_DECODE", "1")
	t.Setenv("VIDEO_GOP", "15")
	t.Setenv("VIDEO_BUFSIZE", "")
	s := NewSidecar()
	spec, ok := lookupEncoder("h264_amf")
	if !ok || !spec.Hardware || spec.Backend != backendAMF || spec.Codec != codecH264 || spec.FFmpeg != "h264_amf" {
		t.Fatalf("h264_amf spec = %+v (found %v)", spec, ok)
	}
	if got := uploadFilter(spec); got != "format=nv12" {
		t.Fatalf("AMF filter = %q", got)
	}
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "/data/music/clip.mp4", Width: 1920, Height: 1080, Bitrate: "4500k"}, spec, true), " ")
	for _, want := range []string{
		"-c:v h264_amf", "-profile:v constrained_high", "-bf 0", "-header_spacing 15",
		",format=nv12 ", "-b:v 4500k", "-maxrate 4500k", "-bufsize 9000k", "-g 15",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("h264_amf args missing %q: %s", want, args)
		}
	}
	for _, forbidden := range []string{"hwupload", "-init_hw_device", "vaapi", "-low_power", "-hwaccel"} {
		if strings.Contains(args, forbidden) {
			t.Errorf("h264_amf args must not contain %q: %s", forbidden, args)
		}
	}
	sw := softwareEncoderFor(spec.Codec)
	if sw.ID != "h264" || sw.FFmpeg != "libx264" || sw.Hardware {
		t.Fatalf("AMF software fallback = %+v", sw)
	}
}

func TestProbeRunsAmfWithoutVaapiDevice(t *testing.T) {
	t.Setenv("VAAPI_LOW_POWER", "1")
	t.Setenv("VIDEO_HW_DECODE", "1")
	spec, _ := lookupEncoder("h264_amf")
	for _, failure := range []string{"", "Unknown encoder 'h264_amf'", "[h264_amf] AMF initialization failed"} {
		t.Run(failure, func(t *testing.T) {
			calls := 0
			run := func(ctx context.Context, args []string) (string, error) {
				calls++
				joined := strings.Join(args, " ")
				for _, want := range []string{"-f lavfi", "-frames:v 3", "-vf format=nv12", "-c:v h264_amf", "-profile:v constrained_high", "-bf 0"} {
					if !strings.Contains(joined, want) {
						t.Errorf("AMF probe missing %q: %s", want, joined)
					}
				}
				for _, forbidden := range []string{"hwupload", "-init_hw_device", "vaapi", "-low_power", "-hwaccel"} {
					if strings.Contains(joined, forbidden) {
						t.Errorf("AMF probe contains %q: %s", forbidden, joined)
					}
				}
				if failure != "" {
					return failure + "\n", errors.New("exit status 1")
				}
				return "", nil
			}
			res := probeOneEncoder(spec, false, run)
			if calls != 1 || len(res.Attempts) != 1 || res.LowPower || res.Skipped != "" {
				t.Fatalf("expected one AMF probe without VAAPI, got %+v after %d calls", res, calls)
			}
			if res.Available != (failure == "") || res.Error != failure || res.Attempts[0].Output != failure {
				t.Fatalf("AMF availability/failure diagnostics = %+v", res)
			}
		})
	}
}

// Every probe that runs ffmpeg reports each attempt's command, exit and output,
// passing or failing, so the UI can show them for every encoder row.
func TestProbeRecordsEachAttempt(t *testing.T) {
	t.Setenv("VAAPI_LOW_POWER", "")
	run := func(ctx context.Context, args []string) (string, error) {
		if strings.Contains(strings.Join(args, " "), "-low_power 1") {
			return "", nil
		}
		return "[h264_vaapi] No usable encoding entrypoint found\n", errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264_vaapi")
	res := probeOneEncoder(spec, true, run)
	if len(res.Attempts) != 2 {
		t.Fatalf("expected two attempts, got %+v", res.Attempts)
	}
	first, second := res.Attempts[0], res.Attempts[1]
	if first.OK || first.Result != "exit status 1" || !strings.Contains(first.Output, "No usable encoding entrypoint") {
		t.Fatalf("unexpected failed attempt %+v", first)
	}
	if !second.OK || !second.LowPower || second.Result != "exit 0" || second.Output != "" {
		t.Fatalf("unexpected passing attempt %+v", second)
	}
	if !strings.Contains(first.Command, "-c:v h264_vaapi") {
		t.Fatalf("command should name the encoder, got %q", first.Command)
	}
}

func TestProbeSoftwareSuccessRecordsAttempt(t *testing.T) {
	run := func(ctx context.Context, args []string) (string, error) { return "", nil }
	spec, _ := lookupEncoder("vp8")
	res := probeOneEncoder(spec, true, run)
	if !res.Available || len(res.Attempts) != 1 || !res.Attempts[0].OK {
		t.Fatalf("unexpected result %+v", res)
	}
	if !strings.Contains(res.Attempts[0].Command, "-c:v libvpx") {
		t.Fatalf("command should name the encoder, got %q", res.Attempts[0].Command)
	}
}

func TestProbeSkippedHasNoAttempts(t *testing.T) {
	run := func(ctx context.Context, args []string) (string, error) { return "", nil }
	spec, _ := lookupEncoder("vp9_vaapi")
	res := probeOneEncoder(spec, false, run)
	if len(res.Attempts) != 0 {
		t.Fatalf("skipped probe should not report attempts, got %+v", res.Attempts)
	}
	if !strings.Contains(res.Skipped, "not present") {
		t.Fatalf("skipped probe should say why, got %q", res.Skipped)
	}
}

func TestProbeCommandLineQuotes(t *testing.T) {
	t.Setenv("FFMPEG_PATH", "ffmpeg")
	got := probeCommandLine([]string{"-vf", "format=nv12,hwupload", "-f", "null", "-", "it's here"})
	want := `ffmpeg -vf format=nv12,hwupload -f null - 'it'\''s here'`
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// With VIDEO_HW_DECODE=1 the decoded frames stay on the GPU: the decoder
// hands VAAPI surfaces to the filters, which scale them there, so there is no
// copy back to system memory and upload again.
func TestVaapiDecodedFramesStayOnTheGPU(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "1")
	t.Setenv("VIDEO_GPU_FILTERS", "") // the default: on
	s := NewSidecar()
	spec, _ := lookupEncoder("h264_vaapi")
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://example.com/v.webm", AudioSource: "https://example.com/a.webm", Width: 1920, Height: 1080, Framerate: 30}, spec, false), " ")

	if !strings.Contains(args, "-hwaccel_output_format vaapi -hwaccel vaapi -hwaccel_device va") {
		t.Errorf("the decoder must hand VAAPI surfaces to the filters: %s", args)
	}
	if strings.Index(args, "-hwaccel_output_format") > strings.Index(args, "-i https://example.com/v.webm") {
		t.Errorf("GPU decoding must apply to the video input: %s", args)
	}
	for _, want := range []string{"fps=30,format=nv12|vaapi,hwupload,scale_vaapi=w=1920:h=1080", "force_original_aspect_ratio=decrease", "force_divisible_by=2"} {
		if !strings.Contains(args, want) {
			t.Errorf("GPU filter chain lacks %q: %s", want, args)
		}
	}
	// Nothing in the chain may need CPU frames, or ffmpeg would copy back.
	for _, cpuOnly := range []string{" scale=", ",scale=", "pad="} {
		if strings.Contains(args, cpuOnly) {
			t.Errorf("GPU filter chain has the CPU filter %q: %s", cpuOnly, args)
		}
	}
}

// Without GPU decoding there are no GPU frames to keep: the default
// (VIDEO_HW_DECODE unset) keeps the CPU chain, so do other backends, and
// VIDEO_GPU_FILTERS=0 turns it off.
func TestFramesStayOnTheGPUOnlyWithVaapiDecoding(t *testing.T) {
	vaapi, _ := lookupEncoder("h264_vaapi")
	nvenc, _ := lookupEncoder("h264_nvenc")
	sw, _ := lookupEncoder("h264")

	t.Setenv("VIDEO_GPU_FILTERS", "") // the default: on
	t.Setenv("VIDEO_HW_DECODE", "")
	if framesStayOnGPU(vaapi, true) {
		t.Error("without VIDEO_HW_DECODE=1 the source is decoded on the CPU")
	}
	s := NewSidecar()
	if args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://example.com/a.mp4"}, vaapi, false), " "); strings.Contains(args, "scale_vaapi") || strings.Contains(args, "hwaccel_output_format") {
		t.Errorf("default VAAPI streams keep the CPU chain: %s", args)
	}

	t.Setenv("VIDEO_HW_DECODE", "1")
	if !framesStayOnGPU(vaapi, true) {
		t.Error("VAAPI decoding should keep its frames on the GPU")
	}
	if framesStayOnGPU(vaapi, false) {
		t.Error("no source to decode, no GPU frames")
	}
	for _, spec := range []EncoderSpec{nvenc, sw} {
		if framesStayOnGPU(spec, true) {
			t.Errorf("%s keeps the CPU chain", spec.ID)
		}
	}

	t.Setenv("VIDEO_GPU_FILTERS", "0")
	if framesStayOnGPU(vaapi, true) {
		t.Error("VIDEO_GPU_FILTERS=0 must copy the frames back")
	}
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://example.com/a.mp4"}, vaapi, false), " ")
	if strings.Contains(args, "hwaccel_output_format") || !strings.Contains(args, "format=nv12,hwupload") {
		t.Errorf("VIDEO_GPU_FILTERS=0 must keep the CPU chain: %s", args)
	}
}
